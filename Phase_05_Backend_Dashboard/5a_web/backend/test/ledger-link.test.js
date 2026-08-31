/**
 * Tests for the ledger service.
 *
 * PURE FUNCTIONS ONLY — no database. Everything here runs with `node --test`
 * against no infrastructure, which is what lets steps 1–3 land and be trusted
 * before step 4 touches a write path.
 *
 * These exist to catch the specific ways this could drift without anyone
 * noticing. Serialization drift in a ledger does not fail loudly at the point of
 * the mistake; it fails much later, everywhere at once, and reads as tampering.
 *
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { CanonError } from '../src/canon.js';
// Imported from the PURE core, not from services/ledger-service.js. That module
// imports db.js → config.js, which throws on a missing PG_PASS at import time —
// so importing it here would force this whole file to be skipped on any machine
// without a database, and the frozen-vector assertions would be the ones most
// often not run.
import {
  buildLink,
  timeSql,
  TIME_VECTORS,
  LedgerError,
  signedFields,
  diffCanonical,
} from '../src/ledger-link.js';

// ---------------------------------------------------------------------------
// A representative event, used by most tests below.
// ---------------------------------------------------------------------------

function sampleEvent(overrides = {}) {
  return {
    id: 42,
    time_str: '2026-08-25T11:03:07.123456Z',
    gh_id: 'gh1',
    event_type: 'CONFIG_APPROVED',
    ref_table: 'config_profiles',
    ref_id: 7,
    actor_id: 'eng-hala',
    actor_role: 'engineer',
    detail: { keyId: 'eng-1a2b3c4d', verified: true, reason: null },
    signature_ref: '3',
    ...overrides,
  };
}

function sampleSignature(overrides = {}) {
  return {
    approval_id: 3,
    key_id: 'eng-1a2b3c4d',
    user_id: 'eng-hala',
    decision: 'approve',
    cfg_hash: 'a'.repeat(64),
    signature: 'b'.repeat(128),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// THE FROZEN TIME FORMAT — same treatment as canon.js's frozen vector
// ---------------------------------------------------------------------------
//
// The format itself lives in SQL, so the string-level assertion here is on the
// EXPRESSION, and the input/output pair is asserted against a real database by
// assertTimeVector() at startup. Both halves matter: this one catches an edit to
// the expression, that one catches a Postgres-side behaviour change.
//
// A format that drifts between writer and verifier produces universal mismatch
// that reads as tampering — the exact failure mode canonicalization discipline
// exists to prevent.

test('frozen time format: the SQL expression is byte-exact', () => {
  assert.equal(
    timeSql('e.time'),
    `to_char(e.time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  );
});

test('frozen time format: the vectors are the ones verified against Postgres 16', () => {
  assert.deepEqual(TIME_VECTORS, [
    { input: '2026-08-25 14:03:07.123456+03', expected: '2026-08-25T11:03:07.123456Z' },
    { input: '2026-01-02 03:04:05+00', expected: '2026-01-02T03:04:05.000000Z' },
  ]);
});

test('frozen time format: fixed width — microseconds always six digits', () => {
  // The second vector is the one that matters here. .US zero-pads rather than
  // truncating, so a whole-second timestamp is the same width as any other. A
  // variable-width field would make hashes depend on when a row happened to land.
  for (const { expected } of TIME_VECTORS) {
    assert.match(expected, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    assert.equal(expected.length, 27);
  }
});

// ---------------------------------------------------------------------------
// THE HASHED OBJECT — frozen wire names and frozen field set
// ---------------------------------------------------------------------------

test('link content has exactly the twelve specified fields, with the frozen wire names', () => {
  const { canonical } = buildLink({
    seq: 1,
    prev: null,
    event: sampleEvent(),
    signature: sampleSignature(),
  });
  const parsed = JSON.parse(canonical);

  assert.deepEqual(Object.keys(parsed).sort(), [
    'actor_id',
    'actor_role',
    'detail',
    'event_id',
    'event_type',
    'gh',
    'prev',
    'ref_id',
    'ref_table',
    'seq',
    'signature',
    'time',
  ]);

  // `gh` NOT `gh_id`, `prev` NOT `prev_hash`. Unchangeable after link 1.
  assert.equal(parsed.gh, 'gh1');
  assert.ok(!('gh_id' in parsed));
  assert.ok(!('prev_hash' in parsed));

  // recorded_at is excluded. It is therefore editable without breaking the chain.
  assert.ok(!('recorded_at' in parsed));
  // signature_ref itself is not hashed — the RESOLVED signature is.
  assert.ok(!('signature_ref' in parsed));
});

test('resolved signature has exactly six fields and excludes created_at', () => {
  const { canonical } = buildLink({
    seq: 5,
    prev: 'c'.repeat(64),
    event: sampleEvent(),
    signature: sampleSignature(),
  });
  const parsed = JSON.parse(canonical);

  assert.deepEqual(Object.keys(parsed.signature).sort(), [
    'approval_id',
    'cfg_hash',
    'decision',
    'key_id',
    'signature',
    'user_id',
  ]);
  assert.ok(!('created_at' in parsed.signature));
  assert.ok(!('config_profile_id' in parsed.signature));
  // `approval_id` is the frozen wire name for config_approvals.id.
  assert.equal(parsed.signature.approval_id, 3);
});

test('signature is null, not omitted, when the event has no signature_ref', () => {
  const { canonical } = buildLink({
    seq: 2,
    prev: 'd'.repeat(64),
    event: sampleEvent({ signature_ref: null }),
    signature: null,
  });
  const parsed = JSON.parse(canonical);
  assert.ok('signature' in parsed);
  assert.equal(parsed.signature, null);
});

test('genesis serializes prev as null, not as an omitted key', () => {
  const { canonical } = buildLink({ seq: 1, prev: null, event: sampleEvent(), signature: null });
  assert.match(canonical, /"prev":null/);
  assert.ok(JSON.parse(canonical).prev === null);
});

// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------

test('output is byte-stable across key insertion order in the source rows', () => {
  // Postgres does not guarantee JSONB key order on read, and a future refactor
  // could reorder the SELECT. canonicalize() sorts keys, so neither may change
  // the hash. If this ever fails, every historical link has become unverifiable.
  const a = buildLink({
    seq: 9,
    prev: 'e'.repeat(64),
    event: sampleEvent({ detail: { keyId: 'k', verified: true, reason: null } }),
    signature: sampleSignature(),
  });
  const b = buildLink({
    seq: 9,
    prev: 'e'.repeat(64),
    event: sampleEvent({ detail: { reason: null, verified: true, keyId: 'k' } }),
    signature: sampleSignature(),
  });
  assert.equal(a.canonical, b.canonical);
  assert.equal(a.entryHash, b.entryHash);
});

test('entryHash is sha256 of the canonical bytes, lowercase hex', () => {
  const { canonical, entryHash } = buildLink({
    seq: 1,
    prev: null,
    event: sampleEvent(),
    signature: sampleSignature(),
  });
  assert.equal(entryHash, createHash('sha256').update(canonical, 'utf8').digest('hex'));
  assert.match(entryHash, /^[0-9a-f]{64}$/);
});

test('nested arrays keep their order — they are data, not sets', () => {
  const withArray = sampleEvent({ detail: { stage_offsets_dc: [0, 20, 40] } });
  const { canonical } = buildLink({ seq: 1, prev: null, event: withArray, signature: null });
  assert.match(canonical, /"stage_offsets_dc":\[0,20,40\]/);
});

// ---------------------------------------------------------------------------
// THE INT8 TYPE PARSER PIN
// ---------------------------------------------------------------------------
//
// db.js sets pg.types.setTypeParser(INT8, Number). Remove that line and every
// BIGINT arrives as a STRING. canonicalize() would quote it, every hash would
// change, and NOTHING WOULD RAISE AN ERROR — the writer would keep producing
// well-formed links that no longer match anything already stored.
//
// These tests make that divergence visible as a test failure rather than as a
// wholesale verification failure months later.

test('INT8 PIN: a string event_id produces a different hash than a numeric one', () => {
  const numeric = buildLink({
    seq: 1,
    prev: null,
    event: sampleEvent({ id: 42 }),
    signature: null,
  });
  const stringy = buildLink({
    seq: 1,
    prev: null,
    event: sampleEvent({ id: '42' }),
    signature: null,
  });
  assert.notEqual(numeric.canonical, stringy.canonical);
  assert.match(numeric.canonical, /"event_id":42/);
  assert.match(stringy.canonical, /"event_id":"42"/);
});

test('INT8 PIN: the same applies to ref_id and to approval_id', () => {
  const numeric = buildLink({
    seq: 1,
    prev: null,
    event: sampleEvent({ ref_id: 7 }),
    signature: sampleSignature({ approval_id: 3 }),
  });
  const stringy = buildLink({
    seq: 1,
    prev: null,
    event: sampleEvent({ ref_id: '7' }),
    signature: sampleSignature({ approval_id: '3' }),
  });
  assert.notEqual(numeric.entryHash, stringy.entryHash);
});

// ---------------------------------------------------------------------------
// STRICTNESS — inherited from canon.js, deliberately not worked around
// ---------------------------------------------------------------------------

test('a float anywhere in detail throws rather than being coerced', () => {
  // INTENDED. For strict appends this fails the caller's whole transaction:
  // the audit trail IS the product there, and a silently unaudited approval is
  // worse than a failed one. JS renders 1.0 as "1" and C renders it "1.000000";
  // there is no safe coercion, only a deferred mismatch.
  assert.throws(
    () =>
      buildLink({
        seq: 1,
        prev: null,
        event: sampleEvent({ detail: { temperature_c: 21.5 } }),
        signature: null,
      }),
    CanonError
  );
});

test('a float nested deep inside detail also throws', () => {
  assert.throws(
    () =>
      buildLink({
        seq: 1,
        prev: null,
        event: sampleEvent({ detail: { from: { threshold_m: 2, ratio: 0.5 } } }),
        signature: null,
      }),
    CanonError
  );
});

test('a Date in detail throws — an integer timestamp is required', () => {
  assert.throws(
    () =>
      buildLink({
        seq: 1,
        prev: null,
        event: sampleEvent({ detail: { at: new Date('2026-08-25T11:03:07Z') } }),
        signature: null,
      }),
    CanonError
  );
});

// ---------------------------------------------------------------------------
// GUARDS AGAINST THE OBVIOUS WRITER MISTAKES
// ---------------------------------------------------------------------------

test('a Date passed as time_str is refused — it must be the frozen string', () => {
  // Selecting e.time instead of timeSql('e.time') is the single easiest way to
  // reintroduce driver-dependent formatting. Caught at the boundary.
  assert.throws(
    () =>
      buildLink({
        seq: 1,
        prev: null,
        event: sampleEvent({ time_str: new Date('2026-08-25T11:03:07Z') }),
        signature: null,
      }),
    LedgerError
  );
});

test('seq must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, '1', null, undefined]) {
    assert.throws(
      () => buildLink({ seq: bad, prev: null, event: sampleEvent(), signature: null }),
      LedgerError,
      `seq ${String(bad)} should be refused`
    );
  }
});

test('null actor_id and actor_role survive as nulls — local e-stops have no actor', () => {
  // PHYSICAL attribution: no identifiable actor, by design. The row must chain
  // exactly as it stands, not be patched into looking attributed.
  const { canonical } = buildLink({
    seq: 3,
    prev: 'f'.repeat(64),
    event: sampleEvent({
      event_type: 'ESTOP_TRIGGERED',
      ref_table: 'none',
      ref_id: 0,
      actor_id: null,
      actor_role: 'local',
      signature_ref: null,
      detail: { seq: 1, state: 'stopped', source: 'local', device_since: 1787654321,
                observed_at: 1787656789, retrospective: true },
    }),
    signature: null,
  });
  const parsed = JSON.parse(canonical);
  assert.equal(parsed.actor_id, null);
  assert.equal(parsed.actor_role, 'local');
  assert.equal(parsed.detail.retrospective, true);
});

test('a missing detail becomes null, not an omitted key', () => {
  const { canonical } = buildLink({
    seq: 1,
    prev: null,
    event: sampleEvent({ detail: null }),
    signature: null,
  });
  assert.ok('detail' in JSON.parse(canonical));
  assert.equal(JSON.parse(canonical).detail, null);
});

// ---------------------------------------------------------------------------
// THE RESOLVED SIGNATURE REDUCER
// ---------------------------------------------------------------------------

test('signedFields maps config_approvals.id to the frozen name approval_id', () => {
  const row = {
    id: 3,
    config_profile_id: 7,
    key_id: 'eng-1a2b3c4d',
    user_id: 'eng-hala',
    decision: 'approve',
    cfg_hash: 'a'.repeat(64),
    signature: 'b'.repeat(128),
    reason: null,
    created_at: new Date('2026-08-25T11:03:07Z'),
  };
  const out = signedFields(row);

  assert.equal(out.approval_id, 3);
  assert.ok(!('id' in out));
  // created_at excluded — the link already carries the event's own `time`.
  assert.ok(!('created_at' in out));
  // config_profile_id and reason excluded — not part of the cryptographic claim.
  assert.ok(!('config_profile_id' in out));
  assert.ok(!('reason' in out));
});

test('signedFields returns null for a reference that resolves to nothing', () => {
  // A deleted approval yields null here, which then differs from the stored
  // non-null and surfaces as CONTENT_CHANGED naming `signature`.
  assert.equal(signedFields(null), null);
  assert.equal(signedFields(undefined), null);
});

// ---------------------------------------------------------------------------
// THE DIFF — "link 47's actor_id changed" beats "the chain is broken"
// ---------------------------------------------------------------------------

test('diff names the exact field that changed', () => {
  const stored = JSON.parse(
    buildLink({ seq: 1, prev: null, event: sampleEvent(), signature: null }).canonical
  );
  const current = JSON.parse(
    buildLink({
      seq: 1,
      prev: null,
      event: sampleEvent({ actor_id: 'eng-omar' }),
      signature: null,
    }).canonical
  );

  assert.deepEqual(diffCanonical(stored, current), {
    actor_id: { stored: 'eng-hala', current: 'eng-omar' },
  });
});

test('diff reaches into the resolved signature — the cross-table payoff', () => {
  // Scenario 3 of the tamper demonstration: an edited signature must be named,
  // not merely detected. This is what chaining the resolved approval buys.
  const stored = JSON.parse(
    buildLink({ seq: 1, prev: null, event: sampleEvent(), signature: sampleSignature() }).canonical
  );
  const current = JSON.parse(
    buildLink({
      seq: 1,
      prev: null,
      event: sampleEvent(),
      signature: sampleSignature({ signature: 'c'.repeat(128) }),
    }).canonical
  );

  const d = diffCanonical(stored, current);
  assert.deepEqual(Object.keys(d), ['signature.signature']);
  assert.equal(d['signature.signature'].stored, 'b'.repeat(128));
});

test('diff reaches into nested detail fields', () => {
  const stored = JSON.parse(
    buildLink({
      seq: 1,
      prev: null,
      event: sampleEvent({ detail: { seq: 1, state: 'stopped', source: 'local' } }),
      signature: null,
    }).canonical
  );
  const current = JSON.parse(
    buildLink({
      seq: 1,
      prev: null,
      event: sampleEvent({ detail: { seq: 1, state: 'stopped', source: 'remote' } }),
      signature: null,
    }).canonical
  );

  assert.deepEqual(diffCanonical(stored, current), {
    'detail.source': { stored: 'local', current: 'remote' },
  });
});

test('diff is empty for identical content', () => {
  const a = JSON.parse(
    buildLink({ seq: 4, prev: 'a'.repeat(64), event: sampleEvent(), signature: sampleSignature() })
      .canonical
  );
  assert.deepEqual(diffCanonical(a, a), {});
});
