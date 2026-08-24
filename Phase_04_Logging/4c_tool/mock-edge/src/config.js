// Configuration for the mock edge node.
// Everything comes from the environment so the same image runs against
// any broker without a rebuild.

const env = (key, fallback) => {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return fallback;
  }
  return value;
};

const num = (key, fallback) => Number(env(key, String(fallback)));

export const config = {
  mqtt: {
    host: env('MQTT_HOST'),
    port: num('MQTT_PORT', 1883),
    username: env('MQTT_USER'),
    password: env('MQTT_PASS'),
    // Fixed client ID: the real ESP32 will use a stable ID too, so persistent
    // sessions and last-will behave identically.
    clientId: env('MQTT_CLIENT_ID', 'sdigf-mock-edge'),
  },

  // Greenhouse slot in the topic tree. 'gh1' for the single enclosure.
  greenhouseId: env('GH_ID', 'gh1'),

  // Schema version from the contract envelope. Not the config version.
  schemaVersion: 1,

  // Firmware version reported in up/health. The mock reports its own version
  // so telemetry is traceable to which simulator produced it.
  firmwareVersion: env('FW_VERSION', 'mock-0.1.0'),

  // Publish intervals, seconds.
  telemetryIntervalS: num('TELEMETRY_INTERVAL_S', 10),
  healthIntervalS: num('HEALTH_INTERVAL_S', 60),
};

// Topic construction lives in one place so a typo cannot diverge between
// publishers.
const base = `sdigf/v${config.schemaVersion}/${config.greenhouseId}`;

export const topics = {
  telemetry: `${base}/up/telemetry`,
  actuators: `${base}/up/actuators`,
  health: `${base}/up/health`,
  ack: `${base}/up/ack`,
  status: `${base}/status`,
  config: `${base}/down/config`,
  cmd: `${base}/down/cmd`,
};
