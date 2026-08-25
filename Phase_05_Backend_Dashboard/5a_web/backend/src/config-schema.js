/**
 * SDIGF — config schema and server-side validation. Contract v4 §4.
 *
 * "Server-side validation of every value; never trust the browser."
 *
 * ─── SCOPE BOUNDARY, READ THIS BEFORE ADDING A RULE ────────────────────────
 *
 * This validator enforces STRUCTURAL and PHYSICAL constraints only. It does NOT
 * enforce agronomic ones, and must never start to.
 *
 *   ALLOWED  — "a percentage is 0..100"          (definitional)
 *   ALLOWED  — "minutes from midnight is 0..1439" (definitional)
 *   ALLOWED  — "fan_cap_stage is 0..3"            (there are three fans)
 *   ALLOWED  — "temperature is within BMP280 range" (datasheet)
 *   ALLOWED  — "temp.min_dc must be below temp.max_dc" (incoherent otherwise)
 *
 *   FORBIDDEN — "lettuce prefers 15–22 °C"
 *   FORBIDDEN — "humidity should be at least 50%"
 *   FORBIDDEN — any default that amounts to a setpoint
 *
 * Per the project scope statement: "Crop-specific parameterization is outside
 * the scope of this work. The system is designed to accept expert-supplied
 * configuration rather than to determine optimal growing conditions."
 *
 * Fields marked `nullable` are the ones the agriculture engineer supplies. They
 * are structurally required to be PRESENT but may be null. A config with nulls
 * is valid and storable; whether it is sensible to run is the engineer's call,
 * and whether it is safe to run is the edge safety envelope's call. Two gates,
 * neither replaced by this one.
 *
 * ─── ERROR PATHS ───────────────────────────────────────────────────────────
 * Errors carry a dotted field path ("pump.max_runtime_s") matching the `field`
 * path in up/ack rejection reasons, so the same renderer works for both server
 * validation errors and device rejections.
 */

/** Deci-Celsius bounds from the BMP280 datasheet operating range (-40..85 °C). */
const DC_MIN = -400;
const DC_MAX = 850;

/** Minutes in a day. `photo.on_min: 360` is 06:00. */
const MIN_OF_DAY_MAX = 1439;

/** Real-world UTC offsets run -12:00 to +14:00. */
const TZ_MIN = -720;
const TZ_MAX = 840;

/** One year, as a sanity ceiling on any duration field. Not a policy value. */
const SECONDS_MAX = 31536000;

/**
 * The field spec. Every field in contract §4, with its type and structural bounds.
 * `nullable: true` marks engineer-supplied values.
 */
export const CONFIG_SPEC = {
  sys: {
    telemetry_interval_s: { type: 'int', min: 1, max: 3600, nullable: false },
    stale_after_s: { type: 'int', min: 1, max: SECONDS_MAX, nullable: false },
  },
  temp: {
    // min_dc is ADVISORY ONLY. Nothing in this system adds heat on demand —
    // the grow light is committed to the photoperiod and cannot dim — so a low
    // reading can be alarmed but not acted on. The field exists to make that
    // asymmetry visible rather than an unexplained gap. (§4 "Block-by-block")
    min_dc: { type: 'int', min: DC_MIN, max: DC_MAX, nullable: true },
    max_dc: { type: 'int', min: DC_MIN, max: DC_MAX, nullable: true },
    hyst_dc: { type: 'int', min: 0, max: DC_MAX, nullable: true },
  },
  hum: {
    min_pct: { type: 'int', min: 0, max: 100, nullable: true },
    max_pct: { type: 'int', min: 0, max: 100, nullable: true },
    hyst_pct: { type: 'int', min: 0, max: 100, nullable: true },
  },
  vent: {
    // Offsets ABOVE temp.max_dc, not absolute thresholds. With [0,20,40] and
    // max_dc 260: one fan at 26.0 °C, two at 28.0, three at 30.0.
    stage_offsets_dc: {
      type: 'int_array',
      length: 3,
      min: 0,
      max: DC_MAX,
      ascending: true,
      nullable: false,
    },
    min_off_s: { type: 'int', min: 0, max: SECONDS_MAX, nullable: false },
  },
  pump: {
    soil_start_pct: { type: 'int', min: 0, max: 100, nullable: true },
    soil_stop_pct: { type: 'int', min: 0, max: 100, nullable: true },
    max_runtime_s: { type: 'int', min: 1, max: SECONDS_MAX, nullable: true },
    cooldown_s: { type: 'int', min: 0, max: SECONDS_MAX, nullable: true },
    water_min_pct: { type: 'int', min: 0, max: 100, nullable: true },
  },
  photo: {
    // Minutes from midnight, integers. Strings would invite "6:00" vs "06:00",
    // which changes the hash for identical intent.
    on_min: { type: 'int', min: 0, max: MIN_OF_DAY_MAX, nullable: true },
    off_min: { type: 'int', min: 0, max: MIN_OF_DAY_MAX, nullable: true },
    tz_offset_min: { type: 'int', min: TZ_MIN, max: TZ_MAX, nullable: false },
  },
  canopy: {
    enabled_for_cooling: { type: 'bool', nullable: false },
    only_above_dc: { type: 'int', min: DC_MIN, max: DC_MAX, nullable: true },
    max_pct: { type: 'int', min: 0, max: 100, nullable: false },
    // step_pct and min_dwell_s exist for the servo's sake: the MG996R is
    // commanded, allowed to travel, then detached. Small frequent moves would
    // mean near-continuous holding, and a stalled MG996R at ~2.5 A browns out
    // the 5 V rail. A step of 0 would mean infinite moves — hence min 1.
    step_pct: { type: 'int', min: 1, max: 100, nullable: false },
    min_dwell_s: { type: 'int', min: 0, max: SECONDS_MAX, nullable: false },
    max_shade_min_day: { type: 'int', min: 0, max: MIN_OF_DAY_MAX + 1, nullable: true },
  },
  arb_a: {
    // Fans vs humidifier, when hot AND dry simultaneously.
    priority: { type: 'enum', values: ['temperature', 'humidity'], nullable: false },
    fan_cap_stage: { type: 'int', min: 0, max: 3, nullable: false },
    // max_suppress_s bounds starvation: a pure priority rule can starve one
    // variable indefinitely. Forced alternation is what makes arb_a defensible.
    max_suppress_s: { type: 'int', min: 0, max: SECONDS_MAX, nullable: false },
  },
  arb_b: {
    // Canopy vs photoperiod.
    priority: { type: 'enum', values: ['light', 'temperature'], nullable: false },
    max_pct_in_photo: { type: 'int', min: 0, max: 100, nullable: false },
  },
};

