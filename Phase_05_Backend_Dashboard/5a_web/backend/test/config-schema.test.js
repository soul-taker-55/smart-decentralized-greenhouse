/**
 * Tests for config validation against contract v4 §4.
 *
 * The scope-boundary tests near the bottom are the important ones: they assert
 * that the validator does NOT reject agronomically unusual values, because
 * deciding what is agronomically sensible is explicitly out of scope.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfig,
  assertValidConfig,
  emptyConfig,
  incompleteFields,
  ValidationError,
} from '../src/config-schema.js';

/** A fully-populated, structurally valid config. Values are arbitrary, not advice. */
function fullConfig() {
  return {
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
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test('a fully populated config validates', () => {
  assert.deepEqual(validateConfig(fullConfig()), []);
});

test('emptyConfig() is valid — nulls are allowed', () => {
  assert.deepEqual(validateConfig(emptyConfig()), []);
});

test('emptyConfig() is valid but not runnable', () => {
  const missing = incompleteFields(emptyConfig());
  assert.ok(missing.length > 0, 'expected unset engineer fields');
  assert.ok(missing.includes('temp.max_dc'));
  assert.ok(missing.includes('pump.soil_start_pct'));
});

test('temp.min_dc null does not block runnability — nothing adds heat', () => {
  const cfg = fullConfig();
  cfg.temp.min_dc = null;
  assert.deepEqual(validateConfig(cfg), []);
  assert.ok(!incompleteFields(cfg).includes('temp.min_dc'));
});

test('a fully populated config has no incomplete fields', () => {
  assert.deepEqual(incompleteFields(fullConfig()), []);
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test('missing block is rejected', () => {
  const cfg = fullConfig();
  delete cfg.pump;
  const errors = validateConfig(cfg);
  assert.ok(errors.some((e) => e.field === 'pump'));
});

test('unknown block is rejected, not ignored', () => {
  const cfg = fullConfig();
  cfg.nutrients = { ec: 12 };
  const errors = validateConfig(cfg);
  assert.ok(errors.some((e) => e.field === 'nutrients'));
});

test('typo in a field name is rejected', () => {
  // A silently-ignored typo would hash fine and sign fine while meaning
  // something different from what the engineer entered.
  const cfg = fullConfig();
  cfg.pump.max_runtime_sec = 120;
  const errors = validateConfig(cfg);
  assert.ok(errors.some((e) => e.field === 'pump.max_runtime_sec'));
});

test('non-object cfg is rejected', () => {
  assert.ok(validateConfig(null).length > 0);
  assert.ok(validateConfig([]).length > 0);
  assert.ok(validateConfig('nope').length > 0);
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

test('float is rejected with a field path', () => {
  const cfg = fullConfig();
  cfg.temp.hyst_dc = 1.5;
  const errors = validateConfig(cfg);
  const err = errors.find((e) => e.field === 'temp.hyst_dc');
  assert.ok(err);
  assert.match(err.message, /integer/);
});

test('string where an integer belongs is rejected', () => {
  const cfg = fullConfig();
  cfg.pump.max_runtime_s = '120';
  assert.ok(validateConfig(cfg).some((e) => e.field === 'pump.max_runtime_s'));
});

test('non-boolean for canopy.enabled_for_cooling is rejected', () => {
  const cfg = fullConfig();
  cfg.canopy.enabled_for_cooling = 'yes';
  assert.ok(validateConfig(cfg).some((e) => e.field === 'canopy.enabled_for_cooling'));
});

test('required field set to null is rejected', () => {
  const cfg = fullConfig();
  cfg.sys.telemetry_interval_s = null;
  assert.ok(validateConfig(cfg).some((e) => e.field === 'sys.telemetry_interval_s'));
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

test('arb_a.priority accepts only temperature or humidity', () => {
  const cfg = fullConfig();
  cfg.arb_a.priority = 'light';
  assert.ok(validateConfig(cfg).some((e) => e.field === 'arb_a.priority'));

  cfg.arb_a.priority = 'humidity';
  assert.deepEqual(validateConfig(cfg), []);
});

test('arb_b.priority accepts only light or temperature', () => {
  const cfg = fullConfig();
  cfg.arb_b.priority = 'humidity';
  assert.ok(validateConfig(cfg).some((e) => e.field === 'arb_b.priority'));
});

// ---------------------------------------------------------------------------
// vent.stage_offsets_dc
// ---------------------------------------------------------------------------

test('vent stage offsets must have exactly three entries — three fans', () => {
  const cfg = fullConfig();
  cfg.vent.stage_offsets_dc = [0, 20];
  assert.ok(validateConfig(cfg).some((e) => e.field === 'vent.stage_offsets_dc'));
});

test('vent stage offsets must ascend', () => {
  // Non-ascending offsets would mean stage 3 engages before stage 2.
  const cfg = fullConfig();
  cfg.vent.stage_offsets_dc = [0, 40, 20];
  const err = validateConfig(cfg).find((e) => e.field === 'vent.stage_offsets_dc');
  assert.ok(err);
  assert.match(err.message, /ascend/);
});

test('duplicate vent offsets are rejected', () => {
  const cfg = fullConfig();
  cfg.vent.stage_offsets_dc = [0, 20, 20];
  assert.ok(validateConfig(cfg).some((e) => e.field === 'vent.stage_offsets_dc'));
});

test('float inside vent offsets is reported with its index', () => {
  const cfg = fullConfig();
  cfg.vent.stage_offsets_dc = [0, 20.5, 40];
  assert.ok(validateConfig(cfg).some((e) => e.field === 'vent.stage_offsets_dc[1]'));
});

// ---------------------------------------------------------------------------
// Range bounds — definitional, not agronomic
// ---------------------------------------------------------------------------

test('percentage above 100 is rejected', () => {
  const cfg = fullConfig();
  cfg.hum.max_pct = 150;
  assert.ok(validateConfig(cfg).some((e) => e.field === 'hum.max_pct'));
});

test('negative percentage is rejected', () => {
  const cfg = fullConfig();
  cfg.pump.water_min_pct = -5;
  assert.ok(validateConfig(cfg).some((e) => e.field === 'pump.water_min_pct'));
});

test('minute-of-day above 1439 is rejected', () => {
  const cfg = fullConfig();
  cfg.photo.on_min = 1500;
  assert.ok(validateConfig(cfg).some((e) => e.field === 'photo.on_min'));
});

test('fan_cap_stage above 3 is rejected — there are three fans', () => {
  const cfg = fullConfig();
  cfg.arb_a.fan_cap_stage = 4;
  assert.ok(validateConfig(cfg).some((e) => e.field === 'arb_a.fan_cap_stage'));
});

test('temperature outside BMP280 datasheet range is rejected', () => {
  const cfg = fullConfig();
  cfg.temp.max_dc = 2000; // 200 °C, beyond what the sensor can report
  assert.ok(validateConfig(cfg).some((e) => e.field === 'temp.max_dc'));
});

test('canopy.step_pct of 0 is rejected — it would mean infinite servo moves', () => {
  const cfg = fullConfig();
  cfg.canopy.step_pct = 0;
  assert.ok(validateConfig(cfg).some((e) => e.field === 'canopy.step_pct'));
});

// ---------------------------------------------------------------------------
// Cross-field coherence
// ---------------------------------------------------------------------------

test('temp.min_dc at or above temp.max_dc is rejected', () => {
  const cfg = fullConfig();
  cfg.temp.min_dc = 300;
  cfg.temp.max_dc = 260;
  assert.ok(validateConfig(cfg).some((e) => e.field === 'temp.min_dc'));
});

test('pump soil_start at or above soil_stop is rejected — pump would never stop', () => {
  const cfg = fullConfig();
  cfg.pump.soil_start_pct = 70;
  cfg.pump.soil_stop_pct = 60;
  const err = validateConfig(cfg).find((e) => e.field === 'pump.soil_start_pct');
  assert.ok(err);
  assert.match(err.message, /never stop/);
});

test('stale_after_s at or below telemetry_interval_s is rejected', () => {
  const cfg = fullConfig();
  cfg.sys.telemetry_interval_s = 60;
  cfg.sys.stale_after_s = 30;
  const err = validateConfig(cfg).find((e) => e.field === 'sys.stale_after_s');
  assert.ok(err);
  assert.match(err.message, /stale on arrival/);
});

test('arb_b.max_pct_in_photo above canopy.max_pct is rejected', () => {
  const cfg = fullConfig();
  cfg.canopy.max_pct = 50;
  cfg.arb_b.max_pct_in_photo = 80;
  assert.ok(validateConfig(cfg).some((e) => e.field === 'arb_b.max_pct_in_photo'));
});

test('coherence checks are skipped when nulls are present', () => {
  // Cannot compare against an unset value, and a partial draft is legitimate.
  const cfg = emptyConfig();
  assert.deepEqual(validateConfig(cfg), []);
});

// ---------------------------------------------------------------------------
// SCOPE BOUNDARY — the validator must not make agronomic judgements
// ---------------------------------------------------------------------------

test('SCOPE: an agronomically extreme but structurally valid config is ACCEPTED', () => {
  // 45 °C ceiling and 5% humidity floor would be poor for lettuce. That is not
  // this validator's call — expert-supplied configuration is accepted as given.
  // The edge safety envelope is the gate that rejects physically unsafe values.
  const cfg = fullConfig();
  cfg.temp.max_dc = 450;
  cfg.temp.min_dc = 0;
  cfg.hum.min_pct = 5;
  cfg.hum.max_pct = 10;
  assert.deepEqual(
    validateConfig(cfg),
    [],
    'validator must not encode crop preferences — agronomy is out of scope'
  );
});

test('SCOPE: a 24-hour photoperiod is ACCEPTED', () => {
  const cfg = fullConfig();
  cfg.photo.on_min = 0;
  cfg.photo.off_min = 1439;
  assert.deepEqual(validateConfig(cfg), []);
});

test('SCOPE: photoperiod may wrap midnight — no ordering constraint', () => {
  // on 20:00, off 04:00 is a legitimate night-lit schedule.
  const cfg = fullConfig();
  cfg.photo.on_min = 1200;
  cfg.photo.off_min = 240;
  assert.deepEqual(validateConfig(cfg), []);
});

// ---------------------------------------------------------------------------
// assertValidConfig
// ---------------------------------------------------------------------------

test('assertValidConfig throws ValidationError carrying every error', () => {
  const cfg = fullConfig();
  cfg.temp.hyst_dc = 1.5;
  cfg.hum.max_pct = 150;
  try {
    assertValidConfig(cfg);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.errors.length, 2);
    assert.ok(err.errors.some((e) => e.field === 'temp.hyst_dc'));
    assert.ok(err.errors.some((e) => e.field === 'hum.max_pct'));
  }
});

test('assertValidConfig passes silently on a valid config', () => {
  assert.doesNotThrow(() => assertValidConfig(fullConfig()));
});
