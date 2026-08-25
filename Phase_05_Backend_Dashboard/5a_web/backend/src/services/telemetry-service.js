/**
 * SDIGF backend — telemetry read service.
 *
 * READ-ONLY. Every query here goes through db.queryTelemetry, which rejects
 * anything that is not a SELECT or WITH. The logging database belongs to the
 * 04d bridge; this service borrows it to render a dashboard and must never
 * write to it. That separation is what makes "no code path exists from the
 * logging tier to an actuator" a fact about the code rather than a promise.
 *
 * ─── EVERY READING CARRIES ITS QUALITY FLAG ────────────────────────────────
 *
 * The schema's null_rule constraint guarantees value IS NULL whenever
 * quality_flag is 'fail' or 'init'. Nothing in this service may substitute a
 * number for that null — a stale or failed reading rendered as current is the
 * single most likely way this dashboard could mislead an operator.
 *
 * ─── EMPTY IS NORMAL ───────────────────────────────────────────────────────
 *
 * The mock is stopped and no firmware exists. Empty results are the expected
 * state, not an error. Every function returns a shape the UI can render rather
 * than throwing or returning null.
 */

import { queryTelemetry } from '../db.js';
import { config } from '../config.js';

/**
 * The eleven readings, contract §3.1, grouped for the dashboard's two-column
 * inner/outer layout. Order here is display order.
 */
export const SENSOR_GROUPS = [
  {
    key: 'temperature',
    label: 'Temperature',
    unit: '°C',
    inner: 'temp_in',
    outer: 'temp_out',
  },
  {
    key: 'humidity',
    label: 'Humidity',
    unit: '%RH',
    inner: 'hum_in',
    outer: 'hum_out',
    // DHT11 is the sole humidity source and reports integers only. Rendering a
    // decimal would imply precision the sensor does not have.
    note: 'DHT11, integer only (±5% RH)',
  },
  {
    key: 'pressure',
    label: 'Pressure',
    unit: 'hPa',
    inner: 'press_in',
    outer: 'press_out',
  },
  {
    key: 'light',
    label: 'Light',
    unit: 'raw ADC',
    inner: 'light_in',
    outer: 'light_out',
    // LDRs are uncalibrated. Converting to lux would invent precision.
    note: 'Uncalibrated LDR, 0–4095',
  },
  { key: 'soil', label: 'Soil moisture', unit: '%', single: 'soil' },
  { key: 'water', label: 'Water level', unit: '%', single: 'water' },
  {
    key: 'air_quality',
    label: 'Air quality',
    unit: 'raw ADC',
    single: 'aq',
    // Load-bearing caveat, not decoration. The MQ135 cannot give calibrated
    // ppm, and a bare number invites someone to read it as one.
    note: 'MQ135 — RELATIVE TREND ONLY, never ppm',
  },
];

/** Flat list of every sensor key, for validation. */
export const SENSOR_KEYS = SENSOR_GROUPS.flatMap((g) =>
  g.single ? [g.single] : [g.inner, g.outer]
);

/**
 * Latest reading per sensor.
 *
 * Uses DISTINCT ON, which is the natural fit: one row per sensor_name, newest
 * first. Returns a map keyed by sensor name; sensors that have never reported
 * are simply absent, and the caller renders them as "no data" rather than zero.
 */
export async function getLatestReadings() {
  const r = await queryTelemetry(
    `SELECT DISTINCT ON (sensor_name)
            sensor_name, value, unit, quality_flag, time, device_ts, ts_quality, seq
     FROM telemetry
     WHERE greenhouse_id = $1
     ORDER BY sensor_name, time DESC`,
    [config.ghId]
  );

  const bySensor = {};
  for (const row of r.rows) {
    bySensor[row.sensor_name] = {
      sensor: row.sensor_name,
      // May be null. Never substitute a number — see the null rule.
      value: row.value,
      unit: row.unit,
      quality: row.quality_flag,
      time: row.time,
      deviceTs: row.device_ts,
      // 'boot' means the device had no NTP sync, so device_ts is seconds since
      // boot rather than wall-clock. Surfaced so a chart never silently plots
      // boot-relative times as absolute ones.
      tsQuality: row.ts_quality,
      seq: row.seq,
      ageSeconds: Math.floor((Date.now() - new Date(row.time).getTime()) / 1000),
    };
  }
  return bySensor;
}

/**
 * Latest readings assembled into the dashboard's panel structure.
 *
 * Returns every group whether or not data exists, so the UI renders a complete
 * set of panels with explicit empty states rather than a layout that changes
 * shape depending on what has reported.
 */
