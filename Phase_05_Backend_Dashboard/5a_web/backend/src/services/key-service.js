/**
 * SDIGF — signing keys and signature verification.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SERVER NEVER HOLDS A PRIVATE KEY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Keypairs are generated in the browser via WebCrypto. Only the public half is
 * POSTed here. This module can register a public key and verify a signature; it
 * cannot produce one.
 *
 * That asymmetry is what the multi-signature argument rests on. If the server
 * generated keypairs, an administrator with database access could sign as any
 * engineer and manufacture a quorum of one — and no amount of threshold logic
 * above it would mean anything. Because the private halves exist only in
 * engineers' browsers, a PAST approval cannot be fabricated by anyone,
 * including whoever runs the server.
 *
 * The honest limit: an administrator can still create new engineer accounts and
 * control their keys going forward. What they cannot do is forge an approval
 * that already happened. See auth.js for the full statement.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PREHASH TRAP — READ BEFORE CHANGING ANY VERIFY CALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The browser signs the `cfg_canonical` BYTES, never `cfg_hash`.
 *
 * WebCrypto has no prehashed mode. `subtle.sign({name:'ECDSA',hash:'SHA-256'},
 * key, cfgHash)` signs SHA-256(cfg_hash) — a double hash. It verifies perfectly
 * in the browser and is rejected by mbedTLS on the ESP32, which verifies against
 * cfg_hash directly. Signing cfg_canonical instead makes WebCrypto's internal
 * SHA-256 produce a signature over cfg_hash, which is what the device expects.
 *
 * On this side: verify over `cfg_canonical` with digest 'sha256'. Do NOT reach
 * for `crypto.verify(null, …)` as a prehashed call — Node's null-digest path on
 * EC keys is not prehashed either, it silently applies SHA-256 anyway, and using
 * it as a stand-in for mbedTLS inverts the result. Both traps are documented in
 * contract v4 §5, corrected 2026-08-26.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { query, transaction } from '../db.js';

export class KeyError extends Error {
  constructor(message, code = 'key_error') {
    super(message);
    this.name = 'KeyError';
    this.code = code;
  }
}

/**
 * Fixed ASN.1 header for a P-256 SubjectPublicKeyInfo.
 *
 * Keys are STORED as the raw uncompressed point (04||X||Y) because Phase 03
 * must ship a trusted-key list to a microcontroller, where bytes are scarce and
 * a DER parser is an attack surface fed hostile input. Node's crypto API wants
 * SPKI, so the header is prepended on the way in. Nothing is lost: the raw form
 * is the smaller, and the SPKI form is a constant away.
 */
const SPKI_PREFIX = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200',
  'hex'
);

/**
 * Derive a key_id from key material.
 *
 * DERIVED, NOT ASSIGNED. Because key_id is a function of the public key, "one
 * key_id, one vote" and "one key, one vote" are the same statement — which is
 * what makes the UNIQUE (config_profile_id, key_id) constraint on approvals
 * mean anything. An assigned identifier could be reused across keys and the
 * constraint would enforce nothing.
 */
export function deriveKeyId(publicKeyHex) {
  const digest = createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex');
  return `eng-${digest.slice(0, 8)}`;
}

/**
 * Validate a submitted public key before it is trusted.
 *
 * A malformed key registered now becomes an approval that cannot be verified
 * later, which would look identical to tampering. Rejecting at registration is
 * the only point where the error is still cheap.
 */
function parsePublicKey(publicKeyHex) {
  if (typeof publicKeyHex !== 'string' || !/^[0-9a-f]{130}$/i.test(publicKeyHex)) {
    throw new KeyError(
      'public key must be 130 lowercase hex characters — an uncompressed P-256 point',
      'bad_key_format'
    );
  }
  const raw = Buffer.from(publicKeyHex.toLowerCase(), 'hex');
  if (raw[0] !== 0x04) {
    throw new KeyError('public key must start with 0x04 (uncompressed point)', 'bad_key_format');
  }

  try {
    // Throws if the point is not actually on the P-256 curve. A point off the
    // curve can enable invalid-curve attacks, and a key that Node refuses to
    // parse now is a key that cannot verify anything later.
    return createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
  } catch (err) {
    throw new KeyError(`not a valid P-256 public key: ${err.message}`, 'bad_key');
  }
}

/**
 * Register an engineer's public key.
 *
 * ENGINEERS ONLY. Admins and farmers approve nothing, so a keypair for them
 * would be an unused credential that still has to be protected.
 *
 * One active key per engineer, enforced by a partial unique index. Losing a key
 * means revocation and a fresh registration, not accumulating spares — several
 * simultaneously valid keys per person makes "who approved this" ambiguous
 * exactly when it matters most.
 */
