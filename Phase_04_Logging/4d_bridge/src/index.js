// SDIGF MQTT→Postgres bridge — Phase 04d
//
// Subscribes to the edge→server topics defined in the frozen MQTT contract
// (Phase_04_Logging/4b_contracts/mqtt_contract_v3.md) and writes what arrives
// into TimescaleDB.
//
// The bridge is a read-only observer. It never publishes to down/config or
// down/cmd, and it holds no broker credential that would let it. Command
// publication belongs to the Phase 05a service layer. This is why the logging
// tier can be described as having no path to an actuator — not as a policy, but
// as an absence of code.
//
// It is also not in the control path. If this process dies, the greenhouse
// keeps running: the edge tier is autonomous by design, and the only thing lost
// is the record.

import mqtt from 'mqtt';
import { config, topics, subscriptions } from './config.js';
import { log } from './log.js';
import { pool, stats, queueDepth, shutdownDb } from './db.js';
import { handleTelemetry } from './handlers/telemetry.js';
import { handleActuators } from './handlers/actuators.js';
import { handleHealth, handleStatus, handleAck } from './handlers/events.js';

// ---------------------------------------------------------------------------
// Startup: prove the database is reachable before connecting to the broker
// ---------------------------------------------------------------------------
//
// Connecting to MQTT first would mean the buffer starts filling with messages
// the bridge may have no ability to store — and if the credentials or database
// name are wrong, that failure would surface minutes later as a queue depth
// warning rather than immediately as what it is.

const verifyDatabase = async () => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT
         (SELECT count(*) FROM information_schema.tables
           WHERE table_name IN ('telemetry','actuator_state','edge_events')) AS tables_present`
    );
    if (Number(rows[0].tables_present) !== 3) {
      throw new Error(
        'schema incomplete — expected telemetry, actuator_state and edge_events. ' +
        'Apply Phase_04_Logging/db/sdigf-db-schema-v2.sql first.'
      );
    }
    log.info('db', `connected to ${config.pg.database} at ${config.pg.host}:${config.pg.port}`);
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// MQTT
// ---------------------------------------------------------------------------

const routes = new Map([
  [topics.telemetry, handleTelemetry],
  [topics.actuators, handleActuators],
  [topics.health, handleHealth],
  [topics.ack, handleAck],
  [topics.status, handleStatus],
]);

let client;

const start = () => {
  client = mqtt.connect({
    host: config.mqtt.host,
    port: config.mqtt.port,
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: config.mqtt.clientId,

    // Persistent session. QoS 1 traffic — actuator state, acks, status — is
    // queued by the broker while the bridge is restarting and delivered on
    // reconnect. Telemetry is QoS 0 and is not queued, which is the correct
    // trade: a gap in a 30-second sensor series is recoverable, a missing
    // CONFIG_APPLIED event is not.
    clean: false,

    reconnectPeriod: 5000,
    connectTimeout: 30_000,
  });

  client.on('connect', (connack) => {
    const sessionPresent = Boolean(connack && connack.sessionPresent);
    log.info(
      'mqtt',
      `connected to ${config.mqtt.host}:${config.mqtt.port} as ${config.mqtt.clientId}`,
      { sessionPresent }
    );

    client.subscribe(
      subscriptions.map((s) => s.topic),
      { qos: 1 },
      (err, granted) => {
        if (err) {
          log.error('mqtt', 'subscribe failed', { message: err.message });
          return;
        }

        // mqtt.js short-circuits subscribe() when every topic is already in its
        // internal resubscribe table, invoking this callback with an empty
        // `granted` array and sending no SUBSCRIBE packet. That happens on every
        // reconnect. The subscription is still live — either the broker session
        // survived, or mqtt.js already resubscribed internally on its own — but
        // without this branch the log simply goes quiet, which reads exactly like
        // a failure and cost real time to diagnose once already.
        if (!granted || granted.length === 0) {
          log.info('mqtt', 'subscriptions already active, no SUBSCRIBE re-sent', {
            sessionPresent,
            topics: subscriptions.length,
          });
          return;
        }

        // Granted QoS below what was requested means the broker ACL is narrower
        // than expected. Worth surfacing: it would otherwise present later as
        // messages that silently never arrive.
        granted.forEach((g) => log.info('mqtt', `subscribed ${g.topic} qos=${g.qos}`));
      }
    );
  });

  client.on('message', (topic, buffer) => {
    // One receipt timestamp per message, taken once, applied to every row it
    // produces. The device's own clock is preserved in `device_ts` but never
    // drives the time axis: without NTP the ESP32 reports boot-relative
    // seconds, and a time column whose meaning changes with a flag is a time
    // column nobody can safely aggregate over.
    const receivedAt = new Date();

    const handler = routes.get(topic);
    if (!handler) {
      log.warn('mqtt', 'message on unrouted topic', { topic });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(buffer.toString());
    } catch (err) {
      stats.rejectedInvalid += 1;
      log.error('mqtt', 'malformed JSON, discarded', {
        topic,
        bytes: buffer.length,
        message: err.message,
      });
      return;
    }

    try {
      handler(payload, receivedAt);
    } catch (err) {
      // A handler throwing is a bug, not a data problem. Log it with the topic
      // and keep the process alive — dropping one message is better than
      // stopping the record entirely.
      stats.rejectedInvalid += 1;
      log.error('mqtt', 'handler threw', { topic, message: err.message, stack: err.stack });
    }
  });

  client.on('reconnect', () => log.warn('mqtt', 'reconnecting'));
  client.on('offline', () => log.warn('mqtt', 'offline'));
  client.on('error', (err) => log.error('mqtt', 'client error', { message: err.message }));
};

// ---------------------------------------------------------------------------
// Periodic status line
// ---------------------------------------------------------------------------
//
// One line every five minutes. Enough to see at a glance whether the bridge is
// writing, buffering or dropping, without having to query the database to find
// out whether the thing recording the database is alive.

const statusTimer = setInterval(() => {
  log.info('bridge', 'status', {
    written: stats.written,
    duplicatesSkipped: stats.skippedDuplicate,
    rejected: stats.rejectedInvalid,
    dropped: stats.dropped,
    queueDepth: queueDepth(),
  });
}, 300_000);

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('bridge', `received ${signal}, shutting down`);

  clearInterval(statusTimer);
  if (client) client.end(false);

  // Flush what is buffered before the process exits. Bounded inside shutdownDb
  // so a database that is already gone cannot hold the container open.
  await shutdownDb();
  log.info('bridge', 'stopped', { written: stats.written, dropped: stats.dropped });
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------

verifyDatabase()
  .then(start)
  .catch((err) => {
    log.error('bridge', 'startup failed', { message: err.message });
    process.exit(1);
  });
