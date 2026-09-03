/**
 * SDIGF Phase 05c — provider settings service.
 *
 * The I/O shell around provider-crypto.js. This is the ONLY module that ever
 * holds the provider API key in plaintext, and it holds it in exactly two
 * places: inside setProviderKey() between the request body and the cipher,
 * and inside withProviderKey() between the cipher and the provider call.
 * Neither function returns it. Nothing here logs it.
 *
 * Role separation, restated once: the KEK comes from the environment (server
 * admin); the row is written by a dashboard-admin session. This module needs
 * both to do anything useful, and that is the point.
 *
 * ── Failure modes, all decided up front ──────────────────────────────────
 *   KEK absent            → status 'kek_missing'.  Backend runs; chat reports
 *                           "server administrator action required".
 *   KEK malformed         → index.js refuses to start (parseKek throws).
 *                           Same class as a weak bootstrap password.
 *   No row                → status 'not_configured'. Dashboard admin must set.
 *   Row sealed by another → status 'kek_rotated'. EXPECTED after a KEK
 *   KEK (fingerprint ≠)     rotation; the dashboard admin re-enters the key.
 *                           Documented as intended behaviour, not a bug.
 *   Fingerprint matches   → status 'tampered'. NOT expected. Either the
 *   but tag fails           ciphertext or nonce was altered in the database.
 *                           Logged at ERROR with a greppable marker.
 */

import { query, transaction } from '../db.js';
import { config } from '../config.js';
import { appendToLedger } from './ledger-service.js';
import {
  seal,
  open,
  kekFingerprint,
  sameFingerprint,
  SealError,
} from '../provider-crypto.js';

/** Greppable, like SDIGF_BOOTSTRAP_ADMIN_CREATED. Fires only on the tamper branch. */
export const TAMPER_MARKER = 'SDIGF_PROVIDER_KEY_TAMPER_SUSPECTED';

/** Closed list, matching the CHECK in migration 008. Adapters live in chat-service.js. */
export const PROVIDERS = ['anthropic', 'openai'];

export class ProviderError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The KEK for this process, or null. Set once by index.js after parseKek()
 * succeeds. Never read from process.env anywhere else — one place decides
 * whether the environment value is acceptable, and that place is startup.
 */
let KEK = null;
let KEK_FP = null;

export function installKek(kekBuffer) {
  KEK = kekBuffer;
  KEK_FP = kekBuffer ? kekFingerprint(kekBuffer) : null;
}

/** For tests and status: whether a KEK is installed, never the KEK itself. */
export function hasKek() {
  return KEK !== null;
}

// ── read side ───────────────────────────────────────────────────────────────

async function loadRow() {
  const r = await query(
    `SELECT p.provider, p.model, p.api_key_ciphertext, p.api_key_nonce,
            p.api_key_last4, p.kek_fingerprint, p.updated_at, p.updated_by,
            u.username AS updated_by_username
       FROM provider_settings p
       LEFT JOIN users u ON u.id = p.updated_by
      WHERE p.id = 1`
  );
  return r.rows[0] ?? null;
}

/**
 * What the admin panel and the chat both read. Never contains ciphertext,
 * nonce, fingerprint or plaintext — only what is safe to render.
 *
 * @returns {Promise<{
 *   status: 'ok'|'kek_missing'|'not_configured'|'kek_rotated'|'tampered',
 *   usable: boolean,
 *   provider: string|null, model: string|null, last4: string|null,
 *   updatedAt: string|null, updatedBy: {id:string, username:string|null}|null,
 *   message: string
 * }>}
 */
