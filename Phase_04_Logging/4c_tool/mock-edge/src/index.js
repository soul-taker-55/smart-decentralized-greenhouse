// SDIGF mock edge node — Stage 2
//
// Stands in for the ESP32 so the server tier can be built and demonstrated
// before firmware exists. Contract: Phase_04_Logging/4b_contracts/
// mqtt_contract_v4.md
//
// STAGE 1 (done): connect, last will, telemetry, health, static actuators.
// STAGE 2 (this): subscribe down/config and down/cmd, validate, apply,
//                 acknowledge; per-actuator overrides with edge-local expiry.
//
// STILL NOT IMPLEMENTED, DELIBERATELY:
//   - Signature verification. Phase 03 firmware work. This mock reports
//     `verify: "unsupported"` for as long as it exists, and that is the
//     CORRECT reading on the dashboard rather than a fault.
//   - A rule arbiter or threshold control loop. Stage 2's job is the
//     validate-apply-ack LOOP, not autonomous behaviour. Actuator states stay
//     simple; the applied config is reflected where it is cheap to do so, and
//     overrides are honoured.
//   - Physics. Actuators do not yet affect the simulated environment.
//
// WHY THIS FILE MATTERS BEYOND THE DEMO: the handling in src/handlers.js is the
// direct reference Phase 02 firmware ports to C++.

import mqtt from 'mqtt';
import { config, topics } from './config.js';
import { Environment } from './environment.js';
import { EdgeState } from './state.js';
import { handleConfig, handleCommand } from './handlers.js';

const bootTime = Date.now();
let seq = 0;
let reconnectCount = 0;

const env = new Environment();
const state = new EdgeState();

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

/**
 * Actuator state.
 *
 * Stage 2 has no control loop, so autonomous state stays off. What IS real is
 * the override layer: an overridden actuator reports `src: 'manual'` and the
 * remaining seconds in `ovr_s`.
 *
 * `ovr_s` IS THE DEVICE'S OWN COUNTDOWN. The dashboard displays this rather
 * than computing issued_at + ttl_s, because only the device knows how much time
 * is actually left. A server-side estimate drifts on clock skew and keeps
 * counting confidently while the device is unreachable — precisely when it is
 * least entitled to.
 */
const relayState = (name) => {
  const o = state.getOverride(name);
  if (!o) {
    return { on: false, src: 'auto', for_s: uptimeSeconds() };
  }
  return {
    on: o.action === 'on',
    src: 'manual',
    for_s: Math.floor((Date.now() - (o.expiresAt - o.ttl_s * 1000)) / 1000),
    ovr_s: state.remainingSeconds(name),
  };
};

const actuatorPayload = () => {
  const canopyOverride = state.getOverride('canopy');
  const relays = {};
  for (const name of ['pump', 's_fan', 'internal_fan', 'n_fan', 'humidifier', 'lights', 'grow_light']) {
    relays[name] = relayState(name);
  }

  // Ventilation stage is published explicitly even though it is derivable from
  // the three fan booleans, so the server never reimplements the mapping and
  // the two cannot drift apart.
  const vent = ['s_fan', 'internal_fan', 'n_fan'].filter((f) => relays[f].on).length;

  return {
    ...envelope(),
    a: relays,
    canopy: canopyOverride
      ? {
          pos: canopyOverride.value ?? 0,
          target: canopyOverride.value ?? 0,
          moving: false,
          src: 'manual',
          ovr_s: state.remainingSeconds('canopy'),
        }
      : { pos: 0, target: 0, moving: false, src: 'auto' },
    vent,
  };
};

const healthPayload = () => ({
  ...envelope(),
  up_s: uptimeSeconds(),
  // No real radio. -50 is a plausible strong signal; the shape matters.
  rssi: -50,
  heap: Math.round(process.memoryUsage().heapUsed),
  heap_min: Math.round(process.memoryUsage().heapUsed),
  fw: config.firmwareVersion,
  //
  // `verify` is required by contract v4 §3.4 and is DECLARED BY THE DEVICE,
  // never supplied by the server — a server-settable flag could be switched off
  // by exactly the adversary edge verification defends against. The mock has no
  // signature verification and never will: it stands in for firmware, and
  // claiming `enforced` here would put a false capability into the event log and
  // onto the 05a dashboard. It reports `unsupported` for as long as it exists.
  //
  // The field must be PRESENT rather than omitted. An absent field reads as
  // "unknown" downstream, which is a third state the contract does not define.
  //
  // ver/hash/src now report what was actually applied, not a fixed zero. `src`
  // is 'none' before any config arrives — a real state, not a placeholder.
  cfg: {
    ver: state.applied.ver,
    hash: state.applied.hash,
    src: state.applied.src,
    verify: 'unsupported',
  },
  mqtt_reconnects: reconnectCount,
  boot_reason: 'power_on',
});

/**
 * Acknowledgement, contract §3.4.
 *
 * "The most important payload in the contract" — it is what proves the hardware
 * is running exactly what was approved.
 *
 * `ref` and `applied` are the same on success and deliberately different on
 * rejection: together they state both what was SENT and what is actually
 * RUNNING. Without that separation, "the hardware is running exactly what was
 * approved" is an unverifiable claim.
 */
const configAckPayload = (outcome) => ({
  ...envelope(),
  ref: outcome.ref,
  result: outcome.result,
  applied: outcome.applied,
  verify: 'unsupported',
  // Empty when verification is unsupported, per §3.4. Never omitted.
  verified_by: [],
  reason: outcome.reason,
});

