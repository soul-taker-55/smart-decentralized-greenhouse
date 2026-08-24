// up/telemetry → the `telemetry` table.
//
// One message carries eleven readings. They are written as one multi-row INSERT
// rather than eleven round trips: the readings share a timestamp and a sequence
// number, and splitting them across statements would let a failure leave a
// message half-recorded.

import { config } from '../config.js';
import { enqueue, stats } from '../db.js';
import { log } from '../log.js';

// Units come from the contract (§3.1), not from the payload. The edge does not
// transmit units — sending eleven unit strings thirty times a minute to say
// what the contract already fixes would be waste. The bridge is the one place
// that knows the mapping, which also means a unit change is a bridge change and
// shows up in one diff.
const SENSOR_UNITS = {
  temp_in: 'C',
  temp_out: 'C',
  press_in: 'hPa',
  press_out: 'hPa',
  hum_in: '%RH',
  hum_out: '%RH',
  aq: 'adc',
  light_in: 'adc',
  light_out: 'adc',
  soil: '%',
  water: '%',
};

const EXPECTED_SENSORS = Object.keys(SENSOR_UNITS);
const VALID_QUALITY = new Set(['ok', 'stale', 'fail', 'init']);
const NULL_QUALITY = new Set(['fail', 'init']);

/**
 * Validate one message against the contract. Returns { rows } or { error }.
 *
 * Validation happens before anything touches the database. The schema has a
 * CHECK constraint enforcing the null rule, so an invalid payload would be
 * rejected anyway — but it would be rejected as an opaque constraint violation
 * at write time, long after the context that would explain it is gone. Checking
 * here means the log line names the sensor and the reason.
 */
export const parseTelemetry = (payload, receivedAt) => {
  if (payload.v !== config.schemaVersion) {
    return { error: `schema version ${payload.v}, expected ${config.schemaVersion}` };
  }
  if (!Number.isInteger(payload.seq)) {
    return { error: 'missing or non-integer seq' };
  }
  if (payload.r === null || typeof payload.r !== 'object') {
    return { error: 'missing readings block `r`' };
  }

  const tsQuality = payload.tsq === 'boot' ? 'boot' : 'ntp';
  const deviceTs = Number.isInteger(payload.ts) ? payload.ts : null;
  const rows = [];

  for (const sensor of EXPECTED_SENSORS) {
    const reading = payload.r[sensor];

    // A missing sensor is not an error worth discarding the message for — the
    // other ten readings are still evidence. Record it as `init`, which is
    // exactly what "never successfully read" means, and move on.
    if (reading === undefined || reading === null) {
      rows.push([receivedAt, deviceTs, tsQuality, config.greenhouseId, payload.seq,
        sensor, null, SENSOR_UNITS[sensor], 'init']);
      continue;
    }

    const q = reading.q;
    if (!VALID_QUALITY.has(q)) {
      return { error: `${sensor}: invalid quality flag '${q}'` };
    }

    const valueGiven = reading.val !== undefined && reading.val !== null;

    // The null rule, stated in the contract and enforced by the schema: when
    // quality is fail or init the value is null, never a sentinel. A sentinel
    // like 0 or -127 survives into averages and corrupts the dataset quietly.
    if (NULL_QUALITY.has(q) && valueGiven) {
      return { error: `${sensor}: q='${q}' must carry val=null, got ${reading.val}` };
    }
    if (!NULL_QUALITY.has(q) && !valueGiven) {
      return { error: `${sensor}: q='${q}' requires a value, got null` };
    }
    if (valueGiven && typeof reading.val !== 'number') {
      return { error: `${sensor}: val must be a number, got ${typeof reading.val}` };
    }

    rows.push([receivedAt, deviceTs, tsQuality, config.greenhouseId, payload.seq,
      sensor, valueGiven ? reading.val : null, SENSOR_UNITS[sensor], q]);
  }

  const unexpected = Object.keys(payload.r).filter((k) => !SENSOR_UNITS[k]);
  if (unexpected.length > 0) {
    // Not fatal. A firmware version that adds a sensor should not stop the
    // bridge writing the ten it already understands.
    log.warn('telemetry', 'ignoring unrecognised sensors', { unexpected });
  }

  return { rows };
};

const COLUMNS = 9;

const buildInsert = (rows) => {
  const placeholders = rows
    .map((_, i) => {
      const base = i * COLUMNS;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    })
    .join(', ');

  return {
    text: `INSERT INTO telemetry
             (time, device_ts, ts_quality, greenhouse_id, seq, sensor_name, value, unit, quality_flag)
           VALUES ${placeholders}
           ON CONFLICT DO NOTHING`,
    values: rows.flat(),
  };
};

export const handleTelemetry = (payload, receivedAt) => {
  const { rows, error } = parseTelemetry(payload, receivedAt);
  if (error) {
    stats.rejectedInvalid += 1;
    log.error('telemetry', `rejected message: ${error}`, { seq: payload?.seq });
    return;
  }

  enqueue(`telemetry seq=${payload.seq}`, async (client) => {
    // Duplicate check before the write. The unique index on
    // (time, greenhouse_id, sensor_name, seq) cannot catch a QoS redelivery on
    // its own, because `time` is the bridge's receipt time and a redelivered
    // message is received at a different instant. See README, "Deduplication".
    const seen = await client.query(
      `SELECT 1 FROM telemetry
        WHERE greenhouse_id = $1 AND seq = $2
          AND time > now() - ($3 || ' minutes')::interval
        LIMIT 1`,
      [config.greenhouseId, payload.seq, String(config.dedupWindowMinutes)]
    );

    if (seen.rowCount > 0) {
      stats.skippedDuplicate += 1;
      log.debug('telemetry', 'duplicate suppressed', { seq: payload.seq });
      return;
    }

    const { text, values } = buildInsert(rows);
    await client.query(text, values);
    log.debug('telemetry', 'wrote readings', { seq: payload.seq, rows: rows.length });
  });
};