export async function getLiveState() {
  const readings = await getLatestReadings();

  const groups = SENSOR_GROUPS.map((g) => {
    const build = (key) =>
      key
        ? readings[key] ?? { sensor: key, value: null, quality: 'no_data', time: null, ageSeconds: null }
        : null;

    return {
      key: g.key,
      label: g.label,
      unit: g.unit,
      note: g.note ?? null,
      paired: !g.single,
      inner: build(g.inner),
      outer: build(g.outer),
      single: build(g.single),
    };
  });

  const times = Object.values(readings)
    .map((x) => x.time)
    .filter(Boolean);
  const newest = times.length ? new Date(Math.max(...times.map((t) => new Date(t)))) : null;

  return {
    groups,
    sensorCount: Object.keys(readings).length,
    expectedSensorCount: SENSOR_KEYS.length,
    newestReadingAt: newest,
    newestReadingAgeSeconds: newest ? Math.floor((Date.now() - newest.getTime()) / 1000) : null,
    hasData: Object.keys(readings).length > 0,
  };
}

/**
 * History for one sensor over a time window.
 *
 * `bucketMinutes` averages into buckets so a month of 30-second data does not
 * ship 90,000 points to a browser. Nulls are excluded from the average
 * automatically by SQL, which is exactly why the null rule exists — a sentinel
 * 0 or -127 would silently drag every average down.
 */
