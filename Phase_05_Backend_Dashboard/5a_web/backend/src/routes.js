/**
 * SDIGF backend — REST API.
 *
 * Hard rule 3: build the REST API first. 05c's MCP server wraps THIS surface and
 * 05b's RBAC slots in as gates on THESE endpoints. Neither should require
 * retrofitting, so the shapes here are the shapes they inherit.
 *
 * ─── THE 05b SEAM ──────────────────────────────────────────────────────────
 *
 * Every mutating route resolves an `actor` via getActor(request) and passes it
 * down. In 05a that returns null and lands as NULL in the database. In 05b it
 * returns the authenticated user, and a preHandler hook enforces the role
 * matrix. No route signature changes, no migration.
 *
 * The role matrix 05b will enforce, recorded here so the seam is not guessed at:
 *   manual commands      → ENGINEER, FARMER   (never ADMIN)
 *   propose/approve      → ENGINEER only
 *   read everything      → all roles
 *
 * ─── ROUTES ARE THIN ───────────────────────────────────────────────────────
 *
 * Routes parse, delegate, and format. They never touch pg or mqtt directly —
 * that is hard rule 1, and keeping it visible here is what makes it auditable.
 */

import * as configService from './services/config-service.js';
import * as commandService from './services/command-service.js';
import * as telemetry from './services/telemetry-service.js';
import { config } from './config.js';
import { emptyConfig, CONFIG_SPEC } from './config-schema.js';

/**
 * Resolve the acting user.
 *
 * 05a: always null — no authentication in this phase, by design ("build the
 * seams, not the locks"). 05b replaces the body and every call site already
 * passes the result through to the database.
 */
function getActor(_request) {
  return null;
}

/** Map service errors onto HTTP status codes. */
function errorResponse(reply, err) {
  if (err.name === 'ValidationError') {
    return reply.code(400).send({ error: 'validation_failed', message: err.message, fields: err.errors });
  }
  if (err.name === 'CommandError') {
    return reply
      .code(400)
      .send({ error: 'command_rejected', message: err.message, fields: err.errors ?? null });
  }
  if (err.name === 'NotFoundError') {
    return reply.code(404).send({ error: 'not_found', message: err.message });
  }
  if (err.name === 'LifecycleError') {
    // 409 rather than 400: the request is well-formed, the resource is simply
    // not in a state that permits it.
    return reply.code(409).send({
      error: 'invalid_transition',
      message: err.message,
      from: err.from,
      to: err.to,
    });
  }
  if (err.name === 'PublishError') {
    return reply.code(502).send({
      error: 'publish_failed',
      message: err.message,
      hint: 'Check the broker first — a denied publish can return success silently.',
    });
  }
  return reply.code(500).send({ error: 'internal_error', message: err.message });
}

