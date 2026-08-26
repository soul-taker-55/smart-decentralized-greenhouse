// SDIGF mock edge — safety envelope.
//
// ═══════════════════════════════════════════════════════════════════════════
// THIS IS THE SECOND ENFORCEMENT GATE, AND IT IS INDEPENDENT OF THE FIRST.
// ═══════════════════════════════════════════════════════════════════════════
//
// Server-side RBAC decides WHO may change a config. This decides whether the
// values are PHYSICALLY SURVIVABLE for the equipment. A config can be signed by
// a full quorum of agriculture engineers and still be rejected here — that
// independence is the point, and contract §3.4 calls the ENVELOPE rejection
// "the demo's centrepiece" for exactly that reason.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT BELONGS IN HERE, AND WHAT DOES NOT
// ═══════════════════════════════════════════════════════════════════════════
//
//   BELONGS     — limits that come from the HARDWARE. Sensor operating range,
//                 pump dry-run risk, servo duty, relay switching life,
//                 definitional bounds like "a percentage is 0..100".
//
//   DOES NOT    — anything agronomic. "Lettuce prefers 15–22 °C" is a decision
//                 for the agriculture engineer, delivered as config. Encoding
//                 it here would silently overrule the expert this whole system
//                 exists to serve, and would put crop parameterization inside
//                 firmware where it cannot be changed without a reflash.
//
// Every bound below is traceable to a component or to arithmetic. If a future
// bound cannot be justified that way, it is agronomy and does not belong here.
//
// ═══════════════════════════════════════════════════════════════════════════
// PORTING NOTE FOR PHASE 02
// ═══════════════════════════════════════════════════════════════════════════
//
// This file is the reference for the C++ envelope. Keep the same shape: a flat
// list of checks, each returning a field path and a reason, evaluated over a
// parsed config. Do not collapse it into nested ifs — the field path is what
// the dashboard renders and what the thesis counts by category, so each check
// must be able to name precisely what it rejected.

// ── Bounds, each with its physical justification ────────────────────────────

// BMP280 datasheet operating range, -40..85 °C, in deci-Celsius.
const DC_MIN = -400;
const DC_MAX = 850;

// Percentages are definitional.
const PCT_MIN = 0;
const PCT_MAX = 100;

// Minutes in a day. photo.on_min 360 is 06:00.
const MIN_OF_DAY_MAX = 1439;

// Real-world UTC offsets run -12:00 to +14:00.
const TZ_MIN = -720;
const TZ_MAX = 840;

// Three fans, so four ventilation levels: 0..3.
const VENT_STAGE_MAX = 3;

// The pump is a small diaphragm unit with no thermal cutout. A continuous run
// far beyond the time needed to wet the substrate means a stuck relay or a
// broken sensor, and running dry destroys the pump. One hour is generous for
// any plausible substrate volume in this enclosure and still bounds the damage.
const PUMP_MAX_RUNTIME_S = 3600;

// MG996R stalls at roughly 2.5 A, enough to brown out the 5 V rail and reset
// the ESP32. Firmware commands a move, waits the travel time, then DETACHES the
// signal. A step of 0 would mean an unbounded number of moves; a dwell of 0
// would mean commanding the next move before the previous one finished.
const CANOPY_STEP_MIN = 1;
const CANOPY_DWELL_MIN_S = 1;

// A manual override with no meaningful bound is exactly what the contract
// forbids. This ceiling is the equipment-side backstop; the server applies its
// own, currently 3600 s and flagged provisional.
const CMD_TTL_MAX_S = 86400;

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

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

/**
 * Check one integer field, allowing null.
 *
 * NULL IS ACCEPTED HERE ON PURPOSE. A null marks a value the agriculture
 * engineer has not supplied yet. The envelope's job is to reject values that
 * would damage equipment, and an absent value cannot. The control loop simply
 * does not act on a threshold it does not have — which is why temp.min_dc can
 * be null forever without blocking anything: nothing in this enclosure adds
 * heat on demand, so a low reading is alarmable but not actionable.
 */
