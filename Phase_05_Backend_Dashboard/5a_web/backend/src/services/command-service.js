/**
 * SDIGF backend — manual command service.
 *
 * Hard rule 1: commands never flow dashboard → database directly. Routes call
 * this; this validates, records, publishes, and logs. All four, in that order,
 * every time.
 *
 * ─── WHY ORDER MATTERS ─────────────────────────────────────────────────────
 *
 * The command row is written BEFORE the MQTT publish. If the publish then fails,
 * a row exists marked as failed rather than a command that reached hardware with
 * no record of it. The reverse ordering can produce an actuator change nobody
 * can account for afterwards, which is precisely what an audit trail exists to
 * prevent.
 *
 * ─── EVERY COMMAND IS TEMPORARY ────────────────────────────────────────────
 *
 * ttl_s is mandatory (contract §3.7) and expiry is EDGE-LOCAL: the ESP32 runs
 * the countdown and reverts to the config already in NVS. It does not re-fetch
 * from the server, does not wait for a release, and is unaffected by MQTT
 * dropping mid-override. An unreachable server never means a stuck actuator.
 *
 * The consequence is worth stating plainly: the blast radius of any command —
 * human or AI-issued — is bounded by design rather than by trust. Nothing has to
 * behave correctly for the override to end; the timer simply expires.
 */

import { query, transaction } from '../db.js';
import { config } from '../config.js';
import { newCommandId } from './config-service.js';

/** Actuator keys, contract §3.2. `canopy` is positional and handled separately. */
export const RELAY_TARGETS = [
  'pump',
  's_fan',
  'internal_fan',
  'n_fan',
  'humidifier',
  'lights',
  'grow_light',
];

export const ALL_TARGETS = [...RELAY_TARGETS, 'canopy'];

export const ACTIONS = ['on', 'off', 'set', 'release'];

export class CommandError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'CommandError';
    this.field = field;
  }
}

/**
 * Validate a command before anything is written or published.
 *
 * Server-side only. The browser is never trusted, and 05c's MCP server goes
 * through this same path so an AI-issued command inherits identical bounds
 * rather than re-implementing them.
 */
export function validateCommand({ target, action, value, ttl_s }) {
  const errors = [];

  if (!ALL_TARGETS.includes(target)) {
    errors.push({ field: 'target', message: `must be one of ${ALL_TARGETS.join(', ')}` });
  }
  if (!ACTIONS.includes(action)) {
    errors.push({ field: 'action', message: `must be one of ${ACTIONS.join(', ')}` });
  }

  // `set` is canopy-only: it is the one positional actuator. Everything else is
  // a binary relay and cannot be set to a percentage.
  if (action === 'set') {
    if (target !== 'canopy') {
      errors.push({
        field: 'action',
        message: 'set applies only to canopy — the other seven actuators are binary relays',
      });
    }
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      errors.push({ field: 'value', message: 'canopy position must be an integer 0–100' });
    }
  } else if (value !== undefined && value !== null) {
    errors.push({ field: 'value', message: `value applies only to action "set", not "${action}"` });
  }

  if (target === 'canopy' && (action === 'on' || action === 'off')) {
    errors.push({
      field: 'action',
      message: 'canopy is positional — use set with a value, or release',
    });
  }

  // ttl_s: required, no unbounded manual overrides (contract §3.7 rule 4).
  // `release` ends an override immediately and still carries a nominal ttl for
  // schema uniformity, so it is validated the same way.
  if (!Number.isInteger(ttl_s) || ttl_s <= 0) {
    errors.push({ field: 'ttl_s', message: 'is required and must be a positive integer' });
  } else if (ttl_s > config.commandTtlMaxS) {
    errors.push({
      field: 'ttl_s',
      message: `exceeds the server cap of ${config.commandTtlMaxS}s`,
    });
  }

  return errors;
}

/**
 * Issue a manual command.
 *
 * @param {object} cmd - { target, action, value?, ttl_s }
 * @param {object} [opts]
 * @param {{id: string, role: string}} [opts.actor] - null in 05a
 * @param {'dashboard'|'mcp'} [opts.via='dashboard']
 * @param {object} opts.publisher - MqttPublisher instance
 */
