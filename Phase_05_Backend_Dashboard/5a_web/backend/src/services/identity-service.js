/**
 * SDIGF — identity service.
 *
 * Accounts, invites, sessions, and the bootstrap administrator.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO SELF-REGISTRATION, ANYWHERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every account originates from an admin invite. There is no public sign-up
 * path and no HTTP route that creates an account without an authenticated
 * admin — with one deliberate exception, the bootstrap admin, which is created
 * at STARTUP and has no HTTP surface at all.
 *
 * That distinction is the whole reason bootstrapping happens here rather than
 * on a first-run setup page. A setup page would mean shipping a permanent,
 * unauthenticated administrator-creation route guarding a condition that is
 * true for roughly ninety seconds in the system's life. If the "are there zero
 * users?" check ever failed open — a caching bug, a careless refactor — the
 * result is full compromise of a system that switches 220 V equipment. A
 * startup path cannot be reached over the network at all, so there is nothing
 * to fail open.
 */

import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { query, transaction } from '../db.js';
import { hashPassword, verifyPassword, checkPasswordStrength } from '../password.js';
import { config } from '../config.js';

export class AuthError extends Error {
  constructor(message, code = 'auth_failed') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Tokens are stored hashed. A database dump must not yield usable credentials. */
const sha256 = (v) => createHash('sha256').update(v).digest('hex');

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Create the first administrator, if and only if no users exist.
 *
 * Called once at startup, before HTTP begins accepting requests.
 *
 * REFUSES TO START on a missing or weak password. There is deliberately no
 * fallback default: a bootstrap script with a hardcoded credential is how
 * bootstrap scripts become the hole. Better to fail the deploy loudly than to
 * come up listening with a guessable administrator.
 *
 * @returns {{created: boolean, id?: string}}
 */
export async function bootstrapAdmin(logger = console) {
  const existing = await query('SELECT count(*)::int AS n FROM users');
  if (existing.rows[0].n > 0) {
    return { created: false };
  }

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin';

  if (!email || !password) {
    throw new Error(
      'No users exist and BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD are not set. ' +
        'Refusing to start: there is no default administrator credential by design. ' +
        'Set both in the deployment environment and redeploy.'
    );
  }

  const weak = checkPasswordStrength(password);
  if (weak.length > 0) {
    throw new Error(
      `BOOTSTRAP_ADMIN_PASSWORD rejected: ${weak.join('; ')}. ` +
        'Refusing to start rather than create the first administrator with a weak credential.'
    );
  }

  const id = 'admin-' + randomUUID().slice(0, 8);
  const passwordHash = await hashPassword(password);

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO users (id, email, username, role, password_hash, status, activated_at)
       VALUES ($1, $2, $3, 'admin', $4, 'active', now())`,
      [id, email, username, passwordHash]
    );
    // created_by and changed_by are NULL — nobody authorised this account, and
    // the record says so rather than inventing an authoriser. This is the one
    // account that predates any audit trail, including the ledger.
    await client.query(
      `INSERT INTO role_changes (user_id, from_role, to_role, changed_by, reason)
       VALUES ($1, NULL, 'admin', NULL, 'bootstrap — first administrator, created at startup')`,
      [id]
    );
  });

  // Greppable on purpose. This is a one-time event in the system's life, it is
  // the only account created without an authoriser, and it is the account a
  // reviewer will ask about. `SDIGF_BOOTSTRAP_ADMIN_CREATED` appears nowhere
  // else in the codebase.
  logger.warn?.(
    `SDIGF_BOOTSTRAP_ADMIN_CREATED id=${id} username=${username} email=${email} — ` +
      `first administrator created at startup because the users table was empty. ` +
      `No other account may be created without an authenticated admin invite. ` +
      `This account predates the audit trail and is not chained by the ledger.`
  );

  return { created: true, id };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    activatedAt: row.activated_at,
    lastLoginAt: row.last_login_at,
    // Never include password_hash. Not in the API, not in logs, not in a debug
    // dump. Omitting it here means no route can leak it by accident.
  };
}

export async function listUsers() {
  const r = await query('SELECT * FROM users ORDER BY created_at ASC');
  return r.rows.map(rowToUser);
}

export async function getUser(id) {
  const r = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rowToUser(r.rows[0]);
}

/**
 * Create an invited account and issue a single-use link.
 *
 * The plaintext token is returned ONCE, to be handed to the admin for delivery.
 * Only its hash is stored, so it cannot be recovered later — if the link is
 * lost, the invite is reissued rather than looked up.
 *
 * @returns {{user, token, expiresAt}}
 */
export async function inviteUser({ email, username, role, actor }) {
  if (!['admin', 'engineer', 'farmer'].includes(role)) {
    throw new AuthError(`unknown role ${JSON.stringify(role)}`, 'bad_role');
  }
  if (!email || !username) {
    throw new AuthError('email and username are required', 'bad_request');
  }

  // Prefix by role so the identifier is legible wherever it appears — in the
  // audit trail, in a down/cmd payload, in a ledger someone has to read.
  const prefix = role === 'engineer' ? 'eng' : role === 'admin' ? 'admin' : 'farmer';
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;

  const token = randomBytes(32).toString('base64url');
  const ttlHours = 24;

  const result = await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO users (id, email, username, role, status, created_by)
       VALUES ($1, $2, $3, $4, 'invited', $5)
       RETURNING *`,
      [id, email, username, role, actor?.id ?? null]
    );

