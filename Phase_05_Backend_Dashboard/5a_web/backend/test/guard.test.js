/**
 * Tests for mcp/guard.js.
 *
 * PURE — no provider, no database. Runs with `node --test` anywhere.
 *
 * Two halves matter equally: what MUST be rejected, and what MUST NOT be.
 * A guard that rejects "the configuration sets humidity at 65 %" would make
 * the chat unable to do its one job — describe what is set — and the
 * operator would switch it off. False positives are failures too.
 *
 * Run: node --test test/guard.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkReply,
  checkOffersToAct,
  checkLedgerOverclaim,
  checkStaleAsCurrent,
  checkSelfRegulating,
  checkGrowingValue,
  checkSecrets,
  rejectionFeedback,
  generateWithGuard,
  FALLBACK_REPLY,
  MAX_RETRIES,
} from '../src/mcp/guard.js';

const rules = (r) => r.map((v) => v.rule);

// ── §8.1 ledger ─────────────────────────────────────────────────────────────

test('ledger: "trustworthy" in a ledger context is rejected', () => {
  assert.deepEqual(rules(checkLedgerOverclaim('The ledger verified fine, so the history is trustworthy.')), ['ledger_overclaim']);
});

test('ledger: "secure", "immutable", "tamper-proof", "blockchain" are rejected', () => {
  for (const s of [
    'The audit trail is secure.',
    'Records in the chain are immutable.',
    'The hash chain makes the history tamper-proof.',
    'This is a blockchain, so the records are safe.',
  ]) {
    assert.ok(checkLedgerOverclaim(s).length > 0, s);
  }
});

test('ledger: negated claims are ALLOWED — the correct framing uses these words', () => {
  for (const s of [
    'This is not a blockchain.',
    'The ledger is not tamper-proof against a full rewrite from genesis.',
    "The chain doesn't prove the history is trustworthy as a whole.",
    'It cannot claim the records are secure; it proves internal consistency only.',
  ]) {
    assert.deepEqual(checkLedgerOverclaim(s), [], s);
  }
});

test('ledger: the approved guarantee sentence passes', () => {
  const s = 'Past approvals cannot be invented; history can still be destroyed. Records before seq 57 prove content, not order.';
  assert.deepEqual(checkLedgerOverclaim(s), []);
});

test('ledger: "secure" outside a ledger context is not this rule\'s business', () => {
  assert.deepEqual(checkLedgerOverclaim('The session cookie is marked Secure.'), []);
});

// ── §8.2 stale ──────────────────────────────────────────────────────────────

test('stale: a reading with no staleness statement while edge is stale is rejected', () => {
  const r = checkStaleAsCurrent('Inner temperature is 23.4 °C and humidity is 61 %.', { edgeStale: true });
  assert.deepEqual(rules(r), ['stale_as_current']);
});

test('stale: relay state counts as a reading', () => {
  const r = checkStaleAsCurrent('The humidifier is on and the pump is off.', { edgeStale: true });
  assert.deepEqual(rules(r), ['stale_as_current']);
});

test('stale: acknowledged staleness passes', () => {
  for (const s of [
    'The edge went offline 12 minutes ago; the last reading before that was 23.4 °C.',
    'These numbers are stale: 23.4 °C inner, recorded 15 min ago.',
    'No recent data — the last telemetry predates the outage. It showed 61 %.',
  ]) {
    assert.deepEqual(checkStaleAsCurrent(s, { edgeStale: true }), [], s);
  }
});

test('stale: no readings in the reply → nothing to enforce', () => {
  assert.deepEqual(checkStaleAsCurrent('The ledger has 59 links.', { edgeStale: true }), []);
});

test('stale: edge fresh → rule inactive', () => {
  assert.deepEqual(checkStaleAsCurrent('Inner temperature is 23.4 °C.', { edgeStale: false }), []);
});

// ── §8.3 mock ───────────────────────────────────────────────────────────────

test('mock: "the greenhouse is maintaining the temperature" without mock mention is rejected', () => {
  const r = checkSelfRegulating('The greenhouse is currently maintaining the temperature within band.', { mock: true });
  assert.deepEqual(rules(r), ['self_regulating']);
});

test('mock: same sentence with the mock acknowledged passes', () => {
  const s = 'The system is maintaining the temperature — but note this is the mock simulator; no firmware exists.';
  assert.deepEqual(checkSelfRegulating(s, { mock: true }), []);
});

test('mock: not the mock → rule inactive', () => {
  assert.deepEqual(checkSelfRegulating('The greenhouse is maintaining the temperature.', { mock: false }), []);
});

// ── §8.4 growing values ─────────────────────────────────────────────────────

test('growing: advisory phrasing with a value is rejected', () => {
  for (const s of [
    'You could raise the humidity to 70 %.',
    'I would recommend setting the band to 22 °C.',
    'Consider a photoperiod of 16 hours.',
    'Try keeping it around 65 % RH.',
  ]) {
    assert.ok(checkGrowingValue(s).length > 0, s);
  }
});

test('growing: imperative sentence with a value is rejected', () => {
  for (const s of ['Raise humidity to 70 %.', 'Lettuce grows well. Set the target at 20 °C.', 'Lower it to 60%.']) {
    assert.ok(checkGrowingValue(s).length > 0, s);
  }
});

test('growing: "ideal / optimal / should be" with a value is rejected', () => {
  for (const s of ['The ideal humidity for lettuce is 70 %.', 'Optimal is around 20 °C.', 'It should be 65 % RH.']) {
    assert.ok(checkGrowingValue(s).length > 0, s);
  }
});

test('growing: DESCRIBING what the configuration sets is ALLOWED', () => {
  for (const s of [
    'The active configuration sets the humidity band at 60–70 %.',
    'hum.max_dc is set to 70 %, and the humidifier is currently on.',
    'Version 3 targets 22 °C during the photoperiod; the reading is 23.4 °C.',
    'Inner humidity is 58 %, below the configured 60 % lower bound.',
    'The configuration was activated 3 hours ago.',
  ]) {
    assert.deepEqual(checkGrowingValue(s), [], s);
  }
});

test('growing: a suggestion WITHOUT a value is allowed — that is the intended shape', () => {
  for (const s of [
    'You could issue a temporary command to run the humidifier.',
    'You might want to raise this with an engineer.',
    'Consider reviewing the active configuration.',
  ]) {
    assert.deepEqual(checkGrowingValue(s), [], s);
  }
});

// ── offers to act ───────────────────────────────────────────────────────────

test('offers: the live-caught sentence is rejected', () => {
  const r = checkOffersToAct('Would you like to proceed with a manual command or review the configuration?');
  assert.deepEqual(rules(r), ['offers_to_act']);
});

test('offers: first-person offers to operate are rejected', () => {
  for (const s of [
    'Would you like me to turn on the humidifier?',
    'Shall I issue a temporary command?',
    'I can switch the fans to stage 2 if you want.',
    "Let me run the pump for thirty seconds.",
    "I'll go ahead and propose a change.",
  ]) {
    assert.ok(checkOffersToAct(s).length > 0, s);
  }
});

test('offers: telling the person what THEY could do is allowed', () => {
  for (const s of [
    'You could issue a temporary command to run the humidifier.',
    'As an engineer, you can review the active configuration.',
    'If you want, raise it with an engineer.',
    'The humidifier can be turned on manually from the Actuators page.',
  ]) {
    assert.deepEqual(checkOffersToAct(s), [], s);
  }
});

// ── secrets ─────────────────────────────────────────────────────────────────

test('secrets: an Anthropic-shaped key in the output is rejected, and truncated in the report', () => {
  const r = checkSecrets('Your key is sk-ant-api03-abcdefghijklmnop.');
  assert.deepEqual(rules(r), ['secret_leak']);
  assert.ok(!r[0].match.includes('abcdefghijklmnop'));
});

// ── verdict + loop ──────────────────────────────────────────────────────────

test('checkReply aggregates across rules', () => {
  const r = checkReply('The ledger is trustworthy. Raise humidity to 70 %. Inner is 61 %.', { edgeStale: true, mock: true });
  assert.deepEqual(new Set(rules(r.violations)), new Set(['ledger_overclaim', 'growing_value', 'stale_as_current']));
  assert.equal(r.ok, false);
});

test('checkReply passes a compliant answer', () => {
  const s =
    'Edge data is stale — last telemetry 12 min ago, from the mock simulator. Before that, inner humidity read 58 %, ' +
    'below the configured 60 % lower bound. The humidifier was on. As a farmer, you could issue a temporary command; ' +
    'for a configuration change, raise it with an engineer.';
  assert.deepEqual(checkReply(s, { edgeStale: true, mock: true }), { ok: true, violations: [] });
});

test('rejectionFeedback names each violation and does not leak secrets', () => {
  const fb = rejectionFeedback([{ rule: 'growing_value', match: 'raise humidity to 70 %' }, { rule: 'secret_leak', match: 'sk-ant-api…' }]);
  assert.match(fb, /raise humidity to 70 %/);
  assert.match(fb, /credential/);
  assert.doesNotMatch(fb, /sk-ant/);
});

test('generateWithGuard: first compliant reply is returned with attempts=1', async () => {
  const r = await generateWithGuard(async () => 'The ledger has 59 links and verified with no alteration detected.', {});
  assert.equal(r.attempts, 1);
  assert.equal(r.guarded, false);
});

test('generateWithGuard: retries with feedback, then succeeds', async () => {
  const seen = [];
  const r = await generateWithGuard(async (fb) => {
    seen.push(fb);
    return fb ? 'The active configuration sets humidity at 60–70 %.' : 'Raise humidity to 70 %.';
  }, {});
  assert.equal(r.attempts, 2);
  assert.equal(seen[0], null);
  assert.match(seen[1], /rejected by the presentation guard/);
  assert.equal(r.guarded, false);
});

test('generateWithGuard: after MAX_RETRIES the fallback is returned, never the bad text', async () => {
  let calls = 0;
  const r = await generateWithGuard(async () => {
    calls++;
    return 'The history is trustworthy and the ledger is secure.';
  }, {});
  assert.equal(calls, 1 + MAX_RETRIES);
  assert.equal(r.reply, FALLBACK_REPLY);
  assert.equal(r.guarded, true);
  assert.ok(r.violations.length > 0);
});