export function registerRoutes(app, { publisher, republishActiveConfig }) {
  // -------------------------------------------------------------------------
  // Status — the endpoint 05c depends on
  // -------------------------------------------------------------------------

  /**
   * Consolidated system status: broker, bridge, edge, data freshness.
   *
   * 05c's get_server_status wraps this, and it is load-bearing there: without
   * it the chat model can confidently report stale readings as current. With
   * it, it can say "the edge went offline 12 minutes ago — these numbers
   * predate that."
   *
   * Bridge health is INFERRED from row recency rather than by asking the bridge.
   * The backend must not couple to it; the bridge stays a separate read-only
   * service, and inference preserves that separation.
   */
  app.get('/api/status', async (_request, reply) => {
    try {
      const [presence, edgeConfig, activeProfile] = await Promise.all([
        telemetry.getEdgePresence().catch(() => null),
        telemetry.getEdgeConfigState().catch(() => null),
        configService.getActiveProfile(),
      ]);

      const mqttState = publisher.getState();
      const ageS = presence?.lastTelemetryAgeSeconds ?? null;

      return {
        greenhouse: {
          id: config.ghId,
          name: config.ghName,
          plants: config.ghPlants,
        },
        broker: {
          connected: mqttState.connected,
          address: mqttState.broker,
          clientId: mqttState.clientId,
        },
        bridge: {
          // Inferred, and labelled as such so nobody reads it as a health check.
          inferred: true,
          writingRecently: ageS !== null && ageS < 300,
          lastRowAgeSeconds: ageS,
        },
        edge: {
          declaredStatus: presence?.declaredStatus ?? null,
          declaredAt: presence?.declaredAt ?? null,
          everSeen: presence?.everSeen ?? false,
          lastTelemetryAt: presence?.lastTelemetryAt ?? null,
          lastTelemetryAgeSeconds: ageS,
          // Device-declared, never settable by the server. 'unsupported' with
          // the current mock is CORRECT and EXPECTED, not a fault.
          verify: edgeConfig?.verify ?? 'unknown',
          runningCfgVer: edgeConfig?.cfgVer ?? null,
          runningCfgHash: edgeConfig?.cfgHash ?? null,
          // 'none' is the first-boot state: no config has ever been applied.
          cfgSrc: edgeConfig?.cfgSrc ?? null,
          reportedAt: edgeConfig?.reportedAt ?? null,
        },
        server: {
          activeCfgVer: activeProfile?.ver ?? null,
          activeCfgHash: activeProfile?.cfgHash ?? null,
          hasActiveConfig: Boolean(activeProfile),
        },
        // True when the device is running something other than what the server
        // considers active. Surfaced explicitly rather than left to the UI to
        // compute, so chat and dashboard agree.
        configInSync:
          activeProfile && edgeConfig?.cfgHash
            ? activeProfile.cfgHash === edgeConfig.cfgHash
            : null,
        serverTime: new Date().toISOString(),
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/health', async () => ({ ok: true, service: 'sdigf-backend' }));

  // -------------------------------------------------------------------------
  // Live state and history
  // -------------------------------------------------------------------------

  app.get('/api/state/live', async (_request, reply) => {
    try {
      const [state, actuators] = await Promise.all([
        telemetry.getLiveState(),
        telemetry.getActuatorState(),
      ]);
      return { sensors: state, actuators };
    } catch (err) {
      // Telemetry is a separate database and may be unreachable. Degrade to an
      // explicit empty shape rather than failing the whole dashboard.
      return reply.code(200).send({
        sensors: { groups: [], hasData: false, unavailable: true, reason: err.message },
        actuators: { relays: [], canopy: null, ventStage: null, hasData: false },
      });
    }
  });

  app.get('/api/state/history/:sensor', async (request, reply) => {
    try {
      const hours = Number(request.query.hours ?? 24);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
        return reply.code(400).send({ error: 'bad_request', message: 'hours must be 1–8760' });
      }
      return await telemetry.getHistory(request.params.sensor, { hours });
    } catch (err) {
      if (err.message.startsWith('unknown sensor')) {
        return reply.code(400).send({ error: 'unknown_sensor', message: err.message });
      }
      return errorResponse(reply, err);
    }
  });

  app.get('/api/sensors', async () => ({
    groups: telemetry.SENSOR_GROUPS,
    keys: telemetry.SENSOR_KEYS,
  }));

  // -------------------------------------------------------------------------
  // Config profiles
  // -------------------------------------------------------------------------

  /** The field spec, so the editor renders from one source rather than a copy. */
  app.get('/api/config/schema', async () => ({
    spec: CONFIG_SPEC,
    template: emptyConfig(),
    lifecycle: configService.TRANSITIONS,
  }));

  app.get('/api/config/active', async (_request, reply) => {
    try {
      const active = await configService.getActiveProfile();
      // null is the normal first-boot state, not an error. 200 with an explicit
      // null keeps the client from treating it as a failure.
      return { active };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/config/profiles', async (request, reply) => {
    try {
      return {
        profiles: await configService.listProfiles({
          status: request.query.status ?? null,
          limit: Number(request.query.limit ?? 50),
        }),
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/config/profiles/:id', async (request, reply) => {
    try {
      return { profile: await configService.getProfile(Number(request.params.id)) };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/config/profiles/:id/diff', async (request, reply) => {
    try {
      return await configService.diffAgainstActive(Number(request.params.id));
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  /**
   * Create a profile. Validates server-side, computes cfg_canonical and
   * cfg_hash, assigns the next version.
   */
  app.post('/api/config/profiles', async (request, reply) => {
    try {
      const { cfg, name, parentId } = request.body ?? {};
      const profile = await configService.createProfile(cfg, {
        name: name ?? null,
        parentId: parentId ?? null,
        actor: getActor(request),
      });
      return reply.code(201).send({ profile });
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.post('/api/config/profiles/:id/propose', async (request, reply) => {
    try {
      return {
        profile: await configService.proposeProfile(Number(request.params.id), {
          ttlHours: request.body?.ttlHours ?? null,
          actor: getActor(request),
        }),
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  /**
   * ██ STUB — 05a ██ No signature verification, no M-of-N threshold.
   * The response says so, so a UI cannot present this as a real approval.
   */
  app.post('/api/config/profiles/:id/approve', async (request, reply) => {
    try {
      const profile = await configService.approveProfile(Number(request.params.id), {
        actor: getActor(request),
      });
      return {
        profile,
        stub: true,
        note: '05a stub — approved without signature verification or M-of-N threshold. 05b makes this real.',
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.post('/api/config/profiles/:id/reject', async (request, reply) => {
    try {
      return {
        profile: await configService.rejectProfile(Number(request.params.id), {
          reason: request.body?.reason ?? null,
          actor: getActor(request),
        }),
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  /**
   * Activate an APPROVED profile and publish it.
   *
   * The database transaction commits BEFORE the publish. A broker timeout must
   * not roll back a committed activation — and because the server republishes
   * from its own database on every reconnect, a failed publish is recoverable
   * rather than a lost config.
   */
  app.post('/api/config/profiles/:id/activate', async (request, reply) => {
    try {
      const { activated, superseded } = await configService.activateProfile(
        Number(request.params.id),
        { actor: getActor(request) }
      );

      let published = null;
      let publishError = null;
      try {
        published = await publisher.publishConfig(activated);
      } catch (err) {
        publishError = err.message;
      }

      return {
        profile: activated,
        superseded,
        published: published !== null,
        publishBytes: published?.bytes ?? null,
        publishError,
        // Contract §3.7 rule 7 — the edge cancels overrides on a new config.
        cancelsActiveOverrides: true,
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  /** Force a republish from the database. The retained message is a cache. */
  app.post('/api/config/republish', async (_request, reply) => {
    try {
      const result = await republishActiveConfig();
      return result;
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // Manual commands
  // -------------------------------------------------------------------------

  app.get('/api/commands', async (request, reply) => {
    try {
      return { commands: await commandService.listCommands({ limit: Number(request.query.limit ?? 50) }) };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/commands/targets', async () => ({
    targets: commandService.ALL_TARGETS,
    relays: commandService.RELAY_TARGETS,
    actions: commandService.ACTIONS,
    ttlMaxSeconds: config.commandTtlMaxS,
    // Flagged so the UI can say so rather than presenting it as settled physics.
    ttlCapProvisional: true,
  }));

  /**
   * Issue a manual per-actuator override.
   *
   * 05b gates this to ENGINEER and FARMER — never ADMIN, who is deliberately
   * excluded from agronomic authority.
   */
  app.post('/api/commands', async (request, reply) => {
    try {
      const { target, action, value, ttl_s } = request.body ?? {};
      const result = await commandService.issueCommand(
        { target, action, value, ttl_s },
        { actor: getActor(request), via: 'dashboard', publisher }
      );
      return reply.code(201).send({ command: result });
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Merged audit feed: server actions and device events on one timeline.
   *
   * Two sources, deliberately merged here rather than in the browser — 05c's
   * chat needs the same chronology and should not reimplement the interleave.
   */
  app.get('/api/events', async (request, reply) => {
    try {
      const limit = Number(request.query.limit ?? 100);
      const [serverEvents, edgeEvents] = await Promise.all([
        configService.listEvents({ limit }),
        telemetry.getEdgeEvents({ limit }).catch(() => []),
      ]);

      const merged = [
        ...serverEvents.map((e) => ({ ...e, source: 'server', time: e.time })),
        ...edgeEvents.map((e) => ({ ...e, source: 'edge', time: e.time })),
      ].sort((a, b) => new Date(b.time) - new Date(a.time));

      return { events: merged.slice(0, limit), serverCount: serverEvents.length, edgeCount: edgeEvents.length };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });
}