/** A single validation failure, with the dotted path to the offending field. */
export class ValidationError extends Error {
  constructor(errors) {
    const summary = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    super(`config validation failed — ${summary}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

function checkField(path, spec, value, errors) {
  if (value === null) {
    if (!spec.nullable) {
      errors.push({ field: path, message: 'is required and may not be null' });
    }
    return;
  }
  if (value === undefined) {
    errors.push({ field: path, message: 'is missing (use null to mark unset)' });
    return;
  }

  switch (spec.type) {
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push({
          field: path,
          message: `must be an integer (contract v4 forbids floats), got ${JSON.stringify(value)}`,
        });
        return;
      }
      if (value < spec.min || value > spec.max) {
        errors.push({ field: path, message: `must be between ${spec.min} and ${spec.max}, got ${value}` });
      }
      return;

    case 'bool':
      if (typeof value !== 'boolean') {
        errors.push({ field: path, message: `must be true or false, got ${JSON.stringify(value)}` });
      }
      return;

    case 'enum':
      if (!spec.values.includes(value)) {
        errors.push({
          field: path,
          message: `must be one of ${spec.values.join(' | ')}, got ${JSON.stringify(value)}`,
        });
      }
      return;

    case 'int_array': {
      if (!Array.isArray(value)) {
        errors.push({ field: path, message: 'must be an array' });
        return;
      }
      if (value.length !== spec.length) {
        errors.push({
          field: path,
          message: `must have exactly ${spec.length} entries, got ${value.length}`,
        });
        return;
      }
      let bad = false;
      value.forEach((v, i) => {
        if (typeof v !== 'number' || !Number.isInteger(v)) {
          errors.push({ field: `${path}[${i}]`, message: 'must be an integer' });
          bad = true;
        } else if (v < spec.min || v > spec.max) {
          errors.push({
            field: `${path}[${i}]`,
            message: `must be between ${spec.min} and ${spec.max}, got ${v}`,
          });
          bad = true;
        }
      });
      if (!bad && spec.ascending) {
        for (let i = 1; i < value.length; i++) {
          if (value[i] <= value[i - 1]) {
            errors.push({
              field: path,
              message: `must ascend — stage ${i + 1} offset (${value[i]}) is not above stage ${i} (${value[i - 1]})`,
            });
            break;
          }
        }
      }
      return;
    }

    default:
      errors.push({ field: path, message: `unknown spec type "${spec.type}"` });
  }
}

/**
 * Cross-field coherence. These are not agronomic judgements — each one catches a
 * config that cannot mean anything sensible regardless of what is being grown.
 */
function checkCoherence(cfg, errors) {
  const t = cfg.temp ?? {};
  if (Number.isInteger(t.min_dc) && Number.isInteger(t.max_dc) && t.min_dc >= t.max_dc) {
    errors.push({
      field: 'temp.min_dc',
      message: `must be below temp.max_dc (${t.max_dc}), got ${t.min_dc}`,
    });
  }

  const h = cfg.hum ?? {};
  if (Number.isInteger(h.min_pct) && Number.isInteger(h.max_pct) && h.min_pct >= h.max_pct) {
    errors.push({
      field: 'hum.min_pct',
      message: `must be below hum.max_pct (${h.max_pct}), got ${h.min_pct}`,
    });
  }

  // soil_start is the dry threshold that starts the pump; soil_stop is the wet
  // threshold that stops it. start >= stop means the pump can never stop.
  const p = cfg.pump ?? {};
  if (
    Number.isInteger(p.soil_start_pct) &&
    Number.isInteger(p.soil_stop_pct) &&
    p.soil_start_pct >= p.soil_stop_pct
  ) {
    errors.push({
      field: 'pump.soil_start_pct',
      message: `must be below pump.soil_stop_pct (${p.soil_stop_pct}), got ${p.soil_start_pct} — the pump would never stop`,
    });
  }

  // A reading is flagged stale after sys.stale_after_s. If that is shorter than
  // the publish interval, every reading is stale on arrival.
  const s = cfg.sys ?? {};
  if (
    Number.isInteger(s.telemetry_interval_s) &&
    Number.isInteger(s.stale_after_s) &&
    s.stale_after_s <= s.telemetry_interval_s
  ) {
    errors.push({
      field: 'sys.stale_after_s',
      message: `must exceed sys.telemetry_interval_s (${s.telemetry_interval_s}), or every reading is stale on arrival`,
    });
  }

  // Shading beyond canopy.max_pct is unreachable, so a higher in-photoperiod
  // ceiling is a contradiction between the two blocks.
  const c = cfg.canopy ?? {};
  const b = cfg.arb_b ?? {};
  if (
    Number.isInteger(c.max_pct) &&
    Number.isInteger(b.max_pct_in_photo) &&
    b.max_pct_in_photo > c.max_pct
  ) {
    errors.push({
      field: 'arb_b.max_pct_in_photo',
      message: `cannot exceed canopy.max_pct (${c.max_pct}), got ${b.max_pct_in_photo}`,
    });
  }

  // step_pct larger than max_pct means the first step overshoots the ceiling.
  if (Number.isInteger(c.max_pct) && Number.isInteger(c.step_pct) && c.step_pct > c.max_pct) {
    errors.push({
      field: 'canopy.step_pct',
      message: `cannot exceed canopy.max_pct (${c.max_pct}), got ${c.step_pct}`,
    });
  }
}

/**
 * Validate a config object against contract §4.
 *
 * @param {*} cfg
 * @returns {{ field: string, message: string }[]} empty array when valid
 */
export function validateConfig(cfg) {
  const errors = [];

  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return [{ field: 'cfg', message: 'must be an object' }];
  }

  // Unknown blocks are rejected rather than ignored. A typo'd block name that
  // silently passed would produce a config that hashes fine, signs fine, and
  // means something different from what the engineer entered.
  for (const key of Object.keys(cfg)) {
    if (!(key in CONFIG_SPEC)) {
      errors.push({ field: key, message: 'is not a recognised config block' });
    }
  }

  for (const [block, fields] of Object.entries(CONFIG_SPEC)) {
    const blockValue = cfg[block];
    if (blockValue === undefined || blockValue === null) {
      errors.push({ field: block, message: 'block is required' });
      continue;
    }
    if (typeof blockValue !== 'object' || Array.isArray(blockValue)) {
      errors.push({ field: block, message: 'block must be an object' });
      continue;
    }
    for (const key of Object.keys(blockValue)) {
      if (!(key in fields)) {
        errors.push({ field: `${block}.${key}`, message: 'is not a recognised field' });
      }
    }
    for (const [name, spec] of Object.entries(fields)) {
      checkField(`${block}.${name}`, spec, blockValue[name], errors);
    }
  }

  if (errors.length === 0) checkCoherence(cfg, errors);

  return errors;
}

/** Throws ValidationError if invalid. */
export function assertValidConfig(cfg) {
  const errors = validateConfig(cfg);
  if (errors.length > 0) throw new ValidationError(errors);
}

/**
 * A structurally complete config with every engineer-supplied value left null.
 *
 * This is a SHAPE, not a recommendation. Every agronomic value is null on
 * purpose — inventing setpoints is out of scope. Non-null values here are
 * either contract defaults (§4's own example) or structural constants.
 */
export function emptyConfig() {
  return {
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
}

/**
 * Is this config complete enough to publish? Distinct from valid.
 *
 * A config with nulls is VALID (storable, hashable, diffable) but not RUNNABLE —
 * the edge cannot act on a null threshold. Separating the two lets an engineer
 * save a partial draft without the server pretending it is ready for hardware.
 *
 * @returns {string[]} paths of fields still null; empty means runnable
 */
export function incompleteFields(cfg) {
  const missing = [];
  for (const [block, fields] of Object.entries(CONFIG_SPEC)) {
    const blockValue = cfg?.[block];
    if (!blockValue) continue;
    for (const [name, spec] of Object.entries(fields)) {
      // temp.min_dc is advisory only — nothing adds heat, so a null there does
      // not stop the edge from running. It is not counted as blocking.
      if (block === 'temp' && name === 'min_dc') continue;
      if (spec.nullable && blockValue[name] === null) {
        missing.push(`${block}.${name}`);
      }
    }
  }
  return missing;
}
