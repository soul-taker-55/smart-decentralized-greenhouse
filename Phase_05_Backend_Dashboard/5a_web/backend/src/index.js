/**
 * SDIGF backend — service entry point.
 *
 * Startup order is deliberate:
 *
 *   1. Verify the canonicalizer still reproduces the frozen test vector.
 *   2. Verify both databases are reachable and shaped correctly.
 *   3. Connect to the broker and republish the active config.
 *   4. Start accepting HTTP.
 *
 * Step 1 first, and fatal. A canonicalizer that has silently drifted produces
 * hashes that look perfectly valid and that no device will ever accept. Failing
 * on boot beats discovering it when a config is rejected in the field.
 *
 * Step 3 before step 4 so the broker's retained state is reconstructed from the
 * database before anyone can ask the API about it.
 */

import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import { config } from './config.js';
import { assertFrozenVector } from './canon.js';
import { checkConnections, closePools } from './db.js';
import { assertTimeVector } from './services/ledger-service.js';
import { MqttPublisher } from './mqtt.js';
import { registerRoutes } from './routes.js';
import { attachUser } from './auth.js';
import { bootstrapAdmin } from './services/identity-service.js';
import * as configService from './services/config-service.js';
import * as commandService from './services/command-service.js';
import * as estopService from './services/estop-service.js';

const app = Fastify({
  logger: {
    level: config.logLevel,
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  },
});

let publisher;

/**
 * Push the current ACTIVE config onto the broker, reconstructing retained state
 * from the database.
 *
 * Called on startup and on every broker reconnect. This is the operational form
 * of "the retained message is a cache, never a source of truth" — the Phase 04
 * retainer defect silently destroyed retained messages on restart, and while
 * storage_type is now disc, the system should survive that class of failure
 * rather than depend on a setting.
 *
 * When there is no ACTIVE profile the retained message is CLEARED, so a
 * reconnecting device is never handed a config the server no longer considers
 * current.
 */
async function republishActiveConfig() {
  const active = await configService.getActiveProfile();

  if (!active) {
    await publisher.clearRetainedConfig();
    app.log.info('no ACTIVE config — cleared retained message');
    return { republished: false, reason: 'no active config', cleared: true };
  }

  const result = await publisher.publishConfig(active);
  app.log.info(`republished ACTIVE config ver=${active.ver} (${result.bytes} B)`);
  return { republished: true, ver: active.ver, cfgHash: active.cfgHash, bytes: result.bytes };
}