export async function issueCommand(cmd, { actor = null, via = 'dashboard', publisher } = {}) {
  const errors = validateCommand(cmd);
  if (errors.length > 0) {
    const err = new CommandError(
      `command validation failed — ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`
    );
    err.errors = errors;
    throw err;
  }

  const id = newCommandId();

  // Write first. A published command with no row is unaccountable; a row with a
  // failed publish is merely a failure, which is recoverable and visible.
  const record = await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO commands (id, gh_id, target, action, value, ttl_s, issued_by, issued_role, via)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        config.ghId,
        cmd.target,
        cmd.action,
        cmd.action === 'set' ? cmd.value : null,
        cmd.ttl_s,
        actor?.id ?? null,
        actor?.role ?? null,
        via,
      ]
    );

    await client.query(
      `INSERT INTO server_events (gh_id, event_type, ref_table, ref_id, actor_id, actor_role, detail)
       VALUES ($1, $2, 'commands', $3, $4, $5, $6)`,
      [
        config.ghId,
        cmd.action === 'release' ? 'COMMAND_RELEASED' : 'COMMAND_ISSUED',
        // server_events.ref_id is BIGINT while commands.id is TEXT, so the id
        // travels in detail rather than being coerced. Kept explicit rather
        // than changing the column type, which 05b/07 depend on.
        0,
        actor?.id ?? null,
        actor?.role ?? null,
        JSON.stringify({
          commandId: id,
          target: cmd.target,
          action: cmd.action,
          value: cmd.action === 'set' ? cmd.value : null,
          ttl_s: cmd.ttl_s,
          via,
          expiryIsEdgeLocal: true,
        }),
      ]
    );

    return inserted.rows[0];
  });

  // Then publish.
  try {
    await publisher.publishCommand({
      id,
      target: cmd.target,
      action: cmd.action,
      value: cmd.action === 'set' ? cmd.value : undefined,
      ttl_s: cmd.ttl_s,
      by: actor ? { user: actor.id, role: actor.role } : undefined,
    });
  } catch (err) {
    await query(
      `UPDATE commands SET ack_result = 'rejected', ack_reason = $1, acked_at = now() WHERE id = $2`,
      [JSON.stringify({ code: 'PUBLISH_FAILED', message: err.message }), id]
    );
    throw new CommandError(
      `command ${id} recorded but publish failed: ${err.message}. ` +
        `CHECK THE BROKER FIRST — a denied publish can return success silently.`
    );
  }

  return {
    id: record.id,
    target: record.target,
    action: record.action,
    value: record.value,
    ttlSeconds: record.ttl_s,
    via: record.via,
    issuedAt: record.issued_at,
    issuedBy: record.issued_by,
    // The server does not track expiry. The edge does, and reports remaining
    // time as ovr_s in up/actuators. Anything computed here would be a guess.
    expiryIsEdgeLocal: true,
  };
}

/**
 * Correlate an incoming up/ack with its command row.
 *
 * Called by the MQTT ack handler. Unknown ids are ignored rather than treated as
 * errors: an ack may arrive for a command issued before a server restart, and
 * that is not a fault worth surfacing.
 */
export async function recordAck(ackPayload) {
  const id = ackPayload?.id;
  if (!id) return null;

  const result = ackPayload.result ?? (ackPayload.ok ? 'accepted' : 'rejected');
  if (!['accepted', 'rejected'].includes(result)) return null;

  const r = await query(
    `UPDATE commands
     SET acked_at = now(), ack_result = $1, ack_reason = $2
     WHERE id = $3 AND gh_id = $4
     RETURNING *`,
    [result, ackPayload.reason ? JSON.stringify(ackPayload.reason) : null, id, config.ghId]
  );

  return r.rows[0] ?? null;
}

/** Recent commands, newest first. */
export async function listCommands({ limit = 50 } = {}) {
  const r = await query(
    `SELECT * FROM commands WHERE gh_id = $1 ORDER BY issued_at DESC LIMIT $2`,
    [config.ghId, limit]
  );
  return r.rows.map((row) => ({
    id: row.id,
    target: row.target,
    action: row.action,
    value: row.value,
    ttlSeconds: row.ttl_s,
    via: row.via,
    issuedAt: row.issued_at,
    issuedBy: row.issued_by,
    issuedRole: row.issued_role,
    ackedAt: row.acked_at,
    ackResult: row.ack_result,
    ackReason: row.ack_reason,
  }));
}
