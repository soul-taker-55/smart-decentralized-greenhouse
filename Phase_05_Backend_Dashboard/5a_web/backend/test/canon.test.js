/**
 * Tests for the canonicalization module.
 *
 * The frozen vector test is the one that matters. The rest exist to catch the
 * specific ways this could drift without anyone noticing.
 *
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  hashCanonical,
  buildSignedContent,
  assertFrozenVector,
  CanonError,
} from '../src/canon.js';

// ---------------------------------------------------------------------------
// The frozen vector — contract v4 §5
// ---------------------------------------------------------------------------

test('frozen vector: canonical string matches contract exactly', () => {
  const input = { a: [3, 1, 2], b: { x: 1, y: 2 }, c: null, d: true };
  assert.equal(canonicalize(input), '{"a":[3,1,2],"b":{"x":1,"y":2},"c":null,"d":true}');
});

test('frozen vector: hash matches contract exactly', () => {
  const input = { a: [3, 1, 2], b: { x: 1, y: 2 }, c: null, d: true };
  assert.equal(
    hashCanonical(canonicalize(input)),
    '911a7250d4853dec84df401015ab201c6241ee1c87fb6e70862afd13e087a908'
  );
});

test('frozen vector: reproduces regardless of input key order', () => {
  // Same data, keys supplied in a different order. If this fails, the sort is
  // not happening and hashes would depend on how the browser built the object.
  const shuffled = { d: true, b: { y: 2, x: 1 }, c: null, a: [3, 1, 2] };
  assert.equal(
    hashCanonical(canonicalize(shuffled)),
    '911a7250d4853dec84df401015ab201c6241ee1c87fb6e70862afd13e087a908'
  );
});

test('assertFrozenVector passes on the current implementation', () => {
  assert.doesNotThrow(() => assertFrozenVector());
});

// ---------------------------------------------------------------------------
// Arrays keep order, objects sort
// ---------------------------------------------------------------------------

test('arrays preserve order — sorting them would reassign vent stages', () => {
  assert.equal(canonicalize({ stage_offsets_dc: [0, 20, 40] }), '{"stage_offsets_dc":[0,20,40]}');
  // A different order is a different config, and must hash differently.
  assert.notEqual(
    hashCanonical(canonicalize([0, 20, 40])),
    hashCanonical(canonicalize([40, 20, 0]))
  );
});

test('nested object keys sort recursively', () => {
  const input = { z: { c: 3, a: 1, b: 2 }, a: { y: 2, x: 1 } };
  assert.equal(canonicalize(input), '{"a":{"x":1,"y":2},"z":{"a":1,"b":2,"c":3}}');
});

// ---------------------------------------------------------------------------
// Floats are rejected — the cross-language hash mismatch the contract forbids
// ---------------------------------------------------------------------------

test('float is rejected with the field path', () => {
  assert.throws(
    () => canonicalize({ temp: { hyst_dc: 1.5 } }),
    (err) => err instanceof CanonError && err.path === 'temp.hyst_dc'
  );
});

test('float inside an array is rejected with its index', () => {
  assert.throws(
    () => canonicalize({ vent: { stage_offsets_dc: [0, 20.5, 40] } }),
    (err) => err instanceof CanonError && err.path === 'vent.stage_offsets_dc[1]'
  );
});

test('integer-valued float is accepted (2.0 is an integer in JS)', () => {
  // 2.0 === 2 in JavaScript; there is no separate float type. This is fine
  // because it serializes as "2", identically to C's %d.
  assert.equal(canonicalize({ a: 2.0 }), '{"a":2}');
});

test('negative zero serializes as 0, not -0', () => {
  // Otherwise 0 and -0 would produce different hashes for identical config.
  assert.equal(canonicalize({ a: -0 }), '{"a":0}');
  assert.equal(hashCanonical(canonicalize({ a: -0 })), hashCanonical(canonicalize({ a: 0 })));
});

// ---------------------------------------------------------------------------
// Nulls and undefined
// ---------------------------------------------------------------------------

test('null is preserved, never dropped', () => {
  // Config uses null to mark engineer-supplied fields. Dropping them changes shape.
  assert.equal(canonicalize({ min_dc: null, max_dc: 260 }), '{"max_dc":260,"min_dc":null}');
});

test('undefined is rejected rather than silently dropped', () => {
  assert.throws(
    () => canonicalize({ temp: { max_dc: undefined } }),
    (err) => err instanceof CanonError
  );
});

// ---------------------------------------------------------------------------
// No whitespace
// ---------------------------------------------------------------------------

test('output contains no whitespace outside string values', () => {
  const out = canonicalize({ a: 1, b: [1, 2], c: { d: 3 } });
  assert.equal(out, '{"a":1,"b":[1,2],"c":{"d":3}}');
  assert.ok(!/\s/.test(out));
});

test('whitespace inside string values is preserved', () => {
  assert.equal(canonicalize({ name: 'Greenhouse Prototype' }), '{"name":"Greenhouse Prototype"}');
});

// ---------------------------------------------------------------------------
// String escaping
// ---------------------------------------------------------------------------

test('strings requiring escapes are escaped as JSON', () => {
  assert.equal(canonicalize({ a: 'say "hi"' }), '{"a":"say \\"hi\\""}');
  assert.equal(canonicalize({ a: 'line\nbreak' }), '{"a":"line\\nbreak"}');
  assert.equal(canonicalize({ a: 'back\\slash' }), '{"a":"back\\\\slash"}');
});

test('non-ASCII strings survive round trip', () => {
  const out = canonicalize({ name: 'البيوت الزراعية الذكية' });
  assert.equal(JSON.parse(out).name, 'البيوت الزراعية الذكية');
});

// ---------------------------------------------------------------------------
// Canonical output is itself valid JSON
// ---------------------------------------------------------------------------

test('canonical output parses back to the same data', () => {
  // The contract relies on this: the edge parses cfg_canonical for the values it
  // needs, while hashing the raw bytes it received.
  const input = { cfg: { temp: { max_dc: 260, min_dc: null } }, gh: 'gh1', ver: 8 };
  assert.deepEqual(JSON.parse(canonicalize(input)), input);
});

// ---------------------------------------------------------------------------
// buildSignedContent — gh and ver inside the signed content
// ---------------------------------------------------------------------------

test('buildSignedContent nests cfg alongside gh and ver', () => {
  const { cfgCanonical } = buildSignedContent({ temp: { max_dc: 260 } }, 'gh1', 8);
  assert.equal(cfgCanonical, '{"cfg":{"temp":{"max_dc":260}},"gh":"gh1","ver":8}');
});

test('buildSignedContent returns a hash matching an independent computation', () => {
  const { cfgCanonical, cfgHash } = buildSignedContent({ a: 1 }, 'gh1', 1);
  assert.equal(cfgHash, hashCanonical(cfgCanonical));
  assert.match(cfgHash, /^[0-9a-f]{64}$/);
});

test('changing ver changes the hash — replay protection is inside the signature', () => {
  // This is the v3 hole v4 closed. If these hashed the same, an administrator
  // could republish an old signed config at a bumped version and pin the device.
  const a = buildSignedContent({ temp: { max_dc: 260 } }, 'gh1', 8);
  const b = buildSignedContent({ temp: { max_dc: 260 } }, 'gh1', 99);
  assert.notEqual(a.cfgHash, b.cfgHash);
});

test('changing gh changes the hash — cross-device replay protection', () => {
  const a = buildSignedContent({ temp: { max_dc: 260 } }, 'gh1', 8);
  const b = buildSignedContent({ temp: { max_dc: 260 } }, 'gh2', 8);
  assert.notEqual(a.cfgHash, b.cfgHash);
});

test('buildSignedContent rejects bad arguments', () => {
  assert.throws(() => buildSignedContent(null, 'gh1', 1), CanonError);
  assert.throws(() => buildSignedContent([], 'gh1', 1), CanonError);
  assert.throws(() => buildSignedContent({}, '', 1), CanonError);
  assert.throws(() => buildSignedContent({}, 'gh1', -1), CanonError);
  assert.throws(() => buildSignedContent({}, 'gh1', 1.5), CanonError);
});

// ---------------------------------------------------------------------------
// hashCanonical guards
// ---------------------------------------------------------------------------

test('hashCanonical refuses an object — it hashes the string, not a re-serialization', () => {
  assert.throws(() => hashCanonical({ a: 1 }), CanonError);
});

test('hash has no trailing newline in the input', () => {
  // Contract: "no trailing newline". A stray \n changes the hash completely.
  const withNewline = hashCanonical('{"a":1}\n');
  const without = hashCanonical('{"a":1}');
  assert.notEqual(withNewline, without);
});

// ---------------------------------------------------------------------------
// Full contract §4 config shape
// ---------------------------------------------------------------------------

test('full contract §4 config canonicalizes and hashes', () => {
  const cfg = {
    sys: { telemetry_interval_s: 30, stale_after_s: 60 },
    temp: { min_dc: null, max_dc: null, hyst_dc: null },
    hum: { min_pct: null, max_pct: null, hyst_pct: null },
    vent: { stage_offsets_dc: [0, 20, 40], min_off_s: 60 },
    pump: {
      soil_start_pct: null,
      soil_stop_pct: null,
      max_runtime_s: null,
      cooldown_s: null,
      water_min_pct: null,
    },
    photo: { on_min: null, off_min: null, tz_offset_min: 0 },
    canopy: {
      enabled_for_cooling: true,
      only_above_dc: null,
      max_pct: 100,
      step_pct: 10,
      min_dwell_s: 30,
      max_shade_min_day: null,
    },
    arb_a: { priority: 'temperature', fan_cap_stage: 1, max_suppress_s: 900 },
    arb_b: { priority: 'light', max_pct_in_photo: 30 },
  };

  const { cfgCanonical, cfgHash } = buildSignedContent(cfg, 'gh1', 1);
  assert.match(cfgHash, /^[0-9a-f]{64}$/);
  assert.ok(!/\s/.test(cfgCanonical.replace(/"[^"]*"/g, '')));
  assert.deepEqual(JSON.parse(cfgCanonical).cfg, cfg);

  // Deterministic across repeated calls.
  assert.equal(buildSignedContent(cfg, 'gh1', 1).cfgHash, cfgHash);
});

test('payload size stays well under the ESP32 2048-byte buffer', () => {
  // Contract §3.6: max expected down/config payload is ~1600 B at 4 signatures.
  // cfg_canonical is the bulk of it, so track it here.
  const cfg = {
    sys: { telemetry_interval_s: 30, stale_after_s: 60 },
    temp: { min_dc: 180, max_dc: 260, hyst_dc: 10 },
    hum: { min_pct: 50, max_pct: 75, hyst_pct: 5 },
    vent: { stage_offsets_dc: [0, 20, 40], min_off_s: 60 },
    pump: {
      soil_start_pct: 35,
      soil_stop_pct: 60,
      max_runtime_s: 120,
      cooldown_s: 600,
      water_min_pct: 20,
    },
    photo: { on_min: 360, off_min: 1320, tz_offset_min: 0 },
    canopy: {
      enabled_for_cooling: true,
      only_above_dc: 240,
      max_pct: 100,
      step_pct: 10,
      min_dwell_s: 30,
      max_shade_min_day: 180,
    },
    arb_a: { priority: 'temperature', fan_cap_stage: 1, max_suppress_s: 900 },
    arb_b: { priority: 'light', max_pct_in_photo: 30 },
  };
  const { cfgCanonical } = buildSignedContent(cfg, 'gh1', 8);
  const bytes = Buffer.byteLength(cfgCanonical, 'utf8');
  assert.ok(bytes < 900, `cfg_canonical is ${bytes} B, expected well under 900`);
});