/**
 * Acknowledgement for a manual command.
 *
 * ⚠ CONTRACT GAP, FLAG FOR v5. §3.4 defines `up/ack` with `ref: {ver, hash}` —
 * config-shaped, with nowhere to put a command `id`. §3.7 defines commands
 * carrying an `id` "to enable idempotency and correlation with the event log"
 * but never says how that correlation is acknowledged.
 *
 * Resolved here by carrying `id` at the top level and setting `ref` to null.
 * A consumer discriminates on which is present. This matches what the 05a
 * backend's recordAck() already reads, so nothing needs retrofitting — but the
 * contract should say so explicitly rather than leaving each implementer to
 * invent it.
 */
const commandAckPayload = (outcome) => ({
  ...envelope(),
  id: outcome.id,
  ref: null,
  result: outcome.result,
  applied: outcome.applied,
  verify: 'unsupported',
  verified_by: [],
  reason: outcome.reason,
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

  // Subscribe BEFORE announcing readiness. down/config is retained, so the
  // broker delivers the current configuration immediately on subscribe — which
  // is exactly how a real ESP32 picks up its config after a power cut without
  // the server having to detect the reconnection.
  client.subscribe([topics.config, topics.cmd], { qos: 1 }, (err, granted) => {
    if (err) {
      console.error('[mqtt] subscribe failed:', err.message);
      return;
    }
    for (const g of granted ?? []) {
      // Granted QoS 128 means the broker REFUSED the subscription — an ACL
      // denial. It arrives looking like success unless checked.
      if (g.qos === 128) {
        console.error(`[mqtt] subscription DENIED for ${g.topic} — check the broker ACL for ${config.mqtt.username}`);
      } else {
        console.log(`[mqtt] subscribed ${g.topic} qos=${g.qos}`);
      }
    }
  });

  publish(topics.actuators, actuatorPayload(), { qos: 1, retain: true });
  publish(topics.health, healthPayload(), { qos: 0, retain: true });

  startPublishing();
});

client.on('message', (topic, raw) => {
  if (topic === topics.config) {
    const outcome = handleConfig(raw, state, config.greenhouseId);

    // A cleared retained message is not a config and is not acked — there is
    // nothing to acknowledge and no version to report against.
    if (outcome.result === 'ignored') {
      console.log(`[config] ${outcome.reason.detail}`);
      return;
    }

    if (outcome.result === 'accepted') {
      console.log(
        `[config] ACCEPTED ver=${outcome.applied.ver} hash=${String(outcome.applied.hash).slice(0, 12)}…` +
          (outcome.cancelledOverrides?.length
            ? ` — cancelled ${outcome.cancelledOverrides.length} override(s): ${outcome.cancelledOverrides.join(', ')}`
            : '')
      );
    } else {
      // Log the decision point, not just the failure: an operator reading this
      // needs to know WHY, and the field path is what makes it actionable.
      console.warn(
        `[config] REJECTED ${outcome.reason.code}` +
          (outcome.reason.field ? ` at ${outcome.reason.field}` : '') +
          ` — ${outcome.reason.detail} (still running ver ${outcome.applied.ver})`
      );
    }

    publish(topics.ack, configAckPayload(outcome), { qos: 1, retain: false });
    publish(topics.actuators, actuatorPayload(), { qos: 1, retain: true });
    publish(topics.health, healthPayload(), { qos: 0, retain: true });
    return;
  }

  if (topic === topics.cmd) {
    const outcome = handleCommand(raw, state);

    if (outcome.result === 'accepted') {
      console.log(`[cmd] ACCEPTED ${outcome.id} — ${outcome.detail}`);
    } else {
      console.warn(
        `[cmd] REJECTED ${outcome.reason.code}` +
          (outcome.reason.field ? ` at ${outcome.reason.field}` : '') +
          ` — ${outcome.reason.detail}`
      );
    }

    publish(topics.ack, commandAckPayload(outcome), { qos: 1, retain: false });
    publish(topics.actuators, actuatorPayload(), { qos: 1, retain: true });
  }
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

  // ── Override expiry ───────────────────────────────────────────────────────
  //
  // EDGE-LOCAL, AND THAT IS THE WHOLE POINT. This timer does not wait for a
  // release command, does not re-fetch from the server, and is unaffected by
  // MQTT dropping mid-override. An unreachable server never means a stuck
  // actuator.
  //
  // The consequence worth arguing in the thesis: every command in this system
  // is inherently temporary, so the blast radius of any command — human or
  // AI-issued — is bounded BY DESIGN rather than by trust. Nothing has to
  // behave correctly for an override to end; the timer simply expires.
  timers.push(
    setInterval(() => {
      const expired = state.expireOverrides();
      if (expired.length > 0) {
        console.log(`[override] expired, back to autonomous control: ${expired.join(', ')}`);
      }
      // Publish promptly on any override change so the dashboard reflects it
      // without waiting for the next scheduled actuator message.
      if (state.takeDirty()) {
        publish(topics.actuators, actuatorPayload(), { qos: 1, retain: true });
      }
    }, 1000)
  );

  console.log(
    `[mock] publishing telemetry every ${config.telemetryIntervalS}s, health every ${config.healthIntervalS}s, ` +
      `checking override expiry every 1s`
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
//
// Overrides are NOT persisted, matching contract §3.7 rule 5: overrides do not
// survive reboot. An operator override silently persisting across a power cut
// is how a pump ends up running unattended.
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
