/**
 * SDIGF Phase 07 — ledger link construction. THE PURE CORE.
 *
 * NO DATABASE, NO CONFIG, NO CLOCK, NO RANDOMNESS. This module imports canon.js
 * and nothing else.
 *
 * It lives beside canon.js rather than in services/ for the same reason canon.js
 * and config-schema.js do: it is the part that must be verifiable without
 * infrastructure. Importing db.js here would pull in config.js, which throws on a
 * missing PG_PASS at import time — and the whole test suite for the thing that
 * defines every hash in the ledger would then only run on a machine with a
 * database. The assertions that matter most would be the ones most often skipped.
 *
 * services/ledger-service.js does the I/O and re-exports everything here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO FROZEN THINGS LIVE IN THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. THE WIRE NAMES of the hashed object.
 *   2. THE SQL TIME EXPRESSION that produces the `time` string.
 *
 * Both are frozen in the same sense as canon.js's test vector. Changing either
 * rewrites every hash already in the table, and the failure is not loud at the
 * point of the mistake — it is silent then, and universal later, reading as
 * tampering across the entire chain at once.
 */

import { canonicalize, hashCanonical } from './canon.js';

/** Raised for ledger-layer faults that are writer bugs, not tamper findings. */
export class LedgerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// THE FROZEN TIME EXPRESSION
// ---------------------------------------------------------------------------

/**
 * The ONE SQL expression that turns server_events.time into the string that goes
 * into the hash. Writer and verifier both call this; neither may inline its own.
 *
 *   to_char(<col> AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 *
 * Session-independent, driver-independent, fixed six-digit precision. Verified
 * against Postgres 16:
 *   '2026-08-25 14:03:07.123456+03' → '2026-08-25T11:03:07.123456Z'
 *   '2026-01-02 03:04:05+00'        → '2026-01-02T03:04:05.000000Z'
 * Identical under a hostile session TimeZone, and .US zero-pads to six digits
 * rather than truncating, so the field width never varies.
 *
 * Reading the timestamptz through the driver instead would reintroduce exactly
 * what this avoids: timezone handling and microsecond precision round-trip
 * inconsistently across driver versions.
 *
 * @param {string} col - column expression, e.g. 'e.time'
 * @returns {string} SQL fragment
 */
export function timeSql(col) {
  return `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** The two frozen vectors, exported so the tests and a DBA assert the same pair. */
export const TIME_VECTORS = [
  { input: '2026-08-25 14:03:07.123456+03', expected: '2026-08-25T11:03:07.123456Z' },
  { input: '2026-01-02 03:04:05+00', expected: '2026-01-02T03:04:05.000000Z' },
];

// ---------------------------------------------------------------------------
// THE RESOLVED SIGNATURE OBJECT
// ---------------------------------------------------------------------------

/**
 * Reduce a config_approvals row to the fields constituting the cryptographic
 * claim. Pure — the caller does the SELECT.
 *
 * created_at is DELIBERATELY EXCLUDED: the link already carries the event's own
 * `time`, and a second timestamp adds nothing verifiable while adding one more
 * thing that must round-trip identically forever.
 *
 * `approval_id` is the FROZEN WIRE NAME for config_approvals.id.
 *
 * `reason` is not here either, but rejection reasons are separately copied into
 * server_events.detail by approval-service, so they are chained regardless.
 *
 * @param {object|null} row
 * @returns {object|null}
 */
export function signedFields(row) {
  if (!row) return null;
  return {
    approval_id: Number(row.id),
    key_id: row.key_id,
    user_id: row.user_id,
    decision: row.decision,
    cfg_hash: row.cfg_hash,
    signature: row.signature ?? null,
  };
}

// ---------------------------------------------------------------------------
// BUILDING A LINK
// ---------------------------------------------------------------------------

/**
 * Build the canonical string and entry hash for one link.
 *
 * The hashed object, with its FROZEN WIRE NAMES:
 *   { seq, prev, event_id, time, gh, event_type, ref_table, ref_id,
 *     actor_id, actor_role, detail, signature }
 *
 * `gh` ← server_events.gh_id and `prev` ← ledger.prev_hash. canonicalize() sorts
 * keys, so the order written here is irrelevant to the output — but the
 * SPELLINGS are not.
 *
 * server_events.recorded_at is excluded. Consequence, stated rather than
 * implied: recorded_at can be edited without breaking the chain.
 *
 * TWO CONSTRAINTS INHERITED FROM canon.js, DELIBERATELY NOT WORKED AROUND:
 *
 *   - It THROWS on non-integer numbers. `detail` is unconstrained JSONB, so a
 *     float in a detail payload throws here and, for a strict caller, fails the
 *     whole transaction. That is intended: the audit trail IS the product for
 *     those callers, and a silently unaudited approval is worse than a failed
 *     one. JS renders 1.0 as "1" and C renders it "1.000000"; there is no safe
 *     coercion, only a deferred mismatch.
 *
 *   - Integers must arrive as NUMBERS. db.js sets
 *     pg.types.setTypeParser(INT8, Number); without it every BIGINT arrives as a
 *     string, canonicalize quotes it, every hash changes, and nothing raises an
 *     error anywhere. Pinned by a test.
 *
 * @param {{seq: number, prev: string|null, event: object, signature: object|null}} args
 * @returns {{canonical: string, entryHash: string}}
 */
export function buildLink({ seq, prev, event, signature }) {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new LedgerError(`seq must be a positive integer, got ${seq}`, 'bad_seq');
  }
  if (!event || event.id === undefined || event.id === null) {
    throw new LedgerError('buildLink requires an event row', 'no_event');
  }
  if (typeof event.time_str !== 'string') {
    throw new LedgerError(
      'event.time_str must be the frozen time STRING, not a Date or timestamptz — ' +
        'select it through timeSql()',
      'bad_time'
    );
  }

  const content = {
    seq,
    prev: prev ?? null,
    event_id: event.id,
    time: event.time_str,
    gh: event.gh_id,
    event_type: event.event_type,
    ref_table: event.ref_table,
    ref_id: event.ref_id,
    actor_id: event.actor_id ?? null,
    actor_role: event.actor_role ?? null,
    detail: event.detail ?? null,
    signature: signature ?? null,
  };

  const canonical = canonicalize(content);
  return { canonical, entryHash: hashCanonical(canonical) };
}

/**
 * Field-level diff between two canonical strings.
 *
 * Both are valid JSON by construction, so this parses rather than pattern-matches.
 * "The chain is broken" is not actionable; "link 47's actor_id changed from
 * eng-hala to eng-omar" is. This is the payoff of storing `canonical` rather than
 * recomputing it — a mismatch is diffable down to the field that moved.
 *
 * @param {object} stored
 * @param {object} current
 * @param {string} [prefix]
 * @returns {Record<string, {stored: *, current: *}>}
 */
export function diffCanonical(stored, current, prefix = '') {
  const out = {};
  const a0 = stored ?? {};
  const b0 = current ?? {};
  const keys = new Set([...Object.keys(a0), ...Object.keys(b0)]);

  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const a = a0[k];
    const b = b0[k];

    const bothPlainObjects =
      a && b && typeof a === 'object' && typeof b === 'object' &&
      !Array.isArray(a) && !Array.isArray(b);

    if (bothPlainObjects) {
      Object.assign(out, diffCanonical(a, b, path));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out[path] = { stored: a ?? null, current: b ?? null };
    }
  }
  return out;
}
