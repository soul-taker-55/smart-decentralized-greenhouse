/**
 * SDIGF backend — config profile service.
 *
 * THE APPLICATION SERVICE LAYER. Hard rule 1: commands never flow dashboard →
 * database directly. Routes call this module; this module is the only thing that
 * writes to config_profiles, and every write it makes also writes server_events.
 *
 * ─── LIFECYCLE ─────────────────────────────────────────────────────────────
 *
 *   DRAFT ──► PROPOSED ──► PARTIALLY_APPROVED ──► APPROVED ──► ACTIVE
 *               │                  │                 │
 *               └──► REJECTED ◄────┘                 └──► SUPERSEDED (when a
 *               └──► EXPIRED                               newer one activates)
 *
 * PARTIALLY_APPROVED is reachable only in 05b, when M-of-N counting exists. In
 * 05a `approve` moves PROPOSED straight to APPROVED and records that it did so
 * without signatures — see the stub notice on that function.
 *
 * NOTHING PUBLISHES TO MQTT BEFORE APPROVED. This module does not publish at all;
 * publication is the caller's job after activate() succeeds, which keeps the
 * transaction boundary and the network boundary from being entangled.
 *
 * ─── THE 05b SEAM ──────────────────────────────────────────────────────────
 *
 * Every function takes an optional `actor` ({ id, role }). In 05a it is null and
 * lands as NULL in created_by / actor_id / actor_role. In 05b the RBAC layer
 * fills it in. No signature changes, no migration.
 */

import { randomUUID } from 'node:crypto';
import { buildSignedContent } from '../canon.js';
import { assertValidConfig, incompleteFields } from '../config-schema.js';
import { query, transaction } from '../db.js';
import { config } from '../config.js';
import { appendToLedger } from './ledger-service.js';

/** Raised when a lifecycle transition is not permitted from the current state. */
export class LifecycleError extends Error {
  constructor(message, { from, to, id } = {}) {
    super(message);
    this.name = 'LifecycleError';
    this.from = from;
    this.to = to;
    this.id = id;
  }
}

/** Raised when a profile id does not exist. */
export class NotFoundError extends Error {
  constructor(id) {
    super(`config profile ${id} not found`);
    this.name = 'NotFoundError';
    this.id = id;
  }
}

/**
 * Permitted transitions. Encoded as data so the rule is inspectable rather than
 * scattered through if-statements, and so 05b can extend it without hunting.
 */
const TRANSITIONS = {
  DRAFT: ['PROPOSED', 'REJECTED'],
  PROPOSED: ['PARTIALLY_APPROVED', 'APPROVED', 'REJECTED', 'EXPIRED'],
  PARTIALLY_APPROVED: ['APPROVED', 'REJECTED', 'EXPIRED'],
  APPROVED: ['ACTIVE', 'SUPERSEDED', 'EXPIRED'],
  ACTIVE: ['SUPERSEDED'],
  REJECTED: [],
  EXPIRED: [],
  SUPERSEDED: [],
};

function assertTransition(from, to, id) {
  const allowed = TRANSITIONS[from];
  if (!allowed) throw new LifecycleError(`unknown status "${from}"`, { from, to, id });
  if (!allowed.includes(to)) {
    throw new LifecycleError(
      `cannot move config ${id} from ${from} to ${to}` +
        (allowed.length ? ` — permitted: ${allowed.join(', ')}` : ' — it is in a terminal state'),
      { from, to, id }
    );
  }
}

/**
 * Record a structured event. Called inside the same transaction as the change it
 * describes, so an event without its change (or the reverse) is not possible.
 *
 * PHASE 07: the event is also chained here, in the SAME transaction, STRICTLY.
 * If the ledger append throws, the caller's whole transaction rolls back and the
 * config change does not happen. That is intended: for configuration lifecycle
 * events the audit trail IS the product, and a silently unaudited config change
 * is worse than a failed one.
 *
 * This one function covers five event types — every caller already passes a
 * transaction client, so there is exactly one place to chain them.
 */