export async function getProviderStatus({ logger = console } = {}) {
  const base = { provider: null, model: null, last4: null, updatedAt: null, updatedBy: null };

  if (!hasKek()) {
    return {
      ...base,
      status: 'kek_missing',
      usable: false,
      message: 'Encryption key not configured — server administrator action required (PROVIDER_KEK).',
    };
  }

  const row = await loadRow();
  if (!row) {
    return {
      ...base,
      status: 'not_configured',
      usable: false,
      message: 'AI provider not configured — a dashboard administrator must set the API key.',
    };
  }

  const shown = {
    provider: row.provider,
    model: row.model,
    last4: row.api_key_last4,
    updatedAt: row.updated_at,
    updatedBy: { id: row.updated_by, username: row.updated_by_username ?? null },
  };

  // Probe the seal without keeping the plaintext. This is the cheapest way to
  // report 'tampered' on the status page before anyone tries to chat.
  const probe = probeSeal(row, logger);
  if (probe === 'ok') {
    return { ...shown, status: 'ok', usable: true, message: `Configured · ends in …${row.api_key_last4}` };
  }
  if (probe === 'kek_rotated') {
    return {
      ...shown,
      status: 'kek_rotated',
      usable: false,
      message:
        'The encryption key was rotated since this API key was stored. Re-enter the API key. ' +
        '(Expected after a PROVIDER_KEK change — not a fault.)',
    };
  }
  return {
    ...shown,
    status: 'tampered',
    usable: false,
    message:
      'Stored API key failed integrity verification under the current encryption key. ' +
      'The ciphertext or nonce was altered in the database. Re-enter the API key and investigate.',
  };
}

/**
 * Attempt to open the row and immediately discard the result. Returns a
 * status string; logs loudly on the tamper branch.
 */
function probeSeal(row, logger) {
  try {
    open(KEK, row.api_key_ciphertext, row.api_key_nonce);
    return 'ok';
  } catch (err) {
    if (!(err instanceof SealError) || err.code !== 'BAD_TAG') {
      // BAD_NONCE / BAD_INPUT cannot happen through this table's CHECKs unless
      // the row was edited by hand. Treat as tampering — it is.
      logger.error(
        `${TAMPER_MARKER} provider_settings row is structurally invalid (${err.code}: ${err.message})`
      );
      return 'tampered';
    }
    if (!sameFingerprint(row.kek_fingerprint, KEK_FP)) {
      // Different KEK sealed this row. Expected after rotation.
      logger.warn(
        `provider API key sealed under a previous PROVIDER_KEK (stored fp ${row.kek_fingerprint}, ` +
          `current fp ${KEK_FP}) — re-entry required. This is intended behaviour after rotation.`
      );
      return 'kek_rotated';
    }
    // Same KEK, tag failed: the bytes in the row are not the bytes we wrote.
    logger.error(
      `${TAMPER_MARKER} provider_settings ciphertext failed AES-GCM authentication under the ` +
        `SAME KEK that sealed it (fp ${KEK_FP}). The row was altered after it was written. ` +
        `last4=${row.api_key_last4} updated_at=${new Date(row.updated_at).toISOString()} ` +
        `updated_by=${row.updated_by}`
    );
    return 'tampered';
  }
}

/**
 * Run `fn` with the plaintext API key, then let it go out of scope.
 *
 * The chat service calls this around the provider request. The key is a
 * function argument, never a return value, so a caller cannot accidentally
 * store it on an object that later gets logged or serialised.
 *
 * Throws ProviderError with the same codes getProviderStatus() reports, so
 * the chat can hand the user the same message the admin page shows.
 *
 * @template T
 * @param {(secret: { apiKey: string, provider: string, model: string }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withProviderKey(fn, { logger = console } = {}) {
  if (!hasKek()) {
    throw new ProviderError(
      'Encryption key not configured — server administrator action required.',
      'kek_missing',
      503
    );
  }
  const row = await loadRow();
  if (!row) {
    throw new ProviderError(
      'AI provider not configured — a dashboard administrator must set the API key.',
      'not_configured',
      503
    );
  }
  const probe = probeSeal(row, logger);
  if (probe !== 'ok') {
    const status = await getProviderStatus({ logger });
    throw new ProviderError(status.message, probe, 503);
  }
  const apiKey = open(KEK, row.api_key_ciphertext, row.api_key_nonce);
  return fn({ apiKey, provider: row.provider, model: row.model });
}

// ── write side ──────────────────────────────────────────────────────────────

/**
 * Set or rotate the provider configuration. Admin-gated at the route.
 *
 * Writes the row and the PROVIDER_CONFIG_CHANGED event in ONE transaction,
 * chained STRICTLY by Phase 07 — the same treatment as APPROVAL_POLICY_CHANGED,
 * for the same reason: a change to who the system talks to must not be able to
 * land unrecorded.
 *
 * The event detail carries provider, model and last4 only.
 *
 * @param {object} args
 * @param {string} args.provider
 * @param {string} args.model
 * @param {string} args.apiKey     Plaintext from the request body. Discarded here.
 * @param {{id:string, role:string}} args.actor
 */
