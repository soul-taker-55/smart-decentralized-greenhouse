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
import * as identity from './services/identity-service.js';
import * as keyService from './services/key-service.js';
import * as approval from './services/approval-service.js';
import * as estop from './services/estop-service.js';
import * as ledger from './services/ledger-service.js';
import { config } from './config.js';
import { emptyConfig, CONFIG_SPEC } from './config-schema.js';
import { CAP, requireCap, getActor, sessionCookie, SESSION_COOKIE_NAME } from './auth.js';

/** Map service errors onto HTTP status codes. */
function errorResponse(reply, err) {
  if (err.name === 'EstopError') {
    const status = { forbidden: 403, no_change: 409, reason_required: 400 };
    return reply.code(status[err.code] ?? 400).send({ error: err.code, message: err.message });
  }
  if (err.name === 'KeyError' || err.name === 'ApprovalError') {
    const status = { not_found: 404, already_voted: 409, self_approval: 403, bad_state: 409, no_key: 400, wrong_role: 403, key_in_use: 409, unsatisfiable: 409 };
    return reply.code(status[err.code] ?? 400).send({ error: err.code, message: err.message });
  }
  if (err.name === 'AuthError') {
    const status = {
      bad_invite: 409, invalid_credentials: 401, weak_password: 400,
      bad_role: 400, bad_request: 400, no_user: 404, no_change: 409,
      // 409 rather than 403: the request is well-formed and the caller is
      // permitted — the system state simply forbids the outcome.
      last_admin: 409, bad_email: 400, wrong_role: 403,
    };
    return reply.code(status[err.code] ?? 400).send({ error: err.code, message: err.message });
  }
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
  app.get('/api/status', { preHandler: requireCap(CAP.VIEW) }, async (_request, reply) => {
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

  app.get('/api/state/live', { preHandler: requireCap(CAP.VIEW) }, async (_request, reply) => {
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

  app.get('/api/state/history/:sensor', { preHandler: requireCap(CAP.VIEW) }, async (request, reply) => {
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

  app.get('/api/sensors', { preHandler: requireCap(CAP.VIEW) }, async () => ({
    groups: telemetry.SENSOR_GROUPS,
    keys: telemetry.SENSOR_KEYS,
  }));

  // -------------------------------------------------------------------------
  // Config profiles
  // -------------------------------------------------------------------------

  /** The field spec, so the editor renders from one source rather than a copy. */
  app.get('/api/config/schema', { preHandler: requireCap(CAP.VIEW) }, async () => ({
    spec: CONFIG_SPEC,
    template: emptyConfig(),
    lifecycle: configService.TRANSITIONS,
  }));

  app.get('/api/config/active', { preHandler: requireCap(CAP.VIEW) }, async (_request, reply) => {
    try {
      const active = await configService.getActiveProfile();
      // null is the normal first-boot state, not an error. 200 with an explicit
      // null keeps the client from treating it as a failure.
      return { active };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/config/profiles', { preHandler: requireCap(CAP.VIEW) }, async (request, reply) => {
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

  app.get('/api/config/profiles/:id', { preHandler: requireCap(CAP.VIEW) }, async (request, reply) => {
    try {
      return { profile: await configService.getProfile(Number(request.params.id)) };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/config/profiles/:id/diff', { preHandler: requireCap(CAP.VIEW) }, async (request, reply) => {
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
  app.post('/api/config/profiles', { preHandler: requireCap(CAP.CONFIG_PROPOSE) }, async (request, reply) => {
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

  /**
   * Clone any profile into a new DRAFT.
   *
   * Deliberately unfiltered by status: cloning bypasses no gate, because the
   * clone still requires the full approval path. This is also HOW ROLLBACK
   * WORKS — there is no re-activate path, because the device rejects an older
   * `ver` as stale and cannot distinguish a legitimate rollback from a replay.
   * Rolling back is a decision about the present, so it is approved as one.
   */
  app.post('/api/config/profiles/:id/clone', { preHandler: requireCap(CAP.CONFIG_PROPOSE) }, async (request, reply) => {
    try {
      const source = await configService.getProfile(Number(request.params.id));
      const profile = await configService.createProfile(source.cfg, {
        name: request.body?.name ?? `Clone of v${source.ver}`,
        parentId: source.id,
        actor: getActor(request),
      });
      return reply.code(201).send({ profile, clonedFrom: { id: source.id, ver: source.ver } });
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.post('/api/config/profiles/:id/propose', { preHandler: requireCap(CAP.CONFIG_PROPOSE) }, async (request, reply) => {
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
   * Approve a proposed config with a signature.
   *
   * Replaces the 05a placeholder. The route, the lifecycle and the event schema
   * are unchanged — only the decision is real now. The browser signs the
   * cfg_canonical BYTES; see key-service.js for why not cfg_hash.
   */
  app.post('/api/config/profiles/:id/approve', { preHandler: requireCap(CAP.CONFIG_APPROVE) }, async (request, reply) => {
    try {
      const result = await approval.castVote({
        profileId: Number(request.params.id),
        decision: 'approve',
        signatureHex: request.body?.signature,
        actor: getActor(request),
      });
      return { ...result, profile: await configService.getProfile(Number(request.params.id)) };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  /** What a proposal still needs: threshold, tally, and who has voted. */
  app.get('/api/config/profiles/:id/standing', { preHandler: requireCap(CAP.VIEW) }, async (request, reply) => {
    try {
      return {
        standing: await approval.getStanding(Number(request.params.id)),
        votes: await approval.listVotes(Number(request.params.id)),
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  /** Reject with a signature. One rejection is terminal — a threshold is not a vote to be outnumbered. */
  app.post('/api/config/profiles/:id/reject', { preHandler: requireCap(CAP.CONFIG_APPROVE) }, async (request, reply) => {
    try {
      const result = await approval.castVote({
        profileId: Number(request.params.id),
        decision: 'reject',
        signatureHex: request.body?.signature,
        reason: request.body?.reason ?? null,
        actor: getActor(request),
      });
      return { ...result, profile: await configService.getProfile(Number(request.params.id)) };
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
  app.post('/api/config/profiles/:id/activate', { preHandler: requireCap(CAP.CONFIG_APPROVE) }, async (request, reply) => {
    try {
      const { activated, superseded } = await configService.activateProfile(
        Number(request.params.id),
        { actor: getActor(request) }
      );

      // Signatures gathered during approval travel WITH the config, so the
      // device can verify independently rather than trusting that the server
      // checked. Empty until engineers hold keys; the device's `verify` status
      // reports whether it actually checked them.
      const sigs = await approval.signaturesFor(activated.id).catch(() => []);

      let published = null;
      let publishError = null;
      try {
        published = await publisher.publishConfig(activated, { sigs });
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
  app.post('/api/config/republish', { preHandler: requireCap(CAP.CONFIG_APPROVE) }, async (_request, reply) => {
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

  app.get('/api/commands', { preHandler: requireCap(CAP.VIEW) }, async (request, reply) => {
    try {
      return { commands: await commandService.listCommands({ limit: Number(request.query.limit ?? 50) }) };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/commands/targets', { preHandler: requireCap(CAP.VIEW) }, async () => ({
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
  app.post('/api/commands', { preHandler: requireCap(CAP.COMMAND) }, async (request, reply) => {
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
  app.get('/api/events', { preHandler: requireCap(CAP.VIEW) }, async (request, reply) => {
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

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  //
  // No self-registration anywhere in this group. Accounts originate from an
  // admin invite (see the user-management block below) or from the bootstrap
  // administrator created once at startup. There is no POST /api/auth/register.

  app.post('/api/auth/login', async (request, reply) => {
    try {
      const { identifier, password, remember } = request.body ?? {};
      const { user, token, expiresInHours } = await identity.login({
        identifier,
        password,
        remember: Boolean(remember),
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });
      const cookie = sessionCookie(token, expiresInHours);
      reply.setCookie(cookie.name, cookie.value, cookie.options);
      return { user };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    await identity.logout(token);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  /** Who the current session belongs to, or null. Drives the sidebar's role scoping. */
  app.get('/api/auth/me', async (request) => ({ user: request.user ?? null }));

  /** Public: shows who an invite is for before a password is chosen. No auth — the link itself is the credential. */
  app.get('/api/auth/invite/:token', async (request, reply) => {
    const peek = await identity.peekInvite(request.params.token);
    if (!peek) {
      return reply.code(404).send({ error: 'bad_invite', message: 'This invite is invalid, expired, or already used.' });
    }
    return { invite: peek };
  });

  app.post('/api/auth/invite/:token/redeem', async (request, reply) => {
    try {
      const user = await identity.redeemInvite({
        token: request.params.token,
        password: request.body?.password,
      });
      return { user };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  // ---------------------------------------------------------------------------
  // User management — ADMIN ONLY
  // ---------------------------------------------------------------------------
  //
  // This is the one place in the API gated by CAP.ADMIN rather than CAP.VIEW or
  // an operational capability, matching the settled matrix: admin manages
  // users, API configuration and server status, and nothing agronomic.

  // ---------------------------------------------------------------------------
  // Emergency stop
  // ---------------------------------------------------------------------------
  //
  // Contract v4 §3.9. Authority is deliberately ASYMMETRIC: engineers and
  // farmers may trigger, only engineers may clear. Anyone who can see a problem
  // should be able to halt the greenhouse; deciding the problem is over is an
  // engineering judgement, and the person who halted it because something
  // looked wrong is not the right person to certify that it no longer is.
  //
  // Session-attributed, not signed. Requiring a signature would mean an
  // engineer without their key on the device in front of them could not stop a
  // greenhouse they can see is in trouble — the wrong failure mode. Stopping is
  // cheap and reversible; approving a configuration is neither.

  /**
   * What the server asked for, and what the device reports.
   *
   * Two separate figures on purpose. Publish a stop while the controller is
   * offline and the retained message sits unread — the greenhouse is still
   * running. Showing one merged "stopped" would be the opposite of the truth
   * at the moment it matters most.
   */
  app.get('/api/estop', { preHandler: requireCap(CAP.VIEW) }, async (_request, reply) => {
    try {
      const [server, edgeCfg] = await Promise.all([
        estop.getServerEstop(),
        telemetry.getEdgeConfigState().catch(() => null),
      ]);
      const live = publisher.getState().lastSeen;
      return {
        requested: server,
        device: {
          // Device-declared. The server never asserts a greenhouse is stopped.
          active: live?.actuators?.estop ?? live?.health?.estop?.active ?? null,
          seq: live?.health?.estop?.seq ?? null,
          since: live?.health?.estop?.since ?? null,
          reportedAt: edgeCfg?.reportedAt ?? null,
        },
        confirmed:
          server.state === 'stopped' &&
          (live?.actuators?.estop === true || live?.health?.estop?.active === true),
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.post('/api/estop/trigger', { preHandler: requireCap(CAP.ESTOP_TRIGGER) }, async (request, reply) => {
    try {
      return await estop.setEstop({
        state: 'stopped',
        reason: request.body?.reason ?? null,
        actor: getActor(request),
        publisher,
      });
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.post('/api/estop/clear', { preHandler: requireCap(CAP.ESTOP_CLEAR) }, async (request, reply) => {
    try {
      return await estop.setEstop({
        state: 'clear',
        reason: request.body?.reason ?? null,
        actor: getActor(request),
        publisher,
      });
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/estop/history', { preHandler: requireCap(CAP.VIEW) }, async () => ({
    events: await estop.listEstopEvents({ limit: 20 }),
  }));

  // ---------------------------------------------------------------------------
  // Ledger
  // ---------------------------------------------------------------------------
  //
  // CAP.VIEW — every authenticated role, INCLUDING ADMIN.
  //
  // The chain does not defend against an administrator READING it; it defends
  // against an administrator ALTERING it undetectably. Hiding the result from
  // admin would protect nothing — they hold database access and can run the
  // verifier themselves — while making the audit result something only some
  // staff can see, which is a strange property for an audit. Farmers and
  // engineers seeing a broken chain is exactly the visibility this phase exists
  // to create.
  //
  // Not public, though: verifyChain walks every link and re-serializes each
  // one, so an unauthenticated endpoint would be a free way to make the server
  // work.

  /**
   * Verify the hash chain and report what verification can and cannot establish.
   *
   * RECOMPUTED ON EVERY REQUEST, deliberately. At the current scale this is
   * milliseconds, and the system accrues one config event per change plus a
   * handful of commands per day, so it stays small for years. Caching would also
   * introduce a subtle wrongness: a cached "ok" is a claim about the past
   * presented as the present. If this ever becomes slow, the answer is a bounded
   * range parameter, not a cache.
   *
   * The `claim` block is part of the response, not decoration. A caller that
   * renders `ok` without it would be asserting something this endpoint does not
   * establish — see scenario 6 of tools/tamper-demo.mjs, where a fully rewritten
   * chain also reports ok.
   */
  app.get('/api/ledger/verify', { preHandler: requireCap(CAP.VIEW) }, async (_request, reply) => {
    try {
      const [result, head] = await Promise.all([ledger.verifyChain(), ledger.getHead()]);

      return {
        ...result,
        head: head
          ? { seq: Number(head.seq), entryHash: head.entry_hash, backfilled: head.backfilled }
          : null,
        claim: {
          proves:
            'Internal consistency: no single record was altered, deleted or reordered ' +
            'after it was written, and no chained event is missing its link.',
          doesNotProve:
            'Authenticity of the history as a whole. A complete rewrite from genesis ' +
            'cannot be detected, because the chain head is not anchored outside this ' +
            'system. External anchoring is named future work and is not built.',
          realTimeFrom:
            result.realTimeFrom === null
              ? 'No link was written in real time yet, so no ordering is proven.'
              : `Links before ${result.realTimeFrom} prove content integrity but assert their ` +
                `ordering retrospectively. From ${result.realTimeFrom} forward, ordering was ` +
                `observed as it happened.`,
        },
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  // ---------------------------------------------------------------------------
  // Signing keys
  // ---------------------------------------------------------------------------
  //
  // The server receives PUBLIC halves only. Private keys are generated in the
  // browser and never transmitted — there is no route here that could accept
  // one, and no column to store it in.

  /** Register the public half of a keypair generated in the browser. */
  app.post('/api/keys', { preHandler: requireCap(CAP.CONFIG_APPROVE) }, async (request, reply) => {
    try {
      const actor = getActor(request);
      const key = await keyService.registerKey({
        userId: actor.id,
        publicKeyHex: request.body?.publicKey,
        actor,
      });
      return reply.code(201).send({ key });
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  /** The caller's own active key, or null if they have not registered one. */
  app.get('/api/keys/mine', { preHandler: requireCap(CAP.VIEW) }, async (request) => ({
    key: await keyService.getActiveKey(getActor(request).id),
  }));

  /** All keys, active and revoked. Revoked ones are retained so past approvals stay verifiable. */
  app.get('/api/keys', { preHandler: requireCap(CAP.VIEW) }, async () => ({
    keys: await keyService.listKeys(),
  }));

  app.post('/api/keys/:keyId/revoke', { preHandler: requireCap(CAP.ADMIN) }, async (request, reply) => {
    try {
      const key = await keyService.revokeKey({
        keyId: request.params.keyId,
        reason: request.body?.reason ?? null,
        actor: getActor(request),
      });
      // A revoked key must not keep an authenticated session alive.
      await identity.revokeAllSessions(key.user_id);
      return { key };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  // ---------------------------------------------------------------------------
  // Approval policy — ADMIN sets the threshold but cannot approve anything
  // ---------------------------------------------------------------------------

  app.get('/api/approval/policy', { preHandler: requireCap(CAP.VIEW) }, async () => ({
    policy: await approval.getPolicy(),
  }));

  /**
   * Change the M-of-N threshold.
   *
   * Admin-gated, and recorded as an event. Lowering M from 2 to 1 converts a
   * multi-signature system into a single-signature one, so the change is
   * logged with a `weakened` flag rather than left for a reader to notice by
   * comparing numbers.
   */
  app.post('/api/approval/policy', { preHandler: requireCap(CAP.ADMIN) }, async (request, reply) => {
    try {
      const policy = await approval.setPolicy({
        thresholdM: Number(request.body?.thresholdM),
        proposalTtlHours: request.body?.proposalTtlHours ?? null,
        actor: getActor(request),
      });
      return { policy };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/users', { preHandler: requireCap(CAP.ADMIN) }, async () => ({
    users: await identity.listUsers(),
  }));

  /**
   * Create an invited account.
   *
   * Returns the plaintext token ONCE, for the admin to deliver out of band.
   * Only its hash is ever stored — this response is the sole moment it exists
   * outside the invitee's own link.
   */
  /**
   * Deactivate an account. There is deliberately no DELETE endpoint — see
   * identity-service.deactivateUser for why removing a user would retroactively
   * break the claim that past approvals cannot be forged.
   */
  app.post('/api/users/:id/deactivate', { preHandler: requireCap(CAP.ADMIN) }, async (request, reply) => {
    try {
      return {
        user: await identity.deactivateUser({
          userId: request.params.id,
          reason: request.body?.reason ?? null,
          actor: getActor(request),
        }),
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.post('/api/users/:id/reactivate', { preHandler: requireCap(CAP.ADMIN) }, async (request, reply) => {
    try {
      return {
        user: await identity.reactivateUser({
          userId: request.params.id,
          reason: request.body?.reason ?? null,
          actor: getActor(request),
        }),
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  /** Change a role. Revokes the signing key when leaving the engineer role. */
  app.post('/api/users/:id/role', { preHandler: requireCap(CAP.ADMIN) }, async (request, reply) => {
    try {
      return await identity.changeRole({
        userId: request.params.id,
        toRole: request.body?.role,
        reason: request.body?.reason ?? null,
        actor: getActor(request),
      });
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  /**
   * Delete a farmer. FARMERS ONLY — the service layer refuses anyone else with
   * a 403 naming why. Soft delete: see identity-service.deleteFarmer for the
   * foreign-key finding that makes a hard delete the wrong choice here.
   */
  app.post('/api/users/:id/delete', { preHandler: requireCap(CAP.ADMIN) }, async (request, reply) => {
    try {
      return {
        user: await identity.deleteFarmer({
          userId: request.params.id,
          reason: request.body?.reason ?? null,
          actor: getActor(request),
        }),
      };
    } catch (err) {
      return errorResponse(reply, err);
    }
  });

  app.get('/api/users/:id/history', { preHandler: requireCap(CAP.ADMIN) }, async (request) => ({
    history: await identity.roleHistory(request.params.id),
  }));

  app.post('/api/users/invite', { preHandler: requireCap(CAP.ADMIN) }, async (request, reply) => {
    try {
      const { email, username, role } = request.body ?? {};
      const { user, token, expiresAt } = await identity.inviteUser({
        email,
        username,
        role,
        actor: getActor(request),
      });
      return reply.code(201).send({ user, inviteToken: token, expiresAt });
    } catch (err) {
      return errorResponse(reply, err);
    }
  });
}