async function recordEvent(client, { eventType, refId, actor, detail, refTable = 'config_profiles' }) {
  const inserted = await client.query(
    `INSERT INTO server_events (gh_id, event_type, ref_table, ref_id, actor_id, actor_role, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      config.ghId,
      eventType,
      refTable,
      refId,
      actor?.id ?? null,
      actor?.role ?? null,
      detail ? JSON.stringify(detail) : null,
    ]
  );

  await appendToLedger(client, inserted.rows[0].id);
}

function rowToProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    ghId: row.gh_id,
    ver: row.ver,
    name: row.name,
    cfg: row.cfg,
    cfgCanonical: row.cfg_canonical,
    cfgHash: row.cfg_hash,
    status: row.status,
    parentId: row.parent_id,
    ttlExpiresAt: row.ttl_expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    /** Derived, not stored — a config with nulls is valid but not runnable. */
    incomplete: incompleteFields(row.cfg),
  };
}

/**
 * Create a config profile.
 *
 * Validates, canonicalizes, hashes, and assigns the next version — in that order,
 * inside one transaction. The canonical string and hash are computed HERE and
 * stored, never recomputed on read: cfg_canonical exists precisely so that one
 * byte sequence is the single source of truth for what was hashed and signed.
 *
 * @param {object} cfg - contract §4 shape
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {number} [opts.parentId] - profile this was derived from
 * @param {{id: string, role: string}} [opts.actor] - null in 05a
 * @returns {Promise<object>} the created profile
 */
export async function createProfile(cfg, { name = null, parentId = null, actor = null } = {}) {
  // Throws ValidationError listing every bad field, not just the first.
  assertValidConfig(cfg);

  return transaction(async (client) => {
    // Serialise version assignment per greenhouse. Without this, two concurrent
    // creates can read the same MAX(ver) and one loses to the UNIQUE(gh_id, ver)
    // constraint. An advisory lock scoped to the transaction is cheaper than
    // locking the table and releases automatically on commit or rollback.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [config.ghId]);

    const verResult = await client.query(
      `SELECT COALESCE(MAX(ver), 0) + 1 AS next FROM config_profiles WHERE gh_id = $1`,
      [config.ghId]
    );
    const ver = verResult.rows[0].next;

    const { cfgCanonical, cfgHash } = buildSignedContent(cfg, config.ghId, ver);

    const inserted = await client.query(
      `INSERT INTO config_profiles
         (gh_id, ver, name, cfg, cfg_canonical, cfg_hash, status, parent_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'DRAFT', $7, $8)
       RETURNING *`,
      [
        config.ghId,
        ver,
        name,
        JSON.stringify(cfg),
        cfgCanonical,
        cfgHash,
        parentId,
        actor?.id ?? null,
      ]
    );

    const profile = rowToProfile(inserted.rows[0]);

    await recordEvent(client, {
      eventType: 'CONFIG_CREATED',
      refId: profile.id,
      actor,
      detail: { ver, cfgHash, name, parentId, incomplete: profile.incomplete },
    });

    return profile;
  });
}

/** List profiles, newest first. */
export async function listProfiles({ status = null, limit = 50 } = {}) {
  const params = [config.ghId];
  let sql = `SELECT * FROM config_profiles WHERE gh_id = $1`;
  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY ver DESC LIMIT $${params.length}`;
  const r = await query(sql, params);
  return r.rows.map(rowToProfile);
}

/** Fetch one profile by id. Throws NotFoundError. */
export async function getProfile(id) {
  const r = await query(`SELECT * FROM config_profiles WHERE id = $1 AND gh_id = $2`, [
    id,
    config.ghId,
  ]);
  if (r.rows.length === 0) throw new NotFoundError(id);
  return rowToProfile(r.rows[0]);
}

/**
 * The currently ACTIVE profile, or null if none.
 *
 * Null is the normal state on a fresh system, not an error. It corresponds to the
 * device reporting `cfg.src: "none"` — first boot, nothing configured yet.
 */
export async function getActiveProfile() {
  const r = await query(
    `SELECT * FROM config_profiles WHERE gh_id = $1 AND status = 'ACTIVE'`,
    [config.ghId]
  );
  return r.rows.length ? rowToProfile(r.rows[0]) : null;
}

/**
 * Field-by-field diff between a profile and the active one.
 *
 * Returns changed fields only, with dotted paths matching up/ack rejection paths.
 * A text diff of canonical JSON would be technically accurate and practically
 * unreadable — the canonical form sorts keys, so unrelated fields move around.
 *
 * @returns {{ hasActive: boolean, activeVer: number|null, changes: Array }}
 */
export async function diffAgainstActive(id) {
  const profile = await getProfile(id);
  const active = await getActiveProfile();

  if (!active) {
    // Everything is new. Report it as such rather than as thirty changes from
    // nothing, which would be noise on a first-configuration screen.
    return { hasActive: false, activeVer: null, profileVer: profile.ver, changes: [] };
  }

  const changes = [];
  const walk = (a, b, path) => {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const k of keys) {
      const av = a?.[k];
      const bv = b?.[k];
      const p = path ? `${path}.${k}` : k;
      const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
      if (isObj(av) || isObj(bv)) {
        walk(av, bv, p);
      } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
        changes.push({ field: p, from: av ?? null, to: bv ?? null });
      }
    }
  };
  walk(active.cfg, profile.cfg, '');

  return {
    hasActive: true,
    activeVer: active.ver,
    profileVer: profile.ver,
    activeHash: active.cfgHash,
    profileHash: profile.cfgHash,
    changes,
  };
}

