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
import { MqttPublisher } from './mqtt.js';
import { registerRoutes } from './routes.js';
import { attachUser } from './auth.js';
import { bootstrapAdmin } from './services/identity-service.js';
import * as configService from './services/config-service.js';
import * as commandService from './services/command-service.js';

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

  // ---- 3. Broker -----------------------------------------------------------
  publisher = new MqttPublisher({
    logger: app.log,
    onRepublishNeeded: republishActiveConfig,
  });

  // Correlate device acks with the commands and configs that caused them.
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
