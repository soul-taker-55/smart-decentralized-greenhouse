/**
 * Integration tests for the config service, against a REAL Postgres database
 * with the actual migrations applied.
 *
 * Not mocked, on purpose. The single most important guarantee in this phase —
 * exactly one ACTIVE profile — lives in a partial unique index, not in
 * application code. A mocked database would test the mock's opinion of that
 * constraint rather than the constraint.
 *
 * Requires: PG_* env vars pointing at a database with 001 and 002 applied.
 * Skipped automatically when SDIGF_TEST_DB is unset, so `npm test` still runs
 * clean on a machine with no database.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const HAS_DB = process.env.SDIGF_TEST_DB === '1';

// Importing the service pulls in config.js, which throws on missing PG_PASS.
// Guard the import so the suite skips cleanly rather than crashing.
let svc, db;
if (HAS_DB) {
  svc = await import('../src/services/config-service.js');
  db = await import('../src/db.js');
}

/** A structurally valid config. Values arbitrary — not agronomic advice. */
function sampleConfig(overrides = {}) {
  return {
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
}

if (HAS_DB) {
  beforeEach(async () => {
    await db.query('DELETE FROM server_events');
    await db.query('DELETE FROM config_profiles');
  });

  after(async () => {
    await db.closePools();
  });

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  test('createProfile stores canonical string and hash', async () => {
    const p = await svc.createProfile(sampleConfig(), { name: 'first' });
    assert.equal(p.status, 'DRAFT');
    assert.equal(p.ver, 1);
    assert.match(p.cfgHash, /^[0-9a-f]{64}$/);
    assert.ok(p.cfgCanonical.startsWith('{"cfg":'));
    // gh and ver are inside the signed content, not only the envelope.
    assert.ok(p.cfgCanonical.includes('"gh":"gh1"'));
    assert.ok(p.cfgCanonical.includes('"ver":1'));
  });

  test('createProfile assigns monotonic versions', async () => {
    const a = await svc.createProfile(sampleConfig());
    const b = await svc.createProfile(sampleConfig());
    const c = await svc.createProfile(sampleConfig());
    assert.deepEqual([a.ver, b.ver, c.ver], [1, 2, 3]);
  });

  test('concurrent creates do not collide on version', async () => {
    // The advisory lock is what makes this pass. Without it, both reads see the
    // same MAX(ver) and one loses to UNIQUE(gh_id, ver).
    const results = await Promise.all([
      svc.createProfile(sampleConfig()),
      svc.createProfile(sampleConfig()),
      svc.createProfile(sampleConfig()),
      svc.createProfile(sampleConfig()),
      svc.createProfile(sampleConfig()),
    ]);
    const vers = results.map((r) => r.ver).sort((a, b) => a - b);
    assert.deepEqual(vers, [1, 2, 3, 4, 5]);
  });

  test('createProfile rejects an invalid config and writes nothing', async () => {
    const bad = sampleConfig();
    bad.temp.hyst_dc = 1.5;
    await assert.rejects(() => svc.createProfile(bad), /validation failed/);
    const all = await svc.listProfiles();
    assert.equal(all.length, 0);
  });

  test('createProfile emits CONFIG_CREATED', async () => {
    const p = await svc.createProfile(sampleConfig(), { name: 'evented' });
    const events = await svc.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'CONFIG_CREATED');
    assert.equal(events[0].refId, p.id);
    assert.equal(events[0].actorId, null, '05a has no auth — actor must be null');
  });

  test('a config with nulls is valid but reported incomplete', async () => {
    const partial = sampleConfig();
    partial.pump.max_runtime_s = null;
    const p = await svc.createProfile(partial);
    assert.ok(p.incomplete.includes('pump.max_runtime_s'));
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  test('DRAFT to PROPOSED to APPROVED to ACTIVE', async () => {
    const p = await svc.createProfile(sampleConfig());
    assert.equal((await svc.proposeProfile(p.id)).status, 'PROPOSED');
    assert.equal((await svc.approveProfile(p.id)).status, 'APPROVED');
    const { activated } = await svc.activateProfile(p.id);
    assert.equal(activated.status, 'ACTIVE');
  });

  test('cannot activate a DRAFT — nothing publishes before APPROVED', async () => {
    const p = await svc.createProfile(sampleConfig());
    await assert.rejects(() => svc.activateProfile(p.id), svc.LifecycleError);
  });

  test('cannot approve a DRAFT without proposing first', async () => {
    const p = await svc.createProfile(sampleConfig());
    await assert.rejects(() => svc.approveProfile(p.id), svc.LifecycleError);
  });

  test('REJECTED is terminal', async () => {
    const p = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(p.id);
    await svc.rejectProfile(p.id, { reason: 'pump runtime too long' });
    await assert.rejects(() => svc.approveProfile(p.id), /terminal state/);
  });

  test('rejection reason is recorded', async () => {
    const p = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(p.id);
    await svc.rejectProfile(p.id, { reason: 'needs review' });
    const events = await svc.listEvents();
    const rej = events.find((e) => e.eventType === 'CONFIG_REJECTED');
    assert.equal(rej.detail.reason, 'needs review');
  });

  test('approve stub is marked as such in the audit trail', async () => {
    // Phase 07 must be able to distinguish a signature-less 05a approval from a
    // real M-of-N one.
    const p = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(p.id);
    await svc.approveProfile(p.id);
    const events = await svc.listEvents();
    const appr = events.find((e) => e.eventType === 'CONFIG_APPROVED');
    assert.equal(appr.detail.stub, true);
  });

  test('unknown profile id throws NotFoundError', async () => {
    await assert.rejects(() => svc.getProfile(999999), svc.NotFoundError);
  });

  // -------------------------------------------------------------------------
  // Exactly one ACTIVE — the database-level guarantee
  // -------------------------------------------------------------------------

  test('activating a second profile supersedes the first', async () => {
    const a = await svc.createProfile(sampleConfig(), { name: 'v1' });
    await svc.proposeProfile(a.id);
    await svc.approveProfile(a.id);
    await svc.activateProfile(a.id);

    const b = await svc.createProfile(sampleConfig(), { name: 'v2' });
    await svc.proposeProfile(b.id);
    await svc.approveProfile(b.id);
    const { activated, superseded } = await svc.activateProfile(b.id);

    assert.equal(activated.id, b.id);
    assert.equal(superseded.id, a.id);
    assert.equal((await svc.getProfile(a.id)).status, 'SUPERSEDED');

    const actives = await svc.listProfiles({ status: 'ACTIVE' });
    assert.equal(actives.length, 1);
    assert.equal(actives[0].id, b.id);
  });

  test('supersession emits its own event linking old to new', async () => {
    const a = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(a.id);
    await svc.approveProfile(a.id);
    await svc.activateProfile(a.id);

    const b = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(b.id);
    await svc.approveProfile(b.id);
    await svc.activateProfile(b.id);

    const events = await svc.listEvents();
    const sup = events.find((e) => e.eventType === 'CONFIG_SUPERSEDED');
    assert.equal(sup.refId, a.id);
    assert.equal(sup.detail.supersededBy, b.id);
  });

  test('activation records that it cancels manual overrides', async () => {
    // Contract §3.7 rule 7. The edge enforces it; the event explains why an
    // override ended when someone reads the audit trail later.
    const p = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(p.id);
    await svc.approveProfile(p.id);
    await svc.activateProfile(p.id);
    const events = await svc.listEvents();
    const act = events.find((e) => e.eventType === 'CONFIG_ACTIVATED');
    assert.equal(act.detail.cancelsOverrides, true);
  });

  test('getActiveProfile returns null on a fresh system', async () => {
    // Corresponds to the device reporting cfg.src "none" — first boot. This is
    // the normal current state, not an error.
    assert.equal(await svc.getActiveProfile(), null);
  });

  // -------------------------------------------------------------------------
  // Diff
  // -------------------------------------------------------------------------

  test('diff against no active profile reports hasActive false', async () => {
    const p = await svc.createProfile(sampleConfig());
    const d = await svc.diffAgainstActive(p.id);
    assert.equal(d.hasActive, false);
    assert.deepEqual(d.changes, []);
  });

  test('diff reports only changed fields with dotted paths', async () => {
    const a = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(a.id);
    await svc.approveProfile(a.id);
    await svc.activateProfile(a.id);

    const changed = sampleConfig();
    changed.temp.max_dc = 280;
    changed.pump.cooldown_s = 900;
    const b = await svc.createProfile(changed);

    const d = await svc.diffAgainstActive(b.id);
    assert.equal(d.hasActive, true);
    assert.equal(d.changes.length, 2);

    const t = d.changes.find((c) => c.field === 'temp.max_dc');
    assert.deepEqual([t.from, t.to], [260, 280]);
    assert.ok(d.changes.some((c) => c.field === 'pump.cooldown_s'));
  });

  test('identical config produces an empty diff', async () => {
    const a = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(a.id);
    await svc.approveProfile(a.id);
    await svc.activateProfile(a.id);
    const b = await svc.createProfile(sampleConfig());
    const d = await svc.diffAgainstActive(b.id);
    assert.deepEqual(d.changes, []);
  });

  test('diff detects an array change', async () => {
    const a = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(a.id);
    await svc.approveProfile(a.id);
    await svc.activateProfile(a.id);

    const changed = sampleConfig();
    changed.vent.stage_offsets_dc = [0, 25, 50];
    const b = await svc.createProfile(changed);
    const d = await svc.diffAgainstActive(b.id);
    assert.ok(d.changes.some((c) => c.field === 'vent.stage_offsets_dc'));
  });

  // -------------------------------------------------------------------------
  // TTL expiry
  // -------------------------------------------------------------------------

  test('proposals past their TTL expire', async () => {
    const p = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(p.id);
    await db.query(`UPDATE config_profiles SET ttl_expires_at = now() - interval '1 hour' WHERE id = $1`, [
      p.id,
    ]);

    const n = await svc.expireStaleProposals();
    assert.equal(n, 1);
    assert.equal((await svc.getProfile(p.id)).status, 'EXPIRED');
  });

  test('proposals without a TTL never expire', async () => {
    const p = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(p.id);
    assert.equal(await svc.expireStaleProposals(), 0);
    assert.equal((await svc.getProfile(p.id)).status, 'PROPOSED');
  });

  test('an ACTIVE profile is never expired by the sweeper', async () => {
    const p = await svc.createProfile(sampleConfig());
    await svc.proposeProfile(p.id);
    await svc.approveProfile(p.id);
    await svc.activateProfile(p.id);
    await db.query(`UPDATE config_profiles SET ttl_expires_at = now() - interval '1 hour' WHERE id = $1`, [
      p.id,
    ]);
    assert.equal(await svc.expireStaleProposals(), 0);
    assert.equal((await svc.getProfile(p.id)).status, 'ACTIVE');
  });

  // -------------------------------------------------------------------------
  // Read-only guard on the logging database
  // -------------------------------------------------------------------------

  test('queryTelemetry refuses anything that is not a read', async () => {
    // The structural guarantee: no code path from the logging tier to a write.
    await assert.rejects(
      () => db.queryTelemetry('DELETE FROM telemetry'),
      /SELECT\/WITH only/
    );
    await assert.rejects(
      () => db.queryTelemetry('UPDATE telemetry SET value = 0'),
      /SELECT\/WITH only/
    );
    await assert.rejects(
      () => db.queryTelemetry('INSERT INTO telemetry VALUES (1)'),
      /SELECT\/WITH only/
    );
  });
}