    await client.query(
      `INSERT INTO invites (token_hash, user_id, role, expires_at, created_by)
       VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)`,
      [sha256(token), id, role, String(ttlHours), actor?.id ?? null]
    );

    // Role assignment is audited from the moment of creation. An administrator
    // who can silently mint engineers can manufacture a quorum; no schema
    // prevents that, so the defence is that it cannot be done quietly.
    await client.query(
      `INSERT INTO role_changes (user_id, from_role, to_role, changed_by, reason)
       VALUES ($1, NULL, $2, $3, 'account created by invitation')`,
      [id, role, actor?.id ?? null]
    );

    return inserted.rows[0];
  });

  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
  return { user: rowToUser(result), token, expiresAt };
}

/**
 * Look up an invite without consuming it, so the redemption page can show who
 * it is for before a password is chosen.
 */
export async function peekInvite(token) {
  const r = await query(
    `SELECT i.*, u.email, u.username
     FROM invites i JOIN users u ON u.id = i.user_id
     WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now()`,
    [sha256(token)]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return { userId: row.user_id, role: row.role, email: row.email, username: row.username };
}

/**
 * Redeem an invite: set the password and activate the account.
 *
 * The role comes from the INVITE, not from the user row. If an admin changed
 * the user's role between issuing and redemption, the invite still grants what
 * was intended when it was created — and the discrepancy stays visible instead
 * of being silently resolved in the administrator's favour.
 */
export async function redeemInvite({ token, password }) {
  const weak = checkPasswordStrength(password);
  if (weak.length > 0) {
    throw new AuthError(`password rejected: ${weak.join('; ')}`, 'weak_password');
  }

  const passwordHash = await hashPassword(password);

  return transaction(async (client) => {
    // FOR UPDATE, so two simultaneous redemptions of one link cannot both win.
    const inv = await client.query(
      `SELECT * FROM invites
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [sha256(token)]
    );
    if (inv.rows.length === 0) {
      throw new AuthError('invite is invalid, already used, or expired', 'bad_invite');
    }
    const invite = inv.rows[0];

    await client.query(`UPDATE invites SET used_at = now() WHERE id = $1`, [invite.id]);

    const updated = await client.query(
      `UPDATE users
       SET password_hash = $1, status = 'active', activated_at = now(), role = $2
       WHERE id = $3
       RETURNING *`,
      [passwordHash, invite.role, invite.user_id]
    );

    return rowToUser(updated.rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;

/**
 * Authenticate and open a session.
 *
 * A failed login reports the same message whether the account is unknown, the
 * password is wrong, or the account is suspended. Distinguishing them turns the
 * login form into an account-enumeration oracle.
 *
 * The password is verified even when the user does not exist, against a dummy
 * hash, so response timing does not reveal which case occurred either.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$00000000000000000000000000000000$' + '0'.repeat(64);

export async function login({ identifier, password, remember = false, userAgent, ip }) {
  const r = await query(
    `SELECT * FROM users WHERE email = $1 OR username = $1`,
    [identifier]
  );
  const row = r.rows[0];

  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);

  if (!row || !ok || row.status !== 'active' || !row.password_hash) {
    throw new AuthError('incorrect credentials', 'invalid_credentials');
  }

  const secret = randomBytes(32).toString('base64url');
  const hours = remember ? REMEMBER_DAYS * 24 : SESSION_HOURS;

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
       VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4, $5)`,
      [sha256(secret), row.id, String(hours), userAgent ?? null, ip ?? null]
    );
    await client.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);
  });

  return { user: rowToUser(row), token: secret, expiresInHours: hours };
}

/**
 * Resolve a session token to a user.
 *
 * Server-side sessions rather than self-contained tokens, so revocation is
 * immediate. A suspended account holding a stateless token stays valid until it
 * expires; a suspended account holding a server-side session does not. For a
 * system that can actuate equipment, "logged out" needs to mean logged out.
 */
export async function resolveSession(token) {
  if (!token) return null;
  const r = await query(
    `SELECT s.id AS sid, u.*
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [sha256(token)]
  );
  if (r.rows.length === 0) return null;

  // Best-effort activity stamp; a failure here must not fail the request.
  query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [r.rows[0].sid]).catch(
    () => {}
  );

  return rowToUser(r.rows[0]);
}

export async function logout(token) {
  if (!token) return;
  await query(`DELETE FROM sessions WHERE id = $1`, [sha256(token)]);
}

/** Drop every session for a user. Used on suspension and on key revocation. */
export async function revokeAllSessions(userId) {
  const r = await query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return r.rowCount;
}

/** Housekeeping, called on a timer. */
export async function purgeExpiredSessions() {
  const r = await query(`DELETE FROM sessions WHERE expires_at < now()`);
  return r.rowCount;
}
