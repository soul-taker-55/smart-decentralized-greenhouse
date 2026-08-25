/**
 * Integration tests for the MQTT publisher, against a REAL broker.
 *
 * The two behaviours worth testing here cannot be tested against a mock:
 *
 *   1. Read-back confirmation — does a published retained message actually come
 *      back from the broker? A mock would confirm the mock's opinion.
 *   2. Retained-message reconstruction — does the config survive a subscriber
 *      reconnecting, and does republishing restore it?
 *
 * Requires a broker at MQTT_HOST/MQTT_PORT. Skipped when SDIGF_TEST_MQTT is
 * unset, so `npm test` runs clean on a machine with no broker.
 */

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const HAS_MQTT = process.env.SDIGF_TEST_MQTT === '1';

let MqttPublisher, PublishError, topics, buildSignedContent;
if (HAS_MQTT) {
  ({ MqttPublisher, PublishError } = await import('../src/mqtt.js'));
  ({ topics } = await import('../src/config.js'));
  ({ buildSignedContent } = await import('../src/canon.js'));
}

/** Build a profile-shaped object without needing a database. */
function makeProfile(ver = 1, overrides = {}) {
  const cfg = {
    sys: { telemetry_interval_s: 30, stale_after_s: 60 },
    temp: { min_dc: 180, max_dc: 260, hyst_dc: 10 },
    hum: { min_pct: 50, max_pct: 75, hyst_pct: 5 },
    vent: { stage_offsets_dc: [0, 20, 40], min_off_s: 60 },
    pump: {
      soil_start_pct: 35,
      soil_stop_pct: 60,
      max_runtime_s: 120,
      cooldown_s: 600,
      water_min_pct: 20,
    },
    photo: { on_min: 360, off_min: 1320, tz_offset_min: 0 },
    canopy: {
      enabled_for_cooling: true,
      only_above_dc: 240,
      max_pct: 100,
      step_pct: 10,
      min_dwell_s: 30,
      max_shade_min_day: 180,
    },
    arb_a: { priority: 'temperature', fan_cap_stage: 1, max_suppress_s: 900 },
    arb_b: { priority: 'light', max_pct_in_photo: 30 },
    ...overrides,
  };
  const { cfgCanonical, cfgHash } = buildSignedContent(cfg, 'gh1', ver);
  return { id: ver, ghId: 'gh1', ver, cfg, cfgCanonical, cfgHash };
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

if (HAS_MQTT) {
  const open = [];

  async function newPublisher(opts = {}) {
    const p = new MqttPublisher({ logger: quiet, ...opts });
    await p.connect();
    open.push(p);
    return p;
  }

  beforeEach(async () => {
    // Clear any retained config left by a previous test, so each test starts
    // from a known broker state.
    const p = new MqttPublisher({ logger: quiet });
    await p.connect();
    await p.clearRetainedConfig();
    await p.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  after(async () => {
    for (const p of open) await p.close().catch(() => {});
  });

  // -------------------------------------------------------------------------
  // Publish and read-back
  // -------------------------------------------------------------------------

  test('publishConfig succeeds and is confirmed by read-back', async () => {
    const p = await newPublisher();
    const profile = makeProfile(1);
    const result = await p.publishConfig(profile);
    assert.ok(result.bytes > 0);
    // Read-back resolved, meaning the broker handed our own message back.
    assert.equal(p.lastSeen.configEcho.cfg_hash, profile.cfgHash);
  });

  test('published envelope matches contract §3.6 shape', async () => {
    const p = await newPublisher();
    const profile = makeProfile(7);
    await p.publishConfig(profile);

    const echo = p.lastSeen.configEcho;
    assert.equal(echo.v, 1);
    assert.equal(echo.gh, 'gh1');
    assert.equal(echo.ver, 7);
    assert.equal(echo.alg, 'es256');
    assert.equal(echo.cfg_hash, profile.cfgHash);
    assert.equal(echo.cfg_canonical, profile.cfgCanonical);
    assert.deepEqual(echo.sigs, []);
    assert.ok(Number.isInteger(echo.ts));
    // v4 replaced `cfg` with `cfg_canonical` and does not carry both.
    assert.equal(echo.cfg, undefined);
  });

  test('envelope ver and gh match the values inside the signed content', async () => {
    // The edge must compare these and reject on mismatch. If the publisher let
    // them drift, it would reintroduce the replay hole v4 closed.
    const p = await newPublisher();
    const profile = makeProfile(12);
    await p.publishConfig(profile);

    const echo = p.lastSeen.configEcho;
    const signed = JSON.parse(echo.cfg_canonical);
    assert.equal(echo.ver, signed.ver);
    assert.equal(echo.gh, signed.gh);
  });

  test('cfg_hash in the envelope is the hash of cfg_canonical bytes', async () => {
    const { createHash } = await import('node:crypto');
    const p = await newPublisher();
    await p.publishConfig(makeProfile(3));

    const echo = p.lastSeen.configEcho;
    const recomputed = createHash('sha256').update(echo.cfg_canonical, 'utf8').digest('hex');
    assert.equal(echo.cfg_hash, recomputed);
  });

  // -------------------------------------------------------------------------
  // Retained behaviour — the Phase 04 lesson
  // -------------------------------------------------------------------------

  test('config is retained — a fresh subscriber receives it immediately', async () => {
    const publisher = await newPublisher();
    const profile = makeProfile(5);
    await publisher.publishConfig(profile);

    // A second client, connecting after the fact, must get the config without
    // the server detecting the connection and re-pushing. That is what retained
    // buys, and why the ESP32 gets its config on reconnect for free.
    const subscriber = await newPublisher({});
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(subscriber.lastSeen.configEcho?.cfg_hash, profile.cfgHash);
  });

  test('republishing replaces the retained config', async () => {
    const p = await newPublisher();
    await p.publishConfig(makeProfile(1));
    const second = makeProfile(2);
    await p.publishConfig(second);

    const fresh = await newPublisher();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fresh.lastSeen.configEcho.ver, 2);
    assert.equal(fresh.lastSeen.configEcho.cfg_hash, second.cfgHash);
  });

  test('clearRetainedConfig removes it — a new subscriber gets nothing', async () => {
    const p = await newPublisher();
    await p.publishConfig(makeProfile(1));
    await p.clearRetainedConfig();
    await new Promise((r) => setTimeout(r, 300));

    const fresh = await newPublisher();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fresh.lastSeen.configEcho, null);
  });

  test('onRepublishNeeded fires on connect — broker state rebuilt from the database', async () => {
    // This is the mechanism that treats the retained message as a cache. If the
    // broker lost its retained set, this hook restores it without human action.
    let called = 0;
    const p = new MqttPublisher({
      logger: quiet,
      onRepublishNeeded: async () => {
        called += 1;
      },
    });
    await p.connect();
    open.push(p);
    assert.equal(called, 1, 'republish hook must fire on initial connect');
  });

  // -------------------------------------------------------------------------
  // Payload size — the silent-drop failure
  // -------------------------------------------------------------------------

  test('a normal config is well under the ESP32 2048-byte buffer', async () => {
    const p = await newPublisher();
    const { bytes } = await p.publishConfig(makeProfile(1));
    assert.ok(bytes < 1600, `expected under 1600 B, got ${bytes}`);
  });

  test('an oversized payload is refused rather than dropped silently', async () => {
    // PubSubClient's default buffer drops oversized messages with no error, no
    // callback and no disconnect. Failing here beats a device that looks like
    // it is ignoring the server.
    const p = await newPublisher();
    const profile = makeProfile(1);
    profile.cfgCanonical = '{"cfg":{"x":"' + 'A'.repeat(2500) + '"},"gh":"gh1","ver":1}';
    await assert.rejects(() => p.publishConfig(profile, { verify: false }), /2048/);
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  test('publishCommand sends a contract §3.7 envelope', async () => {
    const p = await newPublisher();
    const received = [];
    p.client.subscribe(topics.cmd, { qos: 1 });
    p.client.on('message', (t, m) => {
      if (t === topics.cmd) received.push(JSON.parse(m.toString()));
    });
    await new Promise((r) => setTimeout(r, 200));

    await p.publishCommand({ id: 'c8f21e', target: 'humidifier', action: 'on', ttl_s: 300 });
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(received.length, 1);
    assert.equal(received[0].id, 'c8f21e');
    assert.equal(received[0].target, 'humidifier');
    assert.equal(received[0].action, 'on');
    assert.equal(received[0].ttl_s, 300);
    assert.equal(received[0].v, 1);
  });

  test('canopy set command carries its value', async () => {
    const p = await newPublisher();
    const received = [];
    p.client.subscribe(topics.cmd, { qos: 1 });
    p.client.on('message', (t, m) => {
      if (t === topics.cmd) received.push(JSON.parse(m.toString()));
    });
    await new Promise((r) => setTimeout(r, 200));

    await p.publishCommand({ id: 'c1', target: 'canopy', action: 'set', value: 40, ttl_s: 600 });
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(received[0].value, 40);
  });

  test('commands are NOT retained — a fresh subscriber sees nothing', async () => {
    // Contract §3.7: a retained command would re-fire on every reconnect,
    // meaning a pump switched on last week restarts itself after a power cut.
    const p = await newPublisher();
    await p.publishCommand({ id: 'c-ghost', target: 'pump', action: 'on', ttl_s: 60 });
    await new Promise((r) => setTimeout(r, 300));

    const fresh = await newPublisher();
    const received = [];
    fresh.client.subscribe(topics.cmd, { qos: 1 });
    fresh.client.on('message', (t, m) => {
      if (t === topics.cmd) received.push(JSON.parse(m.toString()));
    });
    await new Promise((r) => setTimeout(r, 600));

    assert.equal(received.length, 0, 'commands must never be retained');
  });

  // -------------------------------------------------------------------------
  // State reporting
  // -------------------------------------------------------------------------

  test('getState reports connection status for the dashboard', async () => {
    const p = await newPublisher();
    const s = p.getState();
    assert.equal(s.connected, true);
    assert.ok(s.broker.includes(':'));
  });
}
