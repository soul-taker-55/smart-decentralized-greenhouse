/**
 * SDIGF Phase 05c — envelope encryption for the AI provider API key.
 *
 * PURE MODULE. No database, no environment access, no logging. It takes bytes
 * in and gives bytes out, so it can be tested with `node --test` on a machine
 * with nothing installed, in the same way canon.js and ledger-link.js are.
 *
 * The design it implements (see db/007_provider_settings.sql for the threat
 * model): the API key is sealed with AES-256-GCM under a key-encrypting key
 * (KEK) that lives only in the environment. The database holds ciphertext and
 * nonce; the environment holds the KEK; only the running backend holds both.
 *
 * Why GCM and not CBC: GCM authenticates. A ciphertext that was altered fails
 * to open with a distinct error, instead of opening into garbage that would be
 * sent to the provider as a "key" and produce a confusing 401 somewhere far
 * from the actual fault.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class KekError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'KekError';
    this.code = code; // 'MALFORMED' | 'WRONG_LENGTH'
  }
}

export class SealError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SealError';
    this.code = code; // 'BAD_TAG' | 'BAD_NONCE' | 'BAD_INPUT'
  }
}

/** AES-256 wants exactly this many key bytes. */
export const KEK_BYTES = 32;
/** GCM's recommended nonce length. Enforced here and by a CHECK in the table. */
export const NONCE_BYTES = 12;
/** GCM tag length. Appended to the ciphertext so the row stores one blob. */
export const TAG_BYTES = 16;

/**
 * Associated data bound into every seal. It is authenticated but not
 * encrypted, and it exists so a ciphertext from this table cannot be lifted
 * and presented as something else (or a future table's blob presented here)
 * without the tag failing. Bump the suffix if the format ever changes.
 */
export const AAD = Buffer.from('sdigf.provider_settings.api_key.v1', 'utf8');

/**
 * Parse a KEK from its environment representation: 32 random bytes, base64.
 *
 * The two failure classes are deliberately distinct. An ABSENT KEK is not an
 * error at all — the backend starts and the chat reports that the server
 * administrator has not configured it. A PRESENT-BUT-MALFORMED KEK is a
 * configuration mistake in the same class as a weak bootstrap password, and
 * the caller (index.js) treats it as fatal. This function handles only the
 * second class; absence is the caller's decision.
 *
 * @param {string} raw  Value of PROVIDER_KEK.
 * @returns {Buffer}    Exactly 32 bytes.
 */
export function parseKek(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new KekError('PROVIDER_KEK is empty', 'MALFORMED');
  }
  const trimmed = raw.trim();
  // Node's base64 decoder is permissive; round-trip to reject anything that
  // only looks like base64. A KEK that was pasted with a stray character must
  // fail here, not decrypt nothing later.
  const buf = Buffer.from(trimmed, 'base64');
  const unpadded = (s) => s.replace(/=+$/, '');
  if (unpadded(buf.toString('base64')) !== unpadded(trimmed)) {
    throw new KekError('PROVIDER_KEK is not valid base64', 'MALFORMED');
  }
  if (buf.length !== KEK_BYTES) {
    throw new KekError(
      `PROVIDER_KEK must decode to exactly ${KEK_BYTES} bytes, got ${buf.length}`,
      'WRONG_LENGTH'
    );
  }
  return buf;
}

/**
 * Generate a fresh KEK in the format PROVIDER_KEK expects. Exposed so the
 * server administrator has one documented, CSPRNG-backed way to produce it
 * (`node -e "import('./src/provider-crypto.js').then(m=>console.log(m.generateKek()))"`)
 * rather than improvising with a password manager or, worse, deriving it from
 * another secret.
 */
export function generateKek() {
  return randomBytes(KEK_BYTES).toString('base64');
}

/**
 * First 16 hex characters of SHA-256(kek). Stored alongside each row so the
 * backend can distinguish "KEK rotated" from "ciphertext tampered" — the two
 * cases produce the same GCM failure and deserve different log lines.
 * 64 bits of a hash of a 256-bit random key reveals nothing usable.
 */
export function kekFingerprint(kek) {
  assertKek(kek);
  return createHash('sha256').update(kek).digest('hex').slice(0, 16);
}

/**
 * Seal a plaintext under the KEK.
 *
 * @param {Buffer} kek
 * @param {string} plaintext  The API key as pasted.
 * @returns {{ ciphertext: Buffer, nonce: Buffer, last4: string }}
 *   `ciphertext` is ct || tag. `nonce` is fresh and random. `last4` is the
 *   only fragment that will ever be displayed again.
 */
export function seal(kek, plaintext) {
  assertKek(kek);
  if (typeof plaintext !== 'string' || plaintext.length < 8) {
    // Not a security bound — a real provider key is far longer — but a guard
    // against sealing an empty field or a whitespace paste as if it were a key.
    throw new SealError('plaintext must be a string of at least 8 characters', 'BAD_INPUT');
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([ct, tag]),
    nonce,
    last4: plaintext.slice(-4),
  };
}

/**
 * Open a sealed blob. Throws SealError('BAD_TAG') on ANY alteration of the
 * ciphertext, nonce, AAD or key — the caller decides whether that means
 * rotation or tampering by comparing kekFingerprint() against the stored one.
 *
 * @param {Buffer} kek
 * @param {Buffer} ciphertext  ct || tag, as stored.
 * @param {Buffer} nonce
 * @returns {string}           The plaintext. Caller must not log or return it.
 */
export function open(kek, ciphertext, nonce) {
  assertKek(kek);
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
    throw new SealError(`nonce must be ${NONCE_BYTES} bytes`, 'BAD_NONCE');
  }
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length <= TAG_BYTES) {
    throw new SealError('ciphertext is too short to contain a tag', 'BAD_INPUT');
  }
  const ct = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', kek, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Node reports "Unsupported state or unable to authenticate data". That
    // message is unhelpful in a log line; the code is what the caller keys on.
    throw new SealError('authentication tag mismatch', 'BAD_TAG');
  }
}

/**
 * Constant-time comparison of two fingerprints. Not strictly necessary for a
 * non-secret truncated hash, but it costs nothing and avoids anyone later
 * reasoning about whether it mattered.
 */
export function sameFingerprint(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function assertKek(kek) {
  if (!Buffer.isBuffer(kek) || kek.length !== KEK_BYTES) {
    throw new KekError(`kek must be a ${KEK_BYTES}-byte Buffer`, 'WRONG_LENGTH');
  }
}
