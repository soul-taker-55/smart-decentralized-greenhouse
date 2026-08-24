// SDIGF mock edge node — Stage 1
//
// Publishes telemetry, health, and status on the frozen MQTT contract
// (Contracts/mqtt_contract_v1.md). Stands in for the ESP32 so the server tier
// can be built and demonstrated before firmware exists.
//
// Stage 1 scope: connect, last will, telemetry, health, static actuator state.
// Not yet implemented: physics, control loop, config handling, safety
// envelope, failure simulation.

import mqtt from 'mqtt';
import { config, topics } from './config.js';
import { Environment } from './environment.js';

const bootTime = Date.now();
let seq = 0;
let reconnectCount = 0;

const env = new Environment();

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

// Every edge→server message carries the same envelope so the bridge can
// validate uniformly. `tsq` is 'ntp' because this runs on a server with a real
// clock — the ESP32 will report 'boot' until NTP syncs.
const envelope = () => ({
  v: config.schemaVersion,
  ts: Math.floor(Date.now() / 1000),
  tsq: 'ntp',
  seq: ++seq,
});

const uptimeSeconds = () => Math.floor((Date.now() - bootTime) / 1000);

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

const telemetryPayload = () => ({
  ...envelope(),
  r: env.readings(),
});

// Stage 1 reports everything off. Stage 2 replaces this with real control
// state. It is published now so the bridge and dashboard have the topic
// available to build against.
const actuatorPayload = () => ({
  ...envelope(),
  a: {
    pump: { on: false, src: 'auto', for_s: uptimeSeconds() },
    s_fan: { on: false, src: 'auto', for_s: uptimeSeconds() },
    internal_fan: { on: false, src: 'auto', for_s: uptimeSeconds() },
    n_fan: { on: false, src: 'auto', for_s: uptimeSeconds() },
    humidifier: { on: false, src: 'auto', for_s: uptimeSeconds() },
    lights: { on: false, src: 'auto', for_s: uptimeSeconds() },
    grow_light: { on: false, src: 'auto', for_s: uptimeSeconds() },
  },
  canopy: { pos: 0, target: 0, moving: false, src: 'auto' },
  vent: 0,
});

const healthPayload = () => ({
  ...envelope(),
  up_s: uptimeSeconds(),
  // No real radio. -50 is a plausible strong signal; the shape matters, not
  // the value.
  rssi: -50,
  heap: Math.round(process.memoryUsage().heapUsed),
  heap_min: Math.round(process.memoryUsage().heapUsed),
  fw: config.firmwareVersion,
  // No config received yet — version 0 means "running defaults". Stage 3
  // replaces this with the config actually applied.
  cfg: { ver: 0, hash: null, src: 'none' },
  mqtt_reconnects: reconnectCount,
  boot_reason: 'power_on',
});

// ---------------------------------------------------------------------------
// MQTT
// ---------------------------------------------------------------------------

let timers = [];

const client = mqtt.connect({
  host: config.mqtt.host,
  port: config.mqtt.port,
  username: config.mqtt.username,
  password: config.mqtt.password,
  clientId: config.mqtt.clientId,
  clean: true,
  reconnectPeriod: 5000,

  // Last will. The payload is fixed at connection time and cannot carry a
  // current timestamp — the broker publishes these bytes minutes or hours
  // later. The server timestamps offline events on receipt.
  will: {
    topic: topics.status,
    payload: JSON.stringify({ v: config.schemaVersion, state: 'offline' }),
    qos: 1,
    retain: true,
  },
});

const publish = (topic, payload, { qos, retain }) => {
  client.publish(topic, JSON.stringify(payload), { qos, retain }, (err) => {
    if (err) console.error(`[publish] ${topic} failed:`, err.message);
  });
};

client.on('connect', () => {
  console.log(`[mqtt] connected to ${config.mqtt.host}:${config.mqtt.port} as ${config.mqtt.clientId}`);

  // Overwrite the retained offline message from any previous session.
  publish(
    topics.status,
    { v: config.schemaVersion, state: 'online', ts: Math.floor(Date.now() / 1000) },
    { qos: 1, retain: true }
  );

  publish(topics.actuators, actuatorPayload(), { qos: 1, retain: true });
  publish(topics.health, healthPayload(), { qos: 0, retain: true });

  startPublishing();
});

client.on('reconnect', () => {
  reconnectCount += 1;
  console.log(`[mqtt] reconnecting (attempt ${reconnectCount})`);
});

client.on('error', (err) => console.error('[mqtt] error:', err.message));
client.on('offline', () => {
  console.warn('[mqtt] offline');
  stopPublishing();
});

// ---------------------------------------------------------------------------
// Publish loops
// ---------------------------------------------------------------------------

const startPublishing = () => {
  stopPublishing();

  timers.push(
    setInterval(() => {
      env.step();
      publish(topics.telemetry, telemetryPayload(), { qos: 0, retain: false });
    }, config.telemetryIntervalS * 1000)
  );

  timers.push(
    setInterval(() => {
      publish(topics.health, healthPayload(), { qos: 0, retain: true });
    }, config.healthIntervalS * 1000)
  );

  console.log(
    `[mock] publishing telemetry every ${config.telemetryIntervalS}s, health every ${config.healthIntervalS}s`
  );
};

const stopPublishing = () => {
  timers.forEach(clearInterval);
  timers = [];
};

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

// On a clean stop, publish offline explicitly rather than relying on the last
// will — the will only fires on an *ungraceful* disconnect. Stage 4 adds a way
// to force the ungraceful path for demo purposes.
const shutdown = () => {
  console.log('[mock] shutting down');
  stopPublishing();
  publish(
    topics.status,
    { v: config.schemaVersion, state: 'offline' },
    { qos: 1, retain: true }
  );
  setTimeout(() => client.end(true, () => process.exit(0)), 300);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
