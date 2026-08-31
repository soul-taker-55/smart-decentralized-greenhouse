/**
 * SDIGF Phase 07 — the hash-chained ledger over server_events.
 *
 * THE I/O SHELL. All serialization lives in ../ledger-link.js, which imports
 * canon.js and nothing else. This file does database access and nothing that
 * decides bytes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADDS — STATED NARROWLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing to the trust model. It is not a second trust mechanism, not a
 * blockchain, not consensus, not distributed trust. One operator, one database,
 * one root credential.
 *
 *   THE CHAIN-INTEGRITY CHECK TURNS "ERASABLE" INTO "DETECTABLY ERASABLE."
 *
 * An administrator can still delete or rewrite session-attributed history. What
 * they cannot do is leave the chain consistent afterwards without rebuilding
 * every subsequent link. The record does not become unfalsifiable; it becomes
 * falsifiable only in ways that announce themselves.
 *
 * AND THE ORACLE PROBLEM, since it is adjacent and routinely omitted from
 * published IoT-blockchain work: no ledger can verify that a sensor reading was
 * honest, only that what was written has not been altered since. Some chained
 * events — retrospective local emergency stops — describe things the server did
 * not witness. The chain proves such a record was not altered after the fact. It
 * does NOT prove the originally reported time was true; that rests entirely on
 * the device's own report, which the server cannot verify. THAT IS A DIFFERENT
 * CLAIM from the chain's usual one, and must be said plainly rather than left
 * implicit in a `retrospective` boolean.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE SERIALIZER, ONE TIME EXPRESSION, ONE EVENT PROJECTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The writer and the verifier share buildLink(), timeSql() and EVENT_COLUMNS
 * below. Two spellings of any of them is the same hazard as two serializers: if
 * verification serialized even slightly differently from the writer, EVERY check
 * would fail and read as tampering — a false alarm indistinguishable from a real
 * one, which is worse than no check at all.
 */

import { query, pool } from '../db.js';
import { hashCanonical } from '../canon.js';
import {
  LedgerError,
  timeSql,
  TIME_VECTORS,
  signedFields,
  buildLink,
  diffCanonical,
} from '../ledger-link.js';

// Re-exported so callers and tests have one import site for the whole subsystem.
export { LedgerError, timeSql, TIME_VECTORS, signedFields, buildLink, diffCanonical };

// ---------------------------------------------------------------------------
// THE TIME FORMAT VECTOR
// ---------------------------------------------------------------------------

/**
 * Prove the database still produces the frozen time strings.
 *
 * The format lives in SQL, so unlike canon.js's vector this half cannot be
 * asserted without a database. Call it at startup next to assertFrozenVector().
 *
 * A drifted format is not detectable any other way: it produces links that look
 * perfectly well-formed, and that verification will later reject wholesale.
 *
 * @param {import('pg').PoolClient|null} client
 */
