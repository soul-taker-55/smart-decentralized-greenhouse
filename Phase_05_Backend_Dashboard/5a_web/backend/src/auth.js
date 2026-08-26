/**
 * SDIGF — authentication and authorisation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROLE MATRIX, IN ONE PLACE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *                                      ADMIN   ENGINEER   FARMER
 *   View readings, history, camera       yes      yes       yes
 *   Manual commands (TTL-bounded)        NO       yes       yes
 *   Propose configs                      NO       yes       NO
 *   Approve configs (signed, M-of-N)     NO       yes       NO
 *   Trigger emergency stop               NO       yes       yes
 *   Clear emergency stop                 NO       yes       NO
 *   Manage users, API config, server     yes      NO        NO
 *
 * ADMIN IS DELIBERATELY EXCLUDED FROM OPERATIONAL AND AGRONOMIC AUTHORITY.
 * This is separation of duties, not an oversight. The party who creates
 * accounts and assigns roles is precisely the party who must not also be able
 * to approve a configuration — otherwise the multi-signature requirement is
 * satisfiable by one person with database access and a browser.
 *
 * It is worth being honest about how far that goes: an administrator can still
 * mint two engineer accounts and satisfy a 2-of-N threshold with two keys they
 * control. Excluding admin from approval does not prevent that. What it does is
 * force the act to leave a trail — two account creations and two role
 * assignments, all recorded in role_changes — rather than being a single
 * unlogged approval. The guarantee is visibility, not prevention, and the
 * thesis should say so in those words.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE MATRIX IS DATA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Encoded as a table below rather than scattered as `if (role === …)` through
 * the routes. A permission model spread across twenty call sites cannot be
 * reviewed, and the twenty-first call site is the one that forgets.
 */

import * as identity from './services/identity-service.js';

/** Capabilities, named for what they permit rather than for the route. */
export const CAP = {
  VIEW: 'view',
  COMMAND: 'command',
  CONFIG_PROPOSE: 'config:propose',
  CONFIG_APPROVE: 'config:approve',
  ESTOP_TRIGGER: 'estop:trigger',
  ESTOP_CLEAR: 'estop:clear',
  ADMIN: 'admin',
};

const MATRIX = {
  admin: [CAP.VIEW, CAP.ADMIN],
  engineer: [
    CAP.VIEW,
    CAP.COMMAND,
    CAP.CONFIG_PROPOSE,
    CAP.CONFIG_APPROVE,
    CAP.ESTOP_TRIGGER,
    CAP.ESTOP_CLEAR,
  ],
  // 'farmer' and 'viewer' are the same role. Two names for one thing invites
  // drift between the code and the interface; `farmer` is the single spelling.
  farmer: [CAP.VIEW, CAP.COMMAND, CAP.ESTOP_TRIGGER],
};

export function can(role, capability) {
  return (MATRIX[role] ?? []).includes(capability);
}

/** The capability set for a role, for the UI to render from one source. */
export function capabilitiesFor(role) {
  return MATRIX[role] ?? [];
}

const COOKIE = 'sdigf_session';

function readToken(request) {
  const raw = request.headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Resolve the session on every request, without rejecting anything.
 *
 * Attaching the user is separate from requiring one, so that a route can decide
 * for itself. Read endpoints that behave differently for an anonymous caller
 * still need to know there isn't one.
 */
export function attachUser(app) {
  app.decorateRequest('user', null);

  app.addHook('preHandler', async (request) => {
    const token = readToken(request);
    request.user = token ? await identity.resolveSession(token) : null;
  });
}

/**
 * Require an authenticated session with a given capability.
 *
 * Returns a preHandler. Applied per route, so a route with no guard is visibly
 * unguarded when reading the file rather than quietly inheriting one.
 */
export function requireCap(capability) {
  return async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({
        error: 'not_authenticated',
        message: 'Sign in to continue.',
      });
    }
    if (!can(request.user.role, capability)) {
      // 403, and the message names the role rather than being coy. Hiding the
      // reason from an authenticated user protects nothing — they already know
      // who they are — and turns a clear refusal into a support ticket.
      return reply.code(403).send({
        error: 'forbidden',
        message: `A ${request.user.role} account cannot perform this action.`,
        required: capability,
        role: request.user.role,
      });
    }
  };
}

/**
 * The actor recorded against every mutating action.
 *
 * In 05a this returned null and landed as NULL in created_by / actor_id /
 * actor_role. It now returns the authenticated user. No call site changed and
 * no migration was needed — which was the point of leaving those columns
 * nullable rather than absent.
 */
export function getActor(request) {
  if (!request.user) return null;
  return { id: request.user.id, role: request.user.role };
}

/** Session cookie options. */
export function sessionCookie(token, hours) {
  return {
    name: COOKIE,
    value: token,
    options: {
      // Not readable from JavaScript, so an XSS bug cannot lift the session.
      httpOnly: true,
      // HTTPS only. The deployment is behind TLS; a session cookie on a plain
      // connection is a session cookie on the wire.
      secure: true,
      // Lax rather than Strict: Strict breaks following a link into the app
      // from an email, which is exactly how invite links are delivered.
      sameSite: 'lax',
      path: '/',
      maxAge: hours * 3600,
    },
  };
}

export const SESSION_COOKIE_NAME = COOKIE;
