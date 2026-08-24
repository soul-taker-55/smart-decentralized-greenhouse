// Configuration for the MQTT→Postgres bridge.
//
// Everything comes from the environment so the same image runs against any
// broker or database without a rebuild. Mirrors the mock-edge convention
// deliberately: two services in the same phase should not have two different
// ways of reading their own settings.

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
    // Stable client ID. Combined with clean:false below, this gives the bridge
    // a persistent broker session: QoS 1 messages published while the bridge
    // is restarting are queued and delivered on reconnect rather than lost.
    clientId: env('MQTT_CLIENT_ID', 'sdigf-bridge'),
  },

  pg: {
    host: env('PG_HOST'),
    port: num('PG_PORT', 5432),
    user: env('PG_USER'),
    password: env('PG_PASS'),
    database: env('PG_DB'),
    max: num('PG_POOL_MAX', 4),
  },

  greenhouseId: env('GH_ID', 'gh1'),

  // Schema version from the contract envelope. Also the topic-tree version.
  schemaVersion: 1,

  // Bounded write buffer. If Postgres is unreachable the bridge holds this many
  // pending writes in memory, then starts dropping the oldest. Bounded on
  // purpose: an unbounded queue turns a database outage into an OOM kill, which
  // is a worse failure than losing telemetry that was already best-effort.
  maxQueueDepth: num('MAX_QUEUE_DEPTH', 5000),

  // How far back to look when checking whether a message has already been
  // written. QoS 1 redelivery happens within seconds of a reconnect, so this is
  // generous by orders of magnitude. See README, "Deduplication".
  dedupWindowMinutes: num('DEDUP_WINDOW_MIN', 60),

  logLevel: env('LOG_LEVEL', 'info'),
};

// Topic construction lives in one place so a typo cannot diverge between
// publisher and subscriber. Matches Phase_04_Logging/4c_tool/mock-edge/src/config.js.
const base = `sdigf/v${config.schemaVersion}/${config.greenhouseId}`;

export const topics = {
  telemetry: `${base}/up/telemetry`,
  actuators: `${base}/up/actuators`,
  health: `${base}/up/health`,
  ack: `${base}/up/ack`,
  status: `${base}/status`,
};

// The bridge subscribes to the edge→server direction only.
//
// It deliberately does NOT subscribe to down/config or down/cmd, and it never
// publishes anything at all. Command publication belongs to the Phase 05a
// service layer. Keeping the logging tier read-only means there is no code path
// from the database to an actuator — a property worth being able to state
// plainly rather than argue for.
export const subscriptions = [
  { topic: topics.telemetry, qos: 0 },
  { topic: topics.actuators, qos: 1 },
  { topic: topics.health, qos: 0 },
  { topic: topics.ack, qos: 1 },
  { topic: topics.status, qos: 1 },
];
