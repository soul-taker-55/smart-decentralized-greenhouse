/**
 * SDIGF Phase 07 — THE TAMPER DEMONSTRATION.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHY IT IS NOT A TEST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This lives in tools/ rather than test/ on purpose. It is an EVIDENCE
 * GENERATOR, not a pass/fail gate. Its printed output is the material that goes
 * into the thesis chapter.
 *
 * The distinction is load-bearing because of SCENARIO 6, where verification
 * correctly returns ok AFTER a successful attack. Under `node --test` that would
 * read as a passing test of a failing system, or would have to be inverted into
 * an assertion that the chain failed — either way the meaning would be lost.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ NEVER RUN THIS AGAINST A REAL DATABASE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It deliberately destroys audit history. Scenario 6 in particular deletes real
 * events and rebuilds the chain over the hole — running it on a deployed system
 * would corrupt the very record the ledger exists to protect, in order to prove
 * that corruption is possible. That would be the opposite of the point.
 *
 * The guard below refuses to start unless the target database name ends with
 * `_tamperdemo`, and it creates and drops that database itself. There is no
 * flag to override it. A destructive script that can be pointed at production
 * by editing one environment variable is a script that eventually will be.
 *
 * Usage:  node tools/tamper-demo.mjs
 * Requires: a reachable Postgres superuser connection (PG_HOST/PG_USER/PG_PASS).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SIX SCENARIOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1  edit an event field           → CONTENT_CHANGED, with a field-level diff
 *   2  delete an event               → EVENT_MISSING
 *   3  edit an approval signature    → CONTENT_CHANGED — THE CROSS-TABLE REACH
 *   4  delete a ledger link          → PREV_MISMATCH at the following link
 *   5  delete a link AND its event   → UNCHAINED_EVENT — why check 5 exists
 *   6  consistent rewrite from genesis → ok, AND THAT IS THE POINT
 *
 * Scenarios 1–5 print raw findings. Scenario 6 prints its findings AND the
 * signature verification that gives them meaning: after history is destroyed,
 * the surviving approval signatures still verify against their registered public
 * keys. "History can be destroyed, approvals cannot be invented" is a claim only
 * a running verifier can establish; prose asserting it is weaker than this.
 */

import pg from 'pg';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';

// ---------------------------------------------------------------------------
// GUARD
// ---------------------------------------------------------------------------

const DB_NAME = 'sdigf_tamperdemo';

if (!DB_NAME.endsWith('_tamperdemo')) {
  console.error('refusing to run: target database name must end with _tamperdemo');
  process.exit(1);
}

const ADMIN = {
  host: process.env.PG_HOST ?? '127.0.0.1',
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER ?? 'postgres',
  password: process.env.PG_PASS ?? '',
  database: 'postgres',
};

// ---------------------------------------------------------------------------
// PRESENTATION
// ---------------------------------------------------------------------------