export async function setProviderKey({ provider, model, apiKey, actor }) {
  if (!hasKek()) {
    throw new ProviderError(
      'Cannot store an API key: PROVIDER_KEK is not configured on the server.',
      'kek_missing',
      503
    );
  }
  if (!PROVIDERS.includes(provider)) {
    throw new ProviderError(`provider must be one of ${PROVIDERS.join(', ')}`, 'bad_provider');
  }
  if (typeof model !== 'string' || model.trim() === '' || model.length > 128) {
    throw new ProviderError('model must be a non-empty string of at most 128 characters', 'bad_model');
  }
  if (typeof apiKey !== 'string' || apiKey.trim().length < 8) {
    throw new ProviderError('apiKey must be a string of at least 8 characters', 'bad_key');
  }
  if (!actor?.id) {
    throw new ProviderError('an authenticated actor is required', 'no_actor', 401);
  }

  const { ciphertext, nonce, last4 } = seal(KEK, apiKey.trim());
  // From here on the plaintext is only referenced by `apiKey`, which is a
  // parameter of this function and unreachable once it returns.

  return transaction(async (client) => {
    const before = await client.query(
      `SELECT provider, model, api_key_last4 FROM provider_settings WHERE id = 1`
    );
    const prev = before.rows[0] ?? null;

    const row = await client.query(
      `INSERT INTO provider_settings
         (id, provider, model, api_key_ciphertext, api_key_nonce, api_key_last4, kek_fingerprint,
          updated_at, updated_by)
       VALUES (1, $1, $2, $3, $4, $5, $6, now(), $7)
       ON CONFLICT (id) DO UPDATE SET
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         api_key_ciphertext = EXCLUDED.api_key_ciphertext,
         api_key_nonce = EXCLUDED.api_key_nonce,
         api_key_last4 = EXCLUDED.api_key_last4,
         kek_fingerprint = EXCLUDED.kek_fingerprint,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by
       RETURNING provider, model, api_key_last4, updated_at, updated_by`,
      [provider, model.trim(), ciphertext, nonce, last4, KEK_FP, actor.id]
    );

    const event = await client.query(
      `INSERT INTO server_events (gh_id, event_type, ref_table, ref_id, actor_id, actor_role, detail)
       VALUES ($1, 'PROVIDER_CONFIG_CHANGED', 'provider_settings', 1, $2, $3, $4)
       RETURNING id`,
      [
        config.ghId,
        actor.id,
        actor.role ?? null,
        JSON.stringify({
          action: prev ? 'rotate' : 'set',
          from: prev ? { provider: prev.provider, model: prev.model, last4: prev.api_key_last4 } : null,
          to: { provider, model: model.trim(), last4 },
          // Recorded so a reader of the trail can tell which KEK generation
          // this write belongs to without access to the environment.
          kekFingerprint: KEK_FP,
        }),
      ]
    );

    await appendToLedger(client, event.rows[0].id);

    const r = row.rows[0];
    return {
      provider: r.provider,
      model: r.model,
      last4: r.api_key_last4,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
      action: prev ? 'rotate' : 'set',
    };
  });
}