/** Generic guarded status transition. */
async function transition(id, to, eventType, { actor = null, detail = null } = {}) {
  return transaction(async (client) => {
    const current = await client.query(
      `SELECT * FROM config_profiles WHERE id = $1 AND gh_id = $2 FOR UPDATE`,
      [id, config.ghId]
    );
    if (current.rows.length === 0) throw new NotFoundError(id);

    const from = current.rows[0].status;
    assertTransition(from, to, id);

    const updated = await client.query(
      `UPDATE config_profiles SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [to, id]
    );

    await recordEvent(client, {
      eventType,
      refId: id,
      actor,
      detail: { from, to, ...(detail ?? {}) },
    });

    return rowToProfile(updated.rows[0]);
  });
}

/**
 * DRAFT → PROPOSED. Optionally carries a TTL after which the proposal expires.
 */
export async function proposeProfile(id, { ttlHours = null, actor = null } = {}) {
  const result = await transition(id, 'PROPOSED', 'CONFIG_PROPOSED', { actor });
  if (ttlHours) {
    await query(
      `UPDATE config_profiles SET ttl_expires_at = now() + ($1 || ' hours')::interval WHERE id = $2`,
      [String(ttlHours), id]
    );
    return getProfile(id);
  }
  return result;
}

/**
 * PROPOSED → APPROVED.
 *
 * ██ STUB — 05a ONLY ██
 *
 * This performs NO signature verification and NO M-of-N counting. It exists so
 * the rest of the pipeline is exercisable end to end before 05b lands.
 *
 * 05b replaces the body with: verify each signature against the proposer's
 * registered public key over cfg_hash, refuse to count the proposer's own
 * signature toward the threshold, and only reach APPROVED once M distinct
 * approvers are recorded. The route, the event, and the state machine stay
 * exactly as they are.
 *
 * The event detail records `stub: true`, so an approval granted without
 * signatures is permanently distinguishable in the audit trail from a real one.
 * Phase 07 must be able to tell them apart.
 */
export async function approveProfile(id, { actor = null } = {}) {
  return transition(id, 'APPROVED', 'CONFIG_APPROVED', {
    actor,
    detail: {
      stub: true,
      note: '05a stub — no signature verification, no M-of-N threshold. Replaced in 05b.',
    },
  });
}

/** → REJECTED. One rejection kills a proposal; the reason is recorded. */
export async function rejectProfile(id, { reason = null, actor = null } = {}) {
  return transition(id, 'REJECTED', 'CONFIG_REJECTED', { actor, detail: { reason } });
}

/**
 * APPROVED → ACTIVE, demoting the current ACTIVE to SUPERSEDED.
 *
 * Both statements run in one transaction, and they must. The partial unique index
 * `WHERE status='ACTIVE'` permits exactly one active profile per greenhouse, so
 * promoting before demoting fails at the database level. That constraint is the
 * real guarantee — this function is merely the correct way to satisfy it.
 *
 * Does NOT publish to MQTT. The caller publishes after this returns, keeping the
 * database transaction and the network call separate: a broker timeout must not
 * roll back a committed activation, and a committed activation must be
 * republishable from the database afterwards.
 *
 * @returns {{ activated: object, superseded: object|null }}
 */
export async function activateProfile(id, { actor = null } = {}) {
  return transaction(async (client) => {
    const current = await client.query(
      `SELECT * FROM config_profiles WHERE id = $1 AND gh_id = $2 FOR UPDATE`,
      [id, config.ghId]
    );
    if (current.rows.length === 0) throw new NotFoundError(id);

    const from = current.rows[0].status;
    assertTransition(from, 'ACTIVE', id);

    // Demote first — the index will reject two ACTIVE rows.
    const previous = await client.query(
      `UPDATE config_profiles SET status = 'SUPERSEDED', updated_at = now()
       WHERE gh_id = $1 AND status = 'ACTIVE' RETURNING *`,
      [config.ghId]
    );

    const activated = await client.query(
      `UPDATE config_profiles SET status = 'ACTIVE', updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id]
    );

    if (previous.rows.length > 0) {
      await recordEvent(client, {
        eventType: 'CONFIG_SUPERSEDED',
        refId: previous.rows[0].id,
        actor,
        detail: { supersededBy: id, supersededByVer: activated.rows[0].ver },
      });
    }

    await recordEvent(client, {
      eventType: 'CONFIG_ACTIVATED',
      refId: id,
      actor,
      detail: {
        from,
        ver: activated.rows[0].ver,
        cfgHash: activated.rows[0].cfg_hash,
        supersededId: previous.rows[0]?.id ?? null,
        // Contract §3.7 rule 7: a newly APPROVED config cancels all active
        // overrides immediately. The edge enforces this; recorded here so the
        // audit trail shows why an override ended.
        cancelsOverrides: true,
      },
    });

    return {
      activated: rowToProfile(activated.rows[0]),
      superseded: previous.rows.length ? rowToProfile(previous.rows[0]) : null,
    };
  });
}