const line = (c = '─') => console.log(c.repeat(78));
function header(n, title) {
  console.log('');
  line('═');
  console.log(`SCENARIO ${n} — ${title}`);
  line('═');
}
function finding(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

/** The verification result, printed the way an auditor would read it. */
function report(r) {
  finding('verification', r.ok ? 'ok' : 'FAILED');
  finding('chain length', r.length);
  finding('verified through', r.verifiedThrough ?? '(none)');
  finding('realTimeFrom', r.realTimeFrom ?? 'null');
  if (r.firstFailure) {
    finding('reason', r.firstFailure.reason);
    finding('at seq', r.firstFailure.seq ?? '(not a link)');
    finding('detail', r.firstFailure.detail);
    if (r.firstFailure.diff && Object.keys(r.firstFailure.diff).length) {
      console.log('  field-level diff:');
      for (const [field, d] of Object.entries(r.firstFailure.diff)) {
        const s = String(d.stored ?? 'null');
        const c = String(d.current ?? 'null');
        console.log(`      ${field}`);
        console.log(`        stored : ${s.length > 46 ? s.slice(0, 46) + '…' : s}`);
        console.log(`        current: ${c.length > 46 ? c.slice(0, 46) + '…' : c}`);
      }
    }
  }
  if (r.unchainedEvents.length) {
    finding('unchained events', r.unchainedEvents.map((e) => e.eventId).join(', '));
  }
}

// ---------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------

async function createDatabase() {
  const admin = new pg.Client(ADMIN);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
}

async function dropDatabase() {
  const admin = new pg.Client(ADMIN);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.end();
}

export default async function main() {
  console.log('');
  line('═');
  console.log('SDIGF PHASE 07 — TAMPER DEMONSTRATION');
  line('═');
  console.log(`  disposable database: ${DB_NAME} (created and dropped by this script)`);
  console.log('');

  await createDatabase();

  // Point the application at the throwaway database BEFORE importing anything
  // that reads config — config.js loads at import time and fails fast.
  process.env.PG_DB = DB_NAME;
  process.env.MQTT_PASS ??= 'unused';
  process.env.SESSION_SECRET ??= 'x'.repeat(40);
  process.env.PG_PASS ??= '';

  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dbDir = path.resolve(here, '../../db');

  const db = await import('../src/db.js');
  for (const f of [
    '001_config_profiles.sql',
    '002_seams.sql',
    '003_auth.sql',
    '004_estop_events.sql',
    '005_farmer_delete.sql',
    '006_ledger.sql',
  ]) {
    await db.pool.query(await readFile(path.join(dbDir, f), 'utf8'));
  }
  console.log('  schema: migrations 001–006 applied');

  const L = await import('../src/services/ledger-service.js');
  const { buildLink } = await import('../src/ledger-link.js');
  const keys = await import('../src/services/key-service.js');
  const cfgs = await import('../src/services/config-service.js');
  const appr = await import('../src/services/approval-service.js');
  const cs = await import('../src/config-schema.js');

  await L.assertTimeVector();
  console.log('  frozen time vectors: verified against this database');

  // ── Seed a realistic chain through the REAL services ─────────────────────
  //
  // Not hand-written rows. Every link below was produced by the same code path
  // the deployed system uses, so what is demonstrated is the real writer.
  await db.query(`INSERT INTO users (id,email,username,role,status) VALUES
    ('eng-hala','h@x','hala','engineer','active'),
    ('eng-omar','o@x','omar','engineer','active'),
    ('farmer-ali','a@x','ali','farmer','active')`);

  const kp = {};
  for (const u of ['eng-hala', 'eng-omar']) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    kp[u] = pair;
    const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(26).toString('hex');
    await keys.registerKey({ userId: u, publicKeyHex: raw, actor: { id: u, role: 'engineer' } });
  }

  await appr.setPolicy({
    thresholdM: 1,
    proposalTtlHours: 24,
    actor: { id: 'eng-hala', role: 'engineer' },
  });

  const profile = await cfgs.createProfile(cs.emptyConfig(), {
    name: 'tamper-demo',
    actor: { id: 'eng-hala', role: 'engineer' },
  });
  await cfgs.proposeProfile(profile.id, {
    ttlHours: 24,
    actor: { id: 'eng-hala', role: 'engineer' },
  });

  const canonical = (
    await db.query('SELECT cfg_canonical FROM config_profiles WHERE id=$1', [profile.id])
  ).rows[0].cfg_canonical;

  // A GENUINE ECDSA P-256 signature over the stored canonical bytes. Scenario 3
  // and scenario 6 both depend on this being real rather than a placeholder.
  const signature = nodeSign('sha256', Buffer.from(canonical, 'utf8'), {
    key: kp['eng-omar'].privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('hex');

  await appr.castVote({
    profileId: profile.id,
    decision: 'approve',
    signatureHex: signature,
    reason: null,
    actor: { id: 'eng-omar', role: 'engineer' },
  });

  const commands = await import('../src/services/command-service.js');
  const noPublish = { publishCommand: async () => {} };
  for (const v of [20, 40, 60]) {
    await commands.issueCommand(
      { target: 'canopy', action: 'set', value: v, ttl_s: 60 },
      { actor: { id: 'farmer-ali', role: 'farmer' }, publisher: noPublish }
    );
  }

  const seeded = await L.verifyChain();
  console.log(`  seeded: ${seeded.length} links, all real-time, verification ${seeded.ok ? 'ok' : 'FAILED'}`);
  if (!seeded.ok) {
    console.error('  seed did not verify — aborting, the demonstration would be meaningless');
    process.exit(1);
  }

  // Landmarks used by the scenarios below.
  const sigLink = (
    await db.query(`SELECT l.seq, l.event_id, e.signature_ref
                      FROM ledger l JOIN server_events e ON e.id = l.event_id
                     WHERE e.signature_ref IS NOT NULL ORDER BY l.seq LIMIT 1`)
  ).rows[0];
  const midLink = (
    await db.query(`SELECT l.seq, l.event_id FROM ledger l ORDER BY l.seq OFFSET 3 LIMIT 1`)
  ).rows[0];

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — edit a field on an event
  // ═══════════════════════════════════════════════════════════════════════════
  header(1, 'EDIT AN EVENT FIELD');
  console.log(`  UPDATE server_events SET actor_id='eng-omar' WHERE id=${midLink.event_id}`);
  console.log('');
  const beforeActor = (
    await db.query('SELECT actor_id FROM server_events WHERE id=$1', [midLink.event_id])
  ).rows[0].actor_id;
  await db.query(`UPDATE server_events SET actor_id='eng-omar' WHERE id=$1`, [midLink.event_id]);
  report(await L.verifyChain());
  console.log('');
  console.log('  The diff names the field. "The chain is broken" is not actionable;');
  console.log('  "link N\'s actor_id changed from X to Y" is.');
  await db.query(`UPDATE server_events SET actor_id=$1 WHERE id=$2`, [beforeActor, midLink.event_id]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — delete an event
  // ═══════════════════════════════════════════════════════════════════════════
  header(2, 'DELETE AN EVENT, LEAVING ITS LINK');
  console.log(`  DELETE FROM server_events WHERE id=${midLink.event_id}`);
  console.log('');
  // Capture the row with its timestamps as MICROSECOND-PRECISE STRINGS.
  //
  // Reading them as JS Dates and writing them back loses microseconds — Date
  // holds milliseconds — which silently alters the event and makes every LATER
  // scenario report a spurious `time` mismatch. That happened on the first run
  // of this script and is worth recording: it is the same precision hazard that
  // made `time` a frozen STRING in the link rather than a re-derived timestamp.
  // The ledger was right; the harness restoring the fixture was not.
  const saved = (
    await db.query(
      `SELECT id, gh_id, event_type, ref_table, ref_id, actor_id, actor_role, detail, signature_ref,
              to_char(time        AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time_s,
              to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_s
         FROM server_events WHERE id=$1`,
      [midLink.event_id]
    )
  ).rows[0];
  await db.query('DELETE FROM server_events WHERE id=$1', [midLink.event_id]);
  report(await L.verifyChain());
  console.log('');
  console.log('  Reachable ONLY because ledger.event_id has no REFERENCES constraint.');
  console.log('  A foreign key there would have made this deletion impossible, and the');
  console.log('  EVENT_MISSING check unreachable dead code — the database refusing the');
  console.log('  very tamper the check exists to detect.');
  await db.query(
    `INSERT INTO server_events (id, time, recorded_at, gh_id, event_type, ref_table, ref_id,
                                actor_id, actor_role, detail, signature_ref)
     OVERRIDING SYSTEM VALUE
     VALUES ($1, $2::timestamptz, $3::timestamptz, $4,$5,$6,$7,$8,$9,$10,$11)`,
    [saved.id, saved.time_s, saved.recorded_s, saved.gh_id, saved.event_type, saved.ref_table,
     saved.ref_id, saved.actor_id, saved.actor_role, saved.detail, saved.signature_ref]
  );

  const afterRestore = await L.verifyChain();
  console.log('');
  console.log(`  [restored byte-exactly: verification ${afterRestore.ok ? 'ok' : 'FAILED — fixture damaged'}]`);

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 — edit an approval signature. THE CROSS-TABLE REACH.
  // ═══════════════════════════════════════════════════════════════════════════
  header(3, 'EDIT AN APPROVAL SIGNATURE — THE CROSS-TABLE REACH');
  console.log(`  UPDATE config_approvals SET signature='cc…' WHERE id=${sigLink.signature_ref}`);
  console.log(`  (the ledger row edited is NOT touched; only the approval it references)`);
  console.log('');
  const origSig = (
    await db.query('SELECT signature FROM config_approvals WHERE id=$1', [sigLink.signature_ref])
  ).rows[0].signature;
  await db.query('UPDATE config_approvals SET signature=$1 WHERE id=$2', [
    'c'.repeat(128),
    sigLink.signature_ref,
  ]);
  report(await L.verifyChain());
  console.log('');
  console.log('  This is the payoff of the chain-scope decision. Chaining server_events');
  console.log('  ALONE would have let approval signatures be edited freely underneath a');
  console.log('  valid-looking chain. Because signature_ref is RESOLVED and hashed into');
  console.log('  the link, an edit in a second table breaks it.');
  await db.query('UPDATE config_approvals SET signature=$1 WHERE id=$2', [
    origSig,
    sigLink.signature_ref,
  ]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 4 — delete a ledger link
  // ═══════════════════════════════════════════════════════════════════════════
  header(4, 'DELETE A LEDGER LINK');
  console.log(`  DELETE FROM ledger WHERE seq=${midLink.seq}`);
  console.log('');
  const savedLink = (await db.query('SELECT * FROM ledger WHERE seq=$1', [midLink.seq])).rows[0];
  await db.query('DELETE FROM ledger WHERE seq=$1', [midLink.seq]);
  report(await L.verifyChain());
  console.log('');
  console.log(`  Reported at seq ${midLink.seq + 1}, not ${midLink.seq}: the deleted link is simply`);
  console.log('  absent, and what is detectable is that its successor claims a previous');
  console.log('  hash nothing now has. The walk stops there — everything beyond is');
  console.log('  UNVERIFIABLE rather than wrong, and reporting it all would imply many');
  console.log('  separate incidents rather than one.');
  await db.query(
    `INSERT INTO ledger (seq,event_id,prev_hash,entry_hash,canonical,backfilled,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [savedLink.seq, savedLink.event_id, savedLink.prev_hash, savedLink.entry_hash,
     savedLink.canonical, savedLink.backfilled, savedLink.created_at]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 5 — delete a link AND its event together
  // ═══════════════════════════════════════════════════════════════════════════
  header(5, 'DELETE A LINK AND ITS EVENT TOGETHER');
  console.log('  The tidy deletion: remove the link, remove the event, leave no dangling');
  console.log('  reference. Checks 1–4 walk only the ledger and would see nothing.');
  console.log('');
  const tail = (await db.query('SELECT * FROM ledger ORDER BY seq DESC LIMIT 1')).rows[0];
  const tailEvent = (
    await db.query('SELECT * FROM server_events WHERE id=$1', [tail.event_id])
  ).rows[0];
  await db.query('DELETE FROM ledger WHERE seq=$1', [tail.seq]);
  console.log(`  DELETE FROM ledger WHERE seq=${tail.seq}   (the event row is LEFT in place)`);
  console.log('');
  report(await L.verifyChain());
  console.log('');
  console.log('  CHECK 5 IS NOT DECORATION. Without it this is undetectable. It is also');
  console.log('  computed OUTSIDE the chain walk by construction — the walk returns at its');
  console.log('  first failure, so a check that ran after it would be missing exactly when');
  console.log('  verification actually fails.');
  await db.query(
    `INSERT INTO ledger (seq,event_id,prev_hash,entry_hash,canonical,backfilled,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tail.seq, tail.event_id, tail.prev_hash, tail.entry_hash, tail.canonical,
     tail.backfilled, tail.created_at]
  );
  void tailEvent;

  const restored = await L.verifyChain();
  console.log('');
  console.log(`  [restored: verification ${restored.ok ? 'ok' : 'FAILED'}, ${restored.length} links]`);

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 6 — CONSISTENT REWRITE FROM GENESIS
  // ═══════════════════════════════════════════════════════════════════════════
  header(6, 'CONSISTENT REWRITE FROM GENESIS — THE HONEST BOUNDARY');
  console.log('  An administrator with database access deletes a range of events and');
  console.log('  rebuilds every subsequent link from genesis, using THE SAME buildLink()');
  console.log('  the legitimate writer uses. Nothing about the forged links is malformed,');
  console.log('  because nothing about them is forged — they are correctly built links');
  console.log('  over a history that has had a hole cut in it.');
  console.log('');

  const before = await L.verifyChain();
  const beforeEvents = (
    await db.query('SELECT l.seq, l.event_id, e.event_type FROM ledger l JOIN server_events e ON e.id=l.event_id ORDER BY l.seq')
  ).rows;

  console.log('  BEFORE');
  finding('links', before.length);
  finding('realTimeFrom', before.realTimeFrom ?? 'null');
  finding('verification', before.ok ? 'ok' : 'FAILED');
  console.log(`      chain: ${beforeEvents.map((r) => `${r.seq}:${r.event_type}`).join('  ')}`);
  console.log('');

  // Erase the middle of the chain: the config proposal and its approval.
  const victims = beforeEvents.filter((r) =>
    ['CONFIG_CREATED', 'CONFIG_PROPOSED', 'CONFIG_APPROVED'].includes(r.event_type)
  );
  const victimIds = victims.map((v) => v.event_id);
  console.log(`  ATTACK: erase ${victims.length} events — ${victims.map((v) => v.event_type).join(', ')}`);
  console.log(`          event_ids ${victimIds.join(', ')} deleted from server_events`);
  console.log('');

  await db.query('DELETE FROM ledger');
  await db.query(`DELETE FROM server_events WHERE id = ANY($1::bigint[])`, [victimIds]);

  // Rebuild from genesis over the surviving events, using the real builder.
  const survivors = (
    await db.query(`SELECT e.id, to_char(e.time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time_str,
                           e.gh_id, e.event_type, e.ref_table, e.ref_id, e.actor_id, e.actor_role,
                           e.detail, e.signature_ref
                      FROM server_events e ORDER BY e.id ASC`)
  ).rows;

  let prev = null;
  let seq = 1;
  for (const ev of survivors) {
    let sig = null;
    if (ev.signature_ref) {
      const a = (
        await db.query(
          'SELECT id,key_id,user_id,decision,cfg_hash,signature FROM config_approvals WHERE id=$1',
          [Number(ev.signature_ref)]
        )
      ).rows[0];
      if (a) {
        sig = {
          approval_id: Number(a.id),
          key_id: a.key_id,
          user_id: a.user_id,
          decision: a.decision,
          cfg_hash: a.cfg_hash,
          signature: a.signature,
        };
      }
    }
    const { canonical, entryHash } = buildLink({ seq, prev, event: ev, signature: sig });
    await db.query(
      `INSERT INTO ledger (seq,event_id,prev_hash,entry_hash,canonical,backfilled)
       VALUES ($1,$2,$3,$4,$5,false)`,
      [seq, ev.id, prev, entryHash, canonical]
    );
    prev = entryHash;
    seq += 1;
  }

  const after = await L.verifyChain();
  const afterEvents = (
    await db.query('SELECT l.seq, e.event_type FROM ledger l JOIN server_events e ON e.id=l.event_id ORDER BY l.seq')
  ).rows;

  console.log('  AFTER');
  finding('links', after.length);
  finding('realTimeFrom', after.realTimeFrom ?? 'null');
  finding('verification', after.ok ? 'ok' : 'FAILED');
  finding('unchained events', after.unchainedEvents.length);
  console.log(`      chain: ${afterEvents.map((r) => `${r.seq}:${r.event_type}`).join('  ')}`);
  console.log('');
  console.log(`  ${before.length - after.length} links and ${victims.length} events are gone. Verification reports ok.`);
  console.log('  SCENARIO 6 IS NOT A GAP IN THE IMPLEMENTATION. It is the honest boundary');
  console.log('  of what an UNANCHORED chain can prove: genesis anchors nothing outside');
  console.log('  the system, so a rewrite from genesis is internally consistent by');
  console.log('  construction. Closing it requires pinning the chain head somewhere');
  console.log('  outside the administrator\'s control — named as future work, not built.');
  console.log('');

  // ── WHAT SURVIVED ────────────────────────────────────────────────────────
  //
  // The claim "history can be destroyed, approvals cannot be invented" is only
  // half demonstrated by the ok above. This is the other half, and it has to be
  // MEASURED rather than asserted.
  line('─');
  console.log('  WHAT SURVIVED THE REWRITE — signatures re-verified against registered keys');
  line('─');

  const surviving = (
    await db.query(`SELECT a.id, a.user_id, a.key_id, a.decision, a.cfg_hash, a.signature,
                           k.public_key, p.cfg_canonical
                      FROM config_approvals a
                      JOIN user_keys k ON k.key_id = a.key_id
                      LEFT JOIN config_profiles p ON p.id = a.config_profile_id
                     ORDER BY a.id`)
  ).rows;

  if (surviving.length === 0) {
    console.log('  (no approvals in this dataset)');
  }
  for (const a of surviving) {
    // The config row itself was deleted by the attack; the canonical bytes the
    // signature covers are recoverable from cfg_hash only if the config
    // survives. Where it does not, verify what CAN still be verified and say so.
    if (!a.cfg_canonical) {
      console.log(`  approval ${a.id} by ${a.user_id} (key ${a.key_id})`);
      console.log(`      decision      : ${a.decision}`);
      console.log(`      cfg_hash      : ${a.cfg_hash.slice(0, 32)}…`);
      console.log(`      signature     : ${a.signature.slice(0, 32)}… (${a.signature.length} hex chars)`);
      console.log('      status        : PRESENT AND UNFORGEABLE — the signed bytes are not');
      console.log('                      recoverable because the config row was deleted, but');
      console.log('                      the signature could only have been produced by the');
      console.log('                      holder of this key over cfg_hash. The server never');
      console.log('                      held that private key and cannot have made it.');
      continue;
    }
    const v = keys.verifySignature({
      cfgCanonical: a.cfg_canonical,
      signatureHex: a.signature,
      publicKeyHex: a.public_key,
    });
    console.log(`  approval ${a.id} by ${a.user_id} (key ${a.key_id})`);
    console.log(`      decision      : ${a.decision}`);
    console.log(`      re-verified   : ${v.valid ? 'VALID' : 'INVALID — ' + v.reason}`);
    console.log(`      recomputed    : sha256(cfg_canonical) = ${createHash('sha256').update(a.cfg_canonical, 'utf8').digest('hex').slice(0, 32)}…`);
    console.log(`      stored        : cfg_hash             = ${a.cfg_hash.slice(0, 32)}…`);
  }

  console.log('');
  console.log('  THE TWO HALVES, TOGETHER:');
  console.log('    ORDERING and NARRATIVE were destroyed and the chain still reports ok.');
  console.log('    APPROVALS were not, and cannot be — a signature that was never produced');
  console.log('    cannot be fabricated by anyone, including an administrator with full');
  console.log('    database access, because the server never held the private key.');
  console.log('');
  console.log('  A reviewer will construct this attack. The work is stronger for having');
  console.log('  constructed it first.');
  console.log('');

  line('═');
  console.log('END OF DEMONSTRATION');
  line('═');
  console.log('');

  await db.closePools();
  await dropDatabase();
  console.log(`  ${DB_NAME} dropped.`);
  console.log('');
}

await main();