export async function assertTimeVector(client = null) {
  const run = client ? (t, p) => client.query(t, p) : (t, p) => query(t, p);
  for (const { input, expected } of TIME_VECTORS) {
    const r = await run(`SELECT ${timeSql('$1::timestamptz')} AS s`, [input]);
    if (r.rows[0].s !== expected) {
      throw new LedgerError(
        `Ledger time format drift: ${input} produced "${r.rows[0].s}", expected "${expected}". ` +
          'Links written under the new format would verify and links written under the old one ' +
          'would not. Refusing to continue.',
        'time_format_drift'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// READING THE SOURCE ROWS
// ---------------------------------------------------------------------------

/**
 * The single event projection, used identically by the writer and the verifier.
 * `time` is selected THROUGH timeSql() and never as a raw timestamptz.
 */
const EVENT_COLUMNS = `
  e.id,
  ${timeSql('e.time')} AS time_str,
  e.gh_id,
  e.event_type,
  e.ref_table,
  e.ref_id,
  e.actor_id,
  e.actor_role,
  e.detail,
  e.signature_ref
`;

async function loadEvent(run, eventId) {
  const r = await run(`SELECT ${EVENT_COLUMNS} FROM server_events e WHERE e.id = $1`, [eventId]);
  return r.rows[0] ?? null;
}

/**
 * Resolve signature_ref to the fields constituting the cryptographic claim.
 *
 * Returns null when the reference resolves to nothing. That is not silent: at
 * write time the approval was just inserted in the same transaction so it cannot
 * be missing; at verify time a deleted approval yields `signature: null` against
 * a stored non-null, which surfaces as CONTENT_CHANGED naming the field. The
 * database is deliberately not allowed to hide a dangling reference — see the
 * note on signature_ref in 003_auth.sql §8.
 */
export async function resolveSignature(run, signatureRef) {
  if (signatureRef === null || signatureRef === undefined || signatureRef === '') return null;

  const id = Number(signatureRef);
  if (!Number.isInteger(id)) return null;

  const r = await run(
    `SELECT id, key_id, user_id, decision, cfg_hash, signature
       FROM config_approvals WHERE id = $1`,
    [id]
  );
  return signedFields(r.rows[0] ?? null);
}

// ---------------------------------------------------------------------------
// APPENDING
// ---------------------------------------------------------------------------

/**
 * Read the chain head, holding a lock on it for the rest of the transaction.
 *
 * FOR UPDATE MATTERS. Two concurrent events must not both read the same head and
 * produce two links claiming the same prev_hash, forking the chain silently. The
 * lock serializes appends, which is correct — a chain is inherently sequential,
 * and throughput here is a handful of events per day.
 *
 * On an EMPTY table there is no row to lock, so two concurrent genesis appends
 * can both compute seq = 1. The PRIMARY KEY rejects the second and rolls its
 * transaction back: noisy and correct, rather than a silent fork.
 */
async function getHeadForUpdate(client) {
  const r = await client.query(
    `SELECT seq, entry_hash FROM ledger ORDER BY seq DESC LIMIT 1 FOR UPDATE`
  );
  return r.rows[0] ?? null;
}

/** The current chain head, without locking. For status display. */
export async function getHead() {
  const r = await query(
    `SELECT seq, event_id, entry_hash, backfilled, created_at
       FROM ledger ORDER BY seq DESC LIMIT 1`
  );
  return r.rows[0] ?? null;
}

/**
 * Append one event to the chain, INSIDE THE CALLER'S TRANSACTION.
 *
 * Called by the existing services immediately after their server_events insert
 * returns an id, using the same `client`. If this throws, the caller's whole
 * transaction rolls back — the event and its link land together or neither does.
 *
 * THAT ROLLBACK IS THE INTENDED BEHAVIOUR FOR STRICT CALLERS — config approvals,
 * keys, policy, commands. For those the audit trail IS the product, and a
 * silently unaudited approval is worse than a failed one. It also means a float
 * reaching `detail` fails the business operation, because canonicalize() throws
 * on non-integers. A real consequence, deliberately taken.
 *
 * THE ONE EXCEPTION IS EMERGENCY STOP — see appendBestEffort.
 *
 * @param {import('pg').PoolClient} client - the caller's transaction client
 * @param {number} eventId - server_events.id, from RETURNING id
 * @param {{backfilled?: boolean}} [opts]
 */
export async function appendToLedger(client, eventId, { backfilled = false } = {}) {
  const run = (t, p) => client.query(t, p);

  const head = await getHeadForUpdate(client);
  const seq = head ? Number(head.seq) + 1 : 1;
  const prev = head ? head.entry_hash : null;

  const event = await loadEvent(run, eventId);
  if (!event) {
    throw new LedgerError(`server_events row ${eventId} not found`, 'event_not_found');
  }

  const signature = await resolveSignature(run, event.signature_ref);
  const { canonical, entryHash } = buildLink({ seq, prev, event, signature });

  await client.query(
    `INSERT INTO ledger (seq, event_id, prev_hash, entry_hash, canonical, backfilled)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [seq, eventId, prev, entryHash, canonical, backfilled]
  );

  return { seq, eventId, prevHash: prev, entryHash, backfilled };
}

/**
 * Append without ever throwing at the caller. EMERGENCY STOP ONLY.
 *
 * REASON, concrete rather than theoretical: THE E-STOP PUBLISH SITS OUTSIDE ITS
 * TRANSACTION. A strict append that failed would roll the transaction back, the
 * function would throw, and publishEstop() would never run — a bug in the AUDIT
 * layer would prevent a greenhouse from STOPPING.
 *
 *   "A halted greenhouse with a flagged audit gap is strictly better than a
 *    running greenhouse with a clean chain."
 *
 * Not silent. A failure here leaves an unchained event, which check 5 reports as
 * UNCHAINED_EVENT and backfillLedger later reconciles with backfilled = true.
 *
 * Runs in its own short transaction on its own connection, so nothing the caller
 * does afterwards can roll it back.
 */
export async function appendBestEffort(eventId, logger = console) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await appendToLedger(client, eventId);
    await client.query('COMMIT');
    return { appended: true, ...result };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection already broken; the original error is the one worth surfacing.
    }
    logger.error?.(
      { err: err.message, eventId },
      'ledger: best-effort append failed — event is unchained and will be reported by check 5 ' +
        'until reconciled by backfillLedger'
    );
    return { appended: false, eventId, error: err.message };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// BACKFILL AND RECONCILIATION
// ---------------------------------------------------------------------------

/**
 * Chain every server_events row that has no link, in id order, backfilled = true.
 *
 * TWO CALLERS, ONE HONEST MEANING for the flag — "this entry's position in the
 * chain is asserted after the fact":
 *   (a) the one-off historical backfill of events predating the ledger;
 *   (b) the reconciler picking up an e-stop whose best-effort append failed.
 *
 * A reconciled event is appended AT THE HEAD, so its seq is later than events
 * that happened after it. Not a defect and not hidden: `backfilled` says the
 * position is asserted rather than observed, and verifyChain reports
 * realTimeFrom so an examiner reading a green dashboard can see where the real
 * ordering guarantee begins.
 *
 * Single transaction — a half-finished backfill is worse than none.
 */
export async function backfillLedger({ logger = console } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertTimeVector(client);

    const pending = await client.query(
      `SELECT e.id
         FROM server_events e
         LEFT JOIN ledger l ON l.event_id = e.id
        WHERE l.seq IS NULL
        ORDER BY e.id ASC`
    );

    const seqs = [];
    for (const row of pending.rows) {
      const r = await appendToLedger(client, row.id, { backfilled: true });
      seqs.push(r.seq);
    }

    await client.query('COMMIT');
    const result = { chained: seqs.length, fromSeq: seqs[0] ?? null, toSeq: seqs.at(-1) ?? null };
    logger.info?.(result, 'ledger: backfill complete');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection already broken.
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// VERIFICATION
// ---------------------------------------------------------------------------

/**
 * Events with no ledger link. CHECK 5.
 *
 * Without this, "delete the ledger row AND the event row together" is
 * undetectable, because checks 1–4 only walk the ledger.
 */
async function findUnchainedEvents(limit) {
  const r = await query(
    `SELECT e.id,
            ${timeSql('e.time')} AS time_str,
            e.event_type,
            e.actor_role
       FROM server_events e
       LEFT JOIN ledger l ON l.event_id = e.id
      WHERE l.seq IS NULL
      ORDER BY e.id ASC
      LIMIT $1`,
    [limit]
  );
  return r.rows.map((x) => ({
    eventId: x.id,
    time: x.time_str,
    eventType: x.event_type,
    actorRole: x.actor_role,
  }));
}

/**
 * Verify the chain.
 *
 * ⚠ CHECK 5 AND realTimeFrom ARE COMPUTED BEFORE THE WALK, BY CONSTRUCTION.
 *
 * The walk returns at its first failure. If these two ran after it, an unchained
 * event alongside any other break would be INVISIBLE — the two things added
 * specifically to close gaps would be exactly what does not run when verification
 * actually fails. They are separate queries the walk has no way to skip.
 *
 * THE FIVE CHECKS:
 *   1. prev_hash matches the previous link's entry_hash   → insertion/deletion/reorder
 *   2. recomputed hash of stored canonical == entry_hash  → the stored hash was edited
 *   3. re-serializing CURRENT rows reproduces canonical   → event OR SIGNATURE row edited
 *   4. referenced server_events row still exists          → event deletion
 *   5. every server_events row has a link                 → unchained, or link + event
 *                                                           deleted together
 *
 * Check 4 necessarily runs before check 3: a deleted event cannot be
 * re-serialized. Check 3 is where the chain-scope decision pays off — it reaches
 * into config_approvals, so an edited signature produces a canonical string that
 * no longer matches what was stored.
 *
 * The walk STOPS at the first failure and reports how far it got. Everything
 * after a break is UNVERIFIABLE rather than wrong, and reporting sixty subsequent
 * failures would imply sixty separate incidents.
 *
 * WHAT THIS CANNOT DETECT, stated here rather than buried: a CONSISTENT REWRITE
 * FROM GENESIS. An administrator with database access can delete a range of
 * events and rebuild every subsequent link, and this returns ok. That is the
 * honest boundary of an unanchored chain, not an implementation gap. External
 * anchoring is named future work.
 */
export async function verifyChain({ unchainedLimit = 100 } = {}) {
  const checkedAt = new Date().toISOString();
  const run = (t, p) => query(t, p);

  // ── Computed independently of the walk. See the warning above. ────────────
  const unchainedEvents = await findUnchainedEvents(unchainedLimit);

  const boundary = await query(
    `SELECT min(seq) AS real_time_from FROM ledger WHERE backfilled = false`
  );
  const realTimeFrom = boundary.rows[0].real_time_from ?? null;

  // ── The walk ──────────────────────────────────────────────────────────────
  const links = await query(
    `SELECT seq, event_id, prev_hash, entry_hash, canonical, backfilled
       FROM ledger ORDER BY seq ASC`
  );

  const report = {
    ok: false,
    length: links.rows.length,
    verifiedThrough: null,
    realTimeFrom,
    firstFailure: null,
    unchainedEvents,
    checkedAt,
  };

  let previousHash = null;

  for (const link of links.rows) {
    const seq = Number(link.seq);

    // CHECK 1 — linkage.
    if (link.prev_hash !== previousHash) {
      report.firstFailure = {
        seq,
        reason: 'PREV_MISMATCH',
        detail:
          seq === 1
            ? 'the genesis link must have a null prev_hash'
            : `link ${seq} claims a previous hash the preceding link does not have — a link was ` +
              'deleted, inserted, or reordered',
        diff: { prev: { stored: link.prev_hash, current: previousHash } },
      };
      return report;
    }

    // CHECK 2 — the stored hash matches the stored bytes.
    if (hashCanonical(link.canonical) !== link.entry_hash) {
      report.firstFailure = {
        seq,
        reason: 'HASH_MISMATCH',
        detail:
          `link ${seq}'s stored entry_hash is not the hash of its stored canonical string — the ` +
          'hash column was edited directly',
        diff: null,
      };
      return report;
    }

    // CHECK 4 — the event still exists. Necessarily before check 3.
    const event = await loadEvent(run, link.event_id);
    if (!event) {
      report.firstFailure = {
        seq,
        reason: 'EVENT_MISSING',
        detail: `link ${seq} references server_events row ${link.event_id}, which no longer exists`,
        diff: null,
      };
      return report;
    }

    // CHECK 3 — re-serializing the CURRENT rows reproduces the stored bytes.
    // Reaches across into config_approvals via signature_ref.
    const signature = await resolveSignature(run, event.signature_ref);

    let rebuilt;
    try {
      rebuilt = buildLink({ seq, prev: link.prev_hash, event, signature });
    } catch (err) {
      // A row edited into something that cannot be canonicalized at all — a float
      // written into detail, for instance. Still a content change; reported as one.
      report.firstFailure = {
        seq,
        reason: 'CONTENT_CHANGED',
        detail: `link ${seq}'s source rows can no longer be canonicalized: ${err.message}`,
        diff: null,
      };
      return report;
    }

    if (rebuilt.canonical !== link.canonical) {
      let diff = null;
      try {
        diff = diffCanonical(JSON.parse(link.canonical), JSON.parse(rebuilt.canonical));
      } catch {
        // Stored canonical is not parseable; the mismatch still stands.
      }
      report.firstFailure = {
        seq,
        reason: 'CONTENT_CHANGED',
        detail:
          `link ${seq}'s source rows no longer serialize to what was hashed — the server_events ` +
          'row or its referenced approval was edited after the fact',
        diff,
      };
      return report;
    }

    previousHash = link.entry_hash;
    report.verifiedThrough = seq;
  }

  // The walk passed. Check 5 can still fail it — which is the entire reason it is
  // computed outside the walk.
  if (unchainedEvents.length > 0) {
    report.firstFailure = {
      seq: null,
      reason: 'UNCHAINED_EVENT',
      detail:
        `${unchainedEvents.length} server_events row(s) have no ledger link. Either a ` +
        'best-effort append failed and has not been reconciled, or a link and its event were ' +
        'deleted together.',
      diff: null,
    };
    return report;
  }

  report.ok = true;
  return report;
}
