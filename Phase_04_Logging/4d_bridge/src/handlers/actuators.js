// up/actuators → the `actuator_state` table.
//
// One message describes the whole actuator set at an instant: seven binary
// actuators in the `a` block, plus `canopy` (positional, outside `a` because it
// is not binary) and `vent` (the derived ventilation stage).
//
// These become one row per actuator, sharing a timestamp and sequence number.
// Row-per-actuator rather than one wide row because the set will change —
// Phase 06 adds nothing here but Phase 08 might — and a schema that grows
// columns per device is a schema that needs a migration every time hardware
// changes.

import { config } from '../config.js';
import { enqueue, stats } from '../db.js';
import { log } from '../log.js';

const BINARY_ACTUATORS = [
  'pump', 's_fan', 'internal_fan', 'n_fan', 'humidifier', 'lights', 'grow_light',
];

const VALID_SRC = new Set(['auto', 'manual', 'safety']);

const intOrNull = (v) => (Number.isInteger(v) ? v : null);

export const parseActuators = (payload, receivedAt) => {
  if (payload.v !== config.schemaVersion) {
    return { error: `schema version ${payload.v}, expected ${config.schemaVersion}` };
  }
  if (!Number.isInteger(payload.seq)) {
    return { error: 'missing or non-integer seq' };
  }
  if (payload.a === null || typeof payload.a !== 'object') {
    return { error: 'missing actuator block `a`' };
  }

  const deviceTs = Number.isInteger(payload.ts) ? payload.ts : null;

  // `vent` is stamped onto every row of this message rather than stored once.
  // It is derivable from the fan states, so this is denormalisation — but the
  // contract publishes it because it is the value the control policy actually
  // acted on, and a conflict query asking "what stage were we at when the
  // humidifier was suppressed" should not have to re-derive the policy's own
  // reasoning from its outputs.
  const ventStage = Number.isInteger(payload.vent) ? payload.vent : null;
  if (ventStage !== null && (ventStage < 0 || ventStage > 3)) {
    return { error: `vent stage ${ventStage} outside 0–3` };
  }

  const rows = [];

  for (const name of BINARY_ACTUATORS) {
    const a = payload.a[name];
    if (a === undefined || a === null) {
      log.warn('actuators', 'actuator missing from payload', { actuator: name, seq: payload.seq });
      continue;
    }
    if (typeof a.on !== 'boolean') {
      return { error: `${name}: 'on' must be boolean, got ${typeof a.on}` };
    }
    const src = a.src ?? 'auto';
    if (!VALID_SRC.has(src)) {
      return { error: `${name}: invalid src '${src}'` };
    }

    // ovr_s is present only while src is manual — the contract omits it
    // otherwise rather than sending a meaningless zero.
    const ovrS = src === 'manual' ? intOrNull(a.ovr_s) : null;

    rows.push([receivedAt, deviceTs, config.greenhouseId, payload.seq, name,
      a.on, null, src, intOrNull(a.for_s), ovrS, ventStage]);
  }

  const canopy = payload.canopy;
  if (canopy && typeof canopy === 'object') {
    const src = canopy.src ?? 'auto';
    if (!VALID_SRC.has(src)) {
      return { error: `canopy: invalid src '${src}'` };
    }
    const pos = intOrNull(canopy.pos);
    if (pos !== null && (pos < 0 || pos > 100)) {
      return { error: `canopy: pos ${pos} outside 0–100` };
    }

    // is_on is null for the canopy: it is positional, and forcing it into a
    // boolean would mean inventing a threshold that means nothing physically.
    //
    // `target` and `moving` are NOT stored — the schema has no column for them.
    // Both are transient: `moving` is true for under a second per adjustment,
    // and `target` equals `pos` except during that window. Neither answers a
    // Phase 04 conflict question. Noted here so the omission is a decision on
    // record rather than something to rediscover later.
    rows.push([receivedAt, deviceTs, config.greenhouseId, payload.seq, 'canopy',
      null, pos, src, null, src === 'manual' ? intOrNull(canopy.ovr_s) : null, ventStage]);
  }

  if (rows.length === 0) {
    return { error: 'no recognisable actuators in payload' };
  }

  return { rows };
};

const COLUMNS = 11;

const buildInsert = (rows) => {
  const placeholders = rows
    .map((_, i) => {
      const b = i * COLUMNS;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, ` +
        `$${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11})`;
    })
    .join(', ');

  return {
    text: `INSERT INTO actuator_state
             (time, device_ts, greenhouse_id, seq, actuator,
              is_on, position_pct, src, for_s, ovr_s, vent_stage)
           VALUES ${placeholders}
           ON CONFLICT DO NOTHING`,
    values: rows.flat(),
  };
};

export const handleActuators = (payload, receivedAt) => {
  const { rows, error } = parseActuators(payload, receivedAt);
  if (error) {
    stats.rejectedInvalid += 1;
    log.error('actuators', `rejected message: ${error}`, { seq: payload?.seq });
    return;
  }

  enqueue(`actuators seq=${payload.seq}`, async (client) => {
    const seen = await client.query(
      `SELECT 1 FROM actuator_state
        WHERE greenhouse_id = $1 AND seq = $2
          AND time > now() - ($3 || ' minutes')::interval
        LIMIT 1`,
      [config.greenhouseId, payload.seq, String(config.dedupWindowMinutes)]
    );

    if (seen.rowCount > 0) {
      stats.skippedDuplicate += 1;
      log.debug('actuators', 'duplicate suppressed', { seq: payload.seq });
      return;
    }

    const { text, values } = buildInsert(rows);
    await client.query(text, values);
    log.debug('actuators', 'wrote state', { seq: payload.seq, rows: rows.length });
  });
};