export async function getHistory(sensorName, { hours = 24, bucketMinutes = null } = {}) {
  if (!SENSOR_KEYS.includes(sensorName)) {
    throw new Error(`unknown sensor "${sensorName}" — expected one of ${SENSOR_KEYS.join(', ')}`);
  }

  // Pick a bucket that keeps any window around a few hundred points.
  const bucket = bucketMinutes ?? (hours <= 6 ? 1 : hours <= 48 ? 5 : hours <= 168 ? 30 : 180);

  const r = await queryTelemetry(
    `SELECT time_bucket($1 * interval '1 minute', time) AS bucket,
            avg(value)   AS avg_value,
            min(value)   AS min_value,
            max(value)   AS max_value,
            count(*) FILTER (WHERE quality_flag = 'ok')    AS ok_count,
            count(*) FILTER (WHERE quality_flag = 'stale') AS stale_count,
            count(*) FILTER (WHERE quality_flag IN ('fail','init')) AS bad_count
     FROM telemetry
     WHERE greenhouse_id = $2
       AND sensor_name = $3
       AND time > now() - ($4 * interval '1 hour')
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [bucket, config.ghId, sensorName, hours]
  );

  return {
    sensor: sensorName,
    hours,
    bucketMinutes: bucket,
    points: r.rows.map((row) => ({
      t: row.bucket,
      avg: row.avg_value,
      min: row.min_value,
      max: row.max_value,
      ok: Number(row.ok_count),
      stale: Number(row.stale_count),
      bad: Number(row.bad_count),
    })),
    hasData: r.rows.length > 0,
  };
}

/**
 * Latest state of every actuator, plus canopy position and vent stage.
 *
 * `ovr_s` is the device's own countdown of remaining override time. The
 * dashboard displays THAT rather than computing issued_at + ttl_s, because
 * expiry is edge-local: only the device knows how much is actually left, and a
 * server-side estimate would disagree after any clock skew or missed message.
 */
export async function getActuatorState() {
  const r = await queryTelemetry(
    `SELECT DISTINCT ON (actuator)
            actuator, is_on, position_pct, src, for_s, ovr_s, vent_stage, time, seq
     FROM actuator_state
     WHERE greenhouse_id = $1
     ORDER BY actuator, time DESC`,
    [config.ghId]
  );

  const RELAYS = ['pump', 's_fan', 'internal_fan', 'n_fan', 'humidifier', 'lights', 'grow_light'];

  const byName = {};
  let canopy = null;
  let ventStage = null;
  let newest = null;

  for (const row of r.rows) {
    if (!newest || new Date(row.time) > new Date(newest)) newest = row.time;
    if (row.vent_stage !== null && row.vent_stage !== undefined) ventStage = row.vent_stage;

    if (row.actuator === 'canopy') {
      canopy = {
        // Believed, not measured — the MG996R has no feedback. This is what the
        // firmware commanded and may not reflect physical reality if it jammed.
        positionPct: row.position_pct,
        src: row.src,
        time: row.time,
        believed: true,
      };
      continue;
    }

    byName[row.actuator] = {
      actuator: row.actuator,
      on: row.is_on,
      src: row.src,
      forSeconds: row.for_s,
      // Present only while src is 'manual'.
      overrideRemainingSeconds: row.ovr_s,
      overridden: row.src === 'manual',
      time: row.time,
    };
  }

  const relays = RELAYS.map(
    (name) =>
      byName[name] ?? {
        actuator: name,
        on: null,
        src: null,
        forSeconds: null,
        overrideRemainingSeconds: null,
        overridden: false,
        time: null,
      }
  );

  return {
    relays,
    canopy: canopy ?? { positionPct: null, src: null, time: null, believed: true },
    // Published explicitly by the device even though derivable, so the server
    // never reimplements the fan→stage mapping and the two cannot drift.
    ventStage,
    hasData: r.rows.length > 0,
    newestAt: newest,
    activeOverrides: relays.filter((a) => a.overridden).map((a) => a.actuator),
  };
}

/**
 * Most recent edge events — health, reboots, acks, config applications.
 *
 * cfg_src = 'nvs' in these rows is direct evidence of edge autonomy: the device
 * running from its own stored config rather than waiting on the server.
 */
export async function getEdgeEvents({ limit = 50 } = {}) {
  const r = await queryTelemetry(
    `SELECT id, time, event_type, seq, boot_reason, cfg_src, cfg_ver, cfg_hash, payload
     FROM edge_events
     WHERE greenhouse_id = $1
     ORDER BY time DESC
     LIMIT $2`,
    [config.ghId, limit]
  );

  return r.rows.map((row) => ({
    id: row.id,
    time: row.time,
    eventType: row.event_type,
    seq: row.seq,
    bootReason: row.boot_reason,
    cfgSrc: row.cfg_src,
    cfgVer: row.cfg_ver,
    cfgHash: row.cfg_hash,
    payload: row.payload,
  }));
}

/**
 * What the device says it is running, from the most recent health or ack event.
 *
 * `verify` is DEVICE-DECLARED and never settable by the server. With the current
 * mock it reads 'unsupported', which is correct and expected — signature
 * verification is Phase 03 firmware work. The dashboard must present that as a
 * neutral fact, not a green check and not a red alarm.
 */
export async function getEdgeConfigState() {
  const r = await queryTelemetry(
    `SELECT time, event_type, cfg_src, cfg_ver, cfg_hash, payload
     FROM edge_events
     WHERE greenhouse_id = $1
       AND event_type IN ('HEALTH', 'ACK', 'CONFIG_APPLIED', 'ONLINE')
     ORDER BY time DESC
     LIMIT 1`,
    [config.ghId]
  );

  if (r.rows.length === 0) {
    return {
      known: false,
      cfgSrc: null,
      cfgVer: null,
      cfgHash: null,
      verify: 'unknown',
      reportedAt: null,
    };
  }

  const row = r.rows[0];
  const payload = row.payload ?? {};
  // Device-declared. Three states, and 'unknown' is honest when no device has
  // ever reported — better than defaulting to something reassuring.
  const verify = payload?.cfg?.verify ?? payload?.verify ?? 'unknown';

  return {
    known: true,
    cfgSrc: row.cfg_src,
    cfgVer: row.cfg_ver,
    cfgHash: row.cfg_hash,
    verify,
    reportedAt: row.time,
    eventType: row.event_type,
  };
}

/**
 * Is the device online, and how fresh is its data?
 *
 * Two INDEPENDENT signals, deliberately not collapsed into one. A retained
 * status of 'online' alongside telemetry that stopped ten minutes ago is a real
 * state and needs to be legible as such rather than shown as a single green dot.
 */
export async function getEdgePresence() {
  const statusRow = await queryTelemetry(
    `SELECT time, event_type FROM edge_events
     WHERE greenhouse_id = $1 AND event_type IN ('ONLINE', 'OFFLINE')
     ORDER BY time DESC LIMIT 1`,
    [config.ghId]
  );

  const dataRow = await queryTelemetry(
    `SELECT max(time) AS newest FROM telemetry WHERE greenhouse_id = $1`,
    [config.ghId]
  );

  const lastStatus = statusRow.rows[0] ?? null;
  const newestTelemetry = dataRow.rows[0]?.newest ?? null;

  return {
    // null means no device has ever connected — distinct from 'offline'.
    declaredStatus: lastStatus ? (lastStatus.event_type === 'ONLINE' ? 'online' : 'offline') : null,
    declaredAt: lastStatus?.time ?? null,
    lastTelemetryAt: newestTelemetry,
    lastTelemetryAgeSeconds: newestTelemetry
      ? Math.floor((Date.now() - new Date(newestTelemetry).getTime()) / 1000)
      : null,
    everSeen: Boolean(lastStatus || newestTelemetry),
  };
}