function checkInt(errors, path, value, min, max, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) errors.push({ field: path, detail: 'required, may not be null' });
    return;
  }
  if (!isInt(value)) {
    // Floats are forbidden contract-wide: JS writes 1.0 as "1" and C prints
    // "1.000000", so a float would produce a different canonical string on each
    // side and break the hash. Deci-Celsius integers exist to avoid this.
    errors.push({ field: path, detail: `must be an integer, got ${JSON.stringify(value)}` });
    return;
  }
  if (value < min || value > max) {
    errors.push({ field: path, detail: `outside equipment limits ${min}..${max}, got ${value}` });
  }
}

/**
 * Validate a config against the equipment envelope.
 *
 * @returns {{field: string|null, detail: string}[]} empty when survivable
 */
export function checkEnvelope(cfg) {
  const errors = [];

  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return [{ field: null, detail: 'config is not an object' }];
  }

  const { sys, temp, hum, vent, pump, photo, canopy, arb_a, arb_b } = cfg;

  // ── Reporting cadence ─────────────────────────────────────────────────────
  if (sys) {
    checkInt(errors, 'sys.telemetry_interval_s', sys.telemetry_interval_s, 1, 3600, { required: true });
    checkInt(errors, 'sys.stale_after_s', sys.stale_after_s, 1, 86400, { required: true });
    // A staleness window shorter than the publish interval marks every reading
    // stale the moment it arrives. Not damaging, but it makes the quality flag
    // meaningless, and the flag is the main defence against a stale reading
    // being read as current.
    if (isInt(sys.telemetry_interval_s) && isInt(sys.stale_after_s) &&
        sys.stale_after_s <= sys.telemetry_interval_s) {
      errors.push({
        field: 'sys.stale_after_s',
        detail: `must exceed sys.telemetry_interval_s (${sys.telemetry_interval_s}); every reading would arrive stale`,
      });
    }
  }

  // ── Temperature ───────────────────────────────────────────────────────────
  if (temp) {
    checkInt(errors, 'temp.min_dc', temp.min_dc, DC_MIN, DC_MAX);
    checkInt(errors, 'temp.max_dc', temp.max_dc, DC_MIN, DC_MAX);
    checkInt(errors, 'temp.hyst_dc', temp.hyst_dc, 0, DC_MAX);
    // An inverted band means the controller is asked to cool below the point it
    // is asked to warn about. Incoherent for any crop, so it is structural.
    if (isInt(temp.min_dc) && isInt(temp.max_dc) && temp.min_dc >= temp.max_dc) {
      errors.push({ field: 'temp.min_dc', detail: `must be below temp.max_dc (${temp.max_dc})` });
    }
  }

  // ── Humidity ──────────────────────────────────────────────────────────────
  if (hum) {
    checkInt(errors, 'hum.min_pct', hum.min_pct, PCT_MIN, PCT_MAX);
    checkInt(errors, 'hum.max_pct', hum.max_pct, PCT_MIN, PCT_MAX);
    checkInt(errors, 'hum.hyst_pct', hum.hyst_pct, PCT_MIN, PCT_MAX);
    if (isInt(hum.min_pct) && isInt(hum.max_pct) && hum.min_pct >= hum.max_pct) {
      errors.push({ field: 'hum.min_pct', detail: `must be below hum.max_pct (${hum.max_pct})` });
    }
  }

  // ── Ventilation ───────────────────────────────────────────────────────────
  if (vent) {
    const offsets = vent.stage_offsets_dc;
    if (!Array.isArray(offsets) || offsets.length !== 3) {
      errors.push({ field: 'vent.stage_offsets_dc', detail: 'must have exactly 3 entries — three fans' });
    } else {
      offsets.forEach((v, i) => checkInt(errors, `vent.stage_offsets_dc[${i}]`, v, 0, DC_MAX, { required: true }));
      // Non-ascending offsets mean a later stage engages before an earlier one,
      // so the staged ventilation the hardware was built for cannot work.
      for (let i = 1; i < offsets.length; i++) {
        if (isInt(offsets[i]) && isInt(offsets[i - 1]) && offsets[i] <= offsets[i - 1]) {
          errors.push({
            field: 'vent.stage_offsets_dc',
            detail: `must ascend — stage ${i + 1} (${offsets[i]}) is not above stage ${i} (${offsets[i - 1]})`,
          });
          break;
        }
      }
    }
    // Relays have finite switching life. A zero rest period lets the control
    // loop chatter a mechanical contact at loop frequency.
    checkInt(errors, 'vent.min_off_s', vent.min_off_s, 1, 86400, { required: true });
  }

  // ── Watering ──────────────────────────────────────────────────────────────
  if (pump) {
    checkInt(errors, 'pump.soil_start_pct', pump.soil_start_pct, PCT_MIN, PCT_MAX);
    checkInt(errors, 'pump.soil_stop_pct', pump.soil_stop_pct, PCT_MIN, PCT_MAX);
    checkInt(errors, 'pump.max_runtime_s', pump.max_runtime_s, 1, PUMP_MAX_RUNTIME_S);
    checkInt(errors, 'pump.cooldown_s', pump.cooldown_s, 0, 86400);
    checkInt(errors, 'pump.water_min_pct', pump.water_min_pct, PCT_MIN, PCT_MAX);
    // start is the dry threshold that starts the pump, stop is the wet
    // threshold that stops it. start >= stop means the stop condition is
    // already true when the pump starts, or never becomes true — either way the
    // pump runs until max_runtime_s every cycle. That is a pump-destroying
    // config, which is precisely what this gate exists to catch.
    if (isInt(pump.soil_start_pct) && isInt(pump.soil_stop_pct) &&
        pump.soil_start_pct >= pump.soil_stop_pct) {
      errors.push({
        field: 'pump.soil_start_pct',
        detail: `must be below pump.soil_stop_pct (${pump.soil_stop_pct}); the pump would never reach its stop condition`,
      });
    }
  }

  // ── Photoperiod ───────────────────────────────────────────────────────────
  if (photo) {
    checkInt(errors, 'photo.on_min', photo.on_min, 0, MIN_OF_DAY_MAX);
    checkInt(errors, 'photo.off_min', photo.off_min, 0, MIN_OF_DAY_MAX);
    checkInt(errors, 'photo.tz_offset_min', photo.tz_offset_min, TZ_MIN, TZ_MAX, { required: true });
    // NOTE: no ordering constraint between on_min and off_min. A schedule may
    // legitimately wrap midnight — on 20:00, off 04:00 is a night-lit period.
    // Rejecting that would be an agronomic judgement, not an equipment limit.
  }

  // ── Canopy ────────────────────────────────────────────────────────────────
  if (canopy) {
    if (typeof canopy.enabled_for_cooling !== 'boolean') {
      errors.push({ field: 'canopy.enabled_for_cooling', detail: 'must be true or false' });
    }
    checkInt(errors, 'canopy.only_above_dc', canopy.only_above_dc, DC_MIN, DC_MAX);
    checkInt(errors, 'canopy.max_pct', canopy.max_pct, PCT_MIN, PCT_MAX, { required: true });
    checkInt(errors, 'canopy.step_pct', canopy.step_pct, CANOPY_STEP_MIN, PCT_MAX, { required: true });
    checkInt(errors, 'canopy.min_dwell_s', canopy.min_dwell_s, CANOPY_DWELL_MIN_S, 86400, { required: true });
    checkInt(errors, 'canopy.max_shade_min_day', canopy.max_shade_min_day, 0, MIN_OF_DAY_MAX + 1);
    // A step larger than the ceiling means the first move overshoots and the
    // servo is driven against its mechanical limit.
    if (isInt(canopy.max_pct) && isInt(canopy.step_pct) && canopy.step_pct > canopy.max_pct) {
      errors.push({ field: 'canopy.step_pct', detail: `cannot exceed canopy.max_pct (${canopy.max_pct})` });
    }
  }

  // ── Conflict A: fans vs humidifier ────────────────────────────────────────
  if (arb_a) {
    if (!['temperature', 'humidity'].includes(arb_a.priority)) {
      errors.push({ field: 'arb_a.priority', detail: 'must be temperature or humidity' });
    }
    checkInt(errors, 'arb_a.fan_cap_stage', arb_a.fan_cap_stage, 0, VENT_STAGE_MAX, { required: true });
    checkInt(errors, 'arb_a.max_suppress_s', arb_a.max_suppress_s, 0, 86400, { required: true });
  }

  // ── Conflict B: canopy vs photoperiod ─────────────────────────────────────
  if (arb_b) {
    if (!['light', 'temperature'].includes(arb_b.priority)) {
      errors.push({ field: 'arb_b.priority', detail: 'must be light or temperature' });
    }
    checkInt(errors, 'arb_b.max_pct_in_photo', arb_b.max_pct_in_photo, PCT_MIN, PCT_MAX, { required: true });
    // Shading beyond the mechanical ceiling is unreachable, so a higher
    // in-photoperiod limit is a contradiction between two blocks.
    if (canopy && isInt(canopy.max_pct) && isInt(arb_b.max_pct_in_photo) &&
        arb_b.max_pct_in_photo > canopy.max_pct) {
      errors.push({
        field: 'arb_b.max_pct_in_photo',
        detail: `cannot exceed canopy.max_pct (${canopy.max_pct})`,
      });
    }
  }

  return errors;
}

