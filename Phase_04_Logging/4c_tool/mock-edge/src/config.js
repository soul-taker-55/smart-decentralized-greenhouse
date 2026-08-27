// SDIGF mock edge — environment configuration and topic construction.
//
// All via environment variables; nothing is hardcoded. This service has no
// database of its own — it is a pure MQTT client standing in for the ESP32 —
// so unlike the backend it holds no PG_* variables at all.

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function optionalInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${v}"`);
  }
  return n;
}

export const config = {
  schemaVersion: 1,
  firmwareVersion: optional('FW_VERSION', 'mock-0.1.0'),
  greenhouseId: optional('GH_ID', 'gh1'),

  telemetryIntervalS: optionalInt('TELEMETRY_INTERVAL_S', 10),
  healthIntervalS: optionalInt('HEALTH_INTERVAL_S', 60),

  mqtt: {
    host: required('MQTT_HOST'),
    port: optionalInt('MQTT_PORT', 1883),
    username: required('MQTT_USER'),
    password: required('MQTT_PASS'),
    clientId: optional('MQTT_CLIENT_ID', 'sdigf-mock-edge'),
  },
};

// Topic tree, contract v4 §1, built once so no topic string is ever hand-typed
// at a call site.
const base = `sdigf/v1/${config.greenhouseId}`;

export const topics = {
  telemetry: `${base}/up/telemetry`,
  actuators: `${base}/up/actuators`,
  health: `${base}/up/health`,
  ack: `${base}/up/ack`,
  status: `${base}/status`,
  config: `${base}/down/config`,
  cmd: `${base}/down/cmd`,
  estop: `${base}/down/estop`,
};