/**
 * Expire proposals past their TTL. Called on a timer.
 *
 * @returns {Promise<number>} how many expired
 */
export async function expireStaleProposals({ actor = null } = {}) {
  return transaction(async (client) => {
    const stale = await client.query(
      `SELECT id, status FROM config_profiles
       WHERE gh_id = $1
         AND status IN ('PROPOSED', 'PARTIALLY_APPROVED')
         AND ttl_expires_at IS NOT NULL
         AND ttl_expires_at < now()
       FOR UPDATE`,
      [config.ghId]
    );

    for (const row of stale.rows) {
      await client.query(
        `UPDATE config_profiles SET status = 'EXPIRED', updated_at = now() WHERE id = $1`,
        [row.id]
      );
      await recordEvent(client, {
        eventType: 'CONFIG_EXPIRED',
        refId: row.id,
        actor,
        detail: { from: row.status },
      });
    }

    return stale.rows.length;
  });
}

/** Recent events, newest first, for the audit feed. */
export async function listEvents({ limit = 100 } = {}) {
  const r = await query(
    `SELECT * FROM server_events WHERE gh_id = $1 ORDER BY time DESC LIMIT $2`,
    [config.ghId, limit]
  );
  return r.rows.map((row) => ({
    id: row.id,
    time: row.time,
    eventType: row.event_type,
    refTable: row.ref_table,
    refId: row.ref_id,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    detail: row.detail,
    signatureRef: row.signature_ref,
  }));
}

/** Exported for tests and for rendering the lifecycle in the UI. */
export { TRANSITIONS };

/** Generate a short command id, contract §3.7 format (e.g. "c8f21e"). */
export function newCommandId() {
  return 'c' + randomUUID().replace(/-/g, '').slice(0, 5);
}