/**
 * Validate a manual command against the same equipment limits.
 *
 * A command bypasses the control loop, so it bypasses every bound the config
 * would have imposed. It must be checked here or the envelope has a hole the
 * size of the dashboard.
 */
export function checkCommand(cmd) {
  const errors = [];
  const targets = [...RELAY_TARGETS, 'canopy'];

  if (!targets.includes(cmd?.target)) {
    errors.push({ field: 'target', detail: `unknown actuator ${JSON.stringify(cmd?.target)}` });
  }
  if (!['on', 'off', 'set', 'release'].includes(cmd?.action)) {
    errors.push({ field: 'action', detail: `unknown action ${JSON.stringify(cmd?.action)}` });
  }

  // `set` is canopy-only: it is the single positional actuator. The other seven
  // are binary relays and cannot be driven to a percentage.
  if (cmd?.action === 'set') {
    if (cmd.target !== 'canopy') {
      errors.push({ field: 'action', detail: 'set applies only to canopy; the relays are binary' });
    }
    if (!isInt(cmd.value) || cmd.value < PCT_MIN || cmd.value > PCT_MAX) {
      errors.push({ field: 'value', detail: 'canopy position must be an integer 0..100' });
    }
  }
  if (cmd?.target === 'canopy' && ['on', 'off'].includes(cmd?.action)) {
    errors.push({ field: 'action', detail: 'canopy is positional; use set or release' });
  }

  // Mandatory and bounded. Contract §3.7: "Required — no unbounded manual
  // overrides." An override that never expires is indistinguishable from a
  // permanent config change made without approval.
  if (!isInt(cmd?.ttl_s) || cmd.ttl_s <= 0) {
    errors.push({ field: 'ttl_s', detail: 'required, must be a positive integer' });
  } else if (cmd.ttl_s > CMD_TTL_MAX_S) {
    errors.push({ field: 'ttl_s', detail: `exceeds the equipment ceiling of ${CMD_TTL_MAX_S}s` });
  }

  return errors;
}