async function start() {
  // ---- 1. Canonicalizer integrity -----------------------------------------
  try {
    assertFrozenVector();
    app.log.info('canonicalization verified against the frozen test vector');
  } catch (err) {
    app.log.fatal(
      `CANONICALIZATION DRIFT — ${err.message}. ` +
        `Refusing to start: this would produce hashes no device will accept.`
    );
    process.exit(1);
  }

  // ---- 2. Databases --------------------------------------------------------
  const conn = await checkConnections();
  for (const e of conn.errors) app.log.warn(e);

  if (!conn.backend) {
    app.log.fatal('backend database unusable — refusing to start');
    process.exit(1);
  }
  if (!conn.telemetry) {
    // Not fatal. The dashboard degrades to empty state, which is the expected
    // condition right now anyway with the mock stopped.
    app.log.warn('telemetry database unavailable — dashboard will show empty state');
  }

  // ---- 2b. Ledger time-format integrity ------------------------------------
  //
  // The SECOND frozen vector, and the reason it lives here rather than beside
  // assertFrozenVector() above: its format is defined in SQL, so proving it
  // requires the database, which is only known reachable at this point.
  //
  // FATAL, exactly like canonicalization drift, and for the same asymmetry: a
  // warning is a defence that requires somebody to be reading logs at the moment
  // it fires. If the format has drifted, every link written afterwards is
  // silently wrong, and the damage surfaces weeks later as universal
  // verification failure — at which point drift and tampering are
  // indistinguishable. That is the integrity mechanism producing a false
  // positive that cannot be told from a true one, which is worse than having no
  // check at all.
  //
  // The cost is low for a structural reason: THE EDGE TIER IS AUTONOMOUS. A
  // backend that refuses to start cannot endanger the plants — the ESP32 keeps
  // running its NVS config, keeps its actuators controlled, and keeps its
  // emergency stop enforceable. What is lost is the dashboard and config
  // pushes. This choice would be wrong in a system where the server sat in the
  // control path; it is right here BECAUSE of a property deliberately built.
  try {
    await assertTimeVector();
    app.log.info('ledger time format verified against the frozen vectors');
  } catch (err) {
    app.log.fatal(
      `LEDGER TIME FORMAT DRIFT — ${err.message} ` +
        `Refusing to start: every link written under a drifted format would fail ` +
        `verification indistinguishably from tampering.`
    );
    process.exit(1);
  }

  // ---- 3. Broker -----------------------------------------------------------
  publisher = new MqttPublisher({
    logger: app.log,
    onRepublishNeeded: republishActiveConfig,
  });

  // Correlate device acks with the commands and configs that caused them.
  /**
   * The edge reporting its own emergency stop state.
   *
   * up/actuators is a retained state topic the device already uses to report
   * facts about itself, so a local trigger arrives here as an ordinary state
   * change — no new topic, no new semantics. On reconnect the retained message
   * arrives on subscribe, so the same handler covers both the live case and the
   * network-was-down case.
   *
   * `retrospective` is decided by comparing the device's reported `since`
   * against now: a stop that began materially before the server saw it is one
   * the server did not witness, and the record must say so.
   */
  publisher.on('actuators', async (payload) => {
    if (payload?.estop === undefined) return;
    const deviceStopped = payload.estop === true;

    try {
      const server = await estopService.getServerEstop();
      const serverStopped = server.state === 'stopped';
      if (deviceStopped === serverStopped) return;

      // The device carries `since` on up/health; up/actuators reports the flag
      // only. Prefer a health-reported since when available, else fall back to
      // now — and mark it retrospective only when we can show a real gap.
      const health = publisher.getState().lastSeen?.health;
      const deviceSince = health?.estop?.since ?? null;
      const nowS = Math.floor(Date.now() / 1000);
      const retrospective = deviceSince != null && nowS - deviceSince > 60;

      const r = await estopService.observeLocalEstop({
        state: deviceStopped ? 'stopped' : 'clear',
        deviceSince,
        retrospective,
        publisher,
        logger: app.log,
      });
      if (r.recorded) {
        app.log.warn(
          `local emergency stop ${r.state} recorded from device report ` +
            `(seq ${r.seq}${r.retrospective ? ', retrospective' : ''})`
        );
      }
    } catch (err) {
      app.log.error(`failed to record device-reported estop: ${err.message}`);
    }
  });

  publisher.on('ack', async (payload) => {
    try {
      const updated = await commandService.recordAck(payload);
      if (updated) app.log.info(`ack correlated for command ${updated.id}: ${updated.ack_result}`);
    } catch (err) {
      app.log.error(`failed to record ack: ${err.message}`);
    }
  });

  try {
    await publisher.connect();
  } catch (err) {
    // Not fatal either. The API still serves history and config management, and
    // the client reconnects on its own — at which point republish runs.
    app.log.error(`broker unreachable at startup: ${err.message}. Will keep retrying.`);
  }

  // ---- 4. HTTP -------------------------------------------------------------
  await app.register(import('@fastify/cors'), { origin: true, credentials: true });
  await app.register(import('@fastify/cookie'));

  // Resolves request.user from the session cookie on every request, before any
  // route's preHandler runs. requireCap() reads request.user; without this hook
  // it would always see null and every gated route would 401.
  attachUser(app);

  // Creates the first administrator if and only if the users table is empty.
  // Fatal on failure — see bootstrapAdmin's own documentation for why there is
  // no fallback credential and no HTTP path for this instead.
  try {
    const boot = await bootstrapAdmin(app.log);
    if (!boot.created) app.log.info('users already exist — bootstrap skipped');
  } catch (err) {
    app.log.fatal(`bootstrap failed: ${err.message}`);
    process.exit(1);
  }

  registerRoutes(app, { publisher, republishActiveConfig });

  // Serve the built dashboard from the same origin as the API, so one container
  // serves both and there is no CORS surface in production. Absent in
  // development, where Vite serves the frontend and proxies /api here.
  const publicDir = new URL('../public', import.meta.url).pathname;
  if (existsSync(publicDir)) {
    await app.register(import('@fastify/static'), { root: publicDir, prefix: '/' });
    // The dashboard is a single-page app: any non-API path is a client route
    // and must return index.html rather than a 404, or a refresh on /config
    // would fail.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found', message: 'no such endpoint' });
      }
      return reply.sendFile('index.html');
    });
    app.log.info('serving dashboard from /public');
  } else {
    app.log.warn('no built dashboard found — run `npm run build` in ../frontend');
  }

  // Sweep expired proposals every minute. Proposals carry a TTL; without this
  // they would sit in PROPOSED indefinitely.
  const sweeper = setInterval(async () => {
    try {
      const n = await configService.expireStaleProposals();
      if (n > 0) app.log.info(`expired ${n} stale proposal(s)`);
    } catch (err) {
      app.log.error(`proposal sweep failed: ${err.message}`);
    }
  }, 60000);
  sweeper.unref();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(
    `sdigf-backend listening on :${config.port} for ${config.ghName} (${config.ghId})`
  );
}

async function shutdown(signal) {
  app.log.info(`${signal} received, shutting down`);
  try {
    await app.close();
    if (publisher) await publisher.close();
    await closePools();
  } catch (err) {
    app.log.error(`shutdown error: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  app.log.fatal(`startup failed: ${err.message}`);
  process.exit(1);
});