export async function registerKey({ userId, publicKeyHex, actor }) {
  const hex = String(publicKeyHex ?? '').toLowerCase();
  parsePublicKey(hex);

  const user = await query('SELECT id, role, status FROM users WHERE id = $1', [userId]);
  if (user.rows.length === 0) throw new KeyError('no such user', 'no_user');
  if (user.rows[0].role !== 'engineer') {
    throw new KeyError(
      `only engineers hold signing keys; ${userId} is a ${user.rows[0].role}`,
      'wrong_role'
    );
  }

  const keyId = deriveKeyId(hex);

  return transaction(async (client) => {
    // A key already registered under another identity would let one keypair
    // vote as two people. The unique constraint on public_key catches it; this
    // check produces a comprehensible error instead of a constraint violation.
    const clash = await client.query(
      'SELECT user_id FROM user_keys WHERE public_key = $1 OR key_id = $2',
      [hex, keyId]
    );
    if (clash.rows.length > 0) {
      throw new KeyError(
        `this key is already registered to ${clash.rows[0].user_id}`,
        'key_in_use'
      );
    }

    const inserted = await client.query(
      `INSERT INTO user_keys (key_id, user_id, public_key, alg, status)
       VALUES ($1, $2, $3, 'es256', 'active')
       RETURNING key_id, user_id, created_at`,
      [keyId, userId, hex]
    );

    await client.query(
      `INSERT INTO server_events (gh_id, event_type, ref_table, ref_id, actor_id, actor_role, detail)
       VALUES ('gh1', 'CONFIG_CREATED', 'config_profiles', 0, $1, $2, $3)`,
      [
        actor?.id ?? userId,
        actor?.role ?? 'engineer',
        JSON.stringify({ kind: 'key_registered', keyId, userId }),
      ]
    );

    return inserted.rows[0];
  });
}

/**
 * Revoke a key.
 *
 * The row is RETAINED, never deleted. Signatures it produced remain in
 * config_approvals, and a verifier walking history must still resolve the key
 * that made them. Deleting a revoked key would make every past approval by that
 * engineer unverifiable — destroying evidence in the name of hygiene.
 */
export async function revokeKey({ keyId, reason, actor }) {
  const r = await query(
    `UPDATE user_keys
     SET status = 'revoked', revoked_at = now(), revoked_by = $1, revoke_reason = $2
     WHERE key_id = $3 AND status = 'active'
     RETURNING *`,
    [actor?.id ?? null, reason ?? null, keyId]
  );
  if (r.rows.length === 0) throw new KeyError('no such active key', 'no_key');
  return r.rows[0];
}

/** The active key for an engineer, or null. */
export async function getActiveKey(userId) {
  const r = await query(
    `SELECT key_id, user_id, public_key, created_at
     FROM user_keys WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
  return r.rows[0] ?? null;
}

/**
 * Every key, active and revoked.
 *
 * Revoked keys are included deliberately: verifying a historical approval
 * requires the key that signed it, whatever its status is today.
 */
export async function listKeys() {
  const r = await query(
    `SELECT k.key_id, k.user_id, k.public_key, k.status, k.created_at, k.revoked_at,
            u.username, u.role
     FROM user_keys k JOIN users u ON u.id = k.user_id
     ORDER BY k.created_at ASC`
  );
  return r.rows;
}

/**
 * Verify a signature over a canonical string.
 *
 * @param {string} cfgCanonical  the exact bytes that were signed
 * @param {string} signatureHex  raw r||s, IEEE P1363, 128 hex chars
 * @param {string} publicKeyHex  04||X||Y, 130 hex chars
 */
export function verifySignature({ cfgCanonical, signatureHex, publicKeyHex }) {
  if (!/^[0-9a-f]{128}$/i.test(String(signatureHex ?? ''))) {
    // 128 hex chars is 64 bytes: r||s in IEEE P1363, which is what WebCrypto
    // produces natively. A 140-ish character value is ASN.1 DER — a different
    // encoding, not interchangeable, and the usual sign that something in the
    // chain converted when it should not have.
    return { valid: false, reason: 'signature must be 128 hex chars (raw r||s, not DER)' };
  }

  let key;
  try {
    key = parsePublicKey(String(publicKeyHex).toLowerCase());
  } catch (err) {
    return { valid: false, reason: err.message };
  }

  try {
    // Verify over the CANONICAL BYTES with digest 'sha256'. The browser signed
    // these same bytes and WebCrypto hashed them internally, so the signature
    // covers SHA-256(cfg_canonical) — which is cfg_hash, and is exactly what
    // mbedTLS verifies prehashed on the ESP32. See the header for the trap.
    const valid = cryptoVerify(
      'sha256',
      Buffer.from(cfgCanonical, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureHex, 'hex')
    );
    return { valid, reason: valid ? null : 'signature does not verify against this key' };
  } catch (err) {
    return { valid: false, reason: `verification failed: ${err.message}` };
  }
}

/**
 * Export the trusted key list in the shape Phase 03 will consume.
 *
 * Not published anywhere yet — `down/keys` is reserved and its root-signing
 * scheme is Phase 03 work. Built now so the storage format is known to be
 * sufficient rather than assumed to be, which is the whole reason keys are
 * stored as raw points instead of DER.
 *
 * Active keys only: a revoked key must not reach a device, even though it stays
 * in the database for verifying history.
 */
export async function exportDeviceKeyList(ghId = 'gh1') {
  const r = await query(
    `SELECT key_id, public_key FROM user_keys WHERE status = 'active' ORDER BY key_id`
  );
  return {
    v: 1,
    gh: ghId,
    // Monotonic, so a device can reject an older list the same way it rejects
    // an older config. Currently derived from the count; Phase 03 will need a
    // persisted counter, since removing a key would otherwise lower it.
    keys_ver: r.rows.length,
    alg: 'es256',
    keys: r.rows.map((k) => ({ key_id: k.key_id, pub: k.public_key })),
  };
}
