/**
 * SDIGF — password hashing.
 *
 * scrypt, from Node's standard library. Argon2id would be the marginally better
 * choice on paper, but every Node binding for it is a native module — a compiler
 * toolchain in the image, and a dependency that can fail to build on a version
 * bump. scrypt is memory-hard, is in the crypto module already, and is not the
 * weak link here.
 *
 * Stored form:  scrypt$N$r$p$<salt-hex>$<hash-hex>
 *
 * The parameters travel WITH the hash rather than living in a constant. Raising
 * the cost later must not invalidate existing passwords: an old hash carries the
 * parameters it was made with, verifies against those, and can be transparently
 * upgraded on the user's next successful login.
 */

import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

// N=2^15 keeps a single hash around 100 ms on modest hardware — slow enough to
// make offline cracking expensive, fast enough that a login does not feel
// broken. Node's default maxmem must be raised to accommodate N this large.
const N = 32768;
const r = 8;
const p = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

/** Hash a password for storage. */
export async function hashPassword(plain) {
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Comparison is timing-safe. A byte-by-byte comparison that returns early leaks
 * how much of the hash matched, which over many attempts is enough to recover
 * it — an old attack, but one that costs nothing to avoid.
 */
export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');

  let derived;
  try {
    derived = await scrypt(plain, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
      maxmem: MAXMEM,
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Obviously-guessable passwords, refused outright.
 *
 * Not a substitute for a breach corpus — this catches the handful that appear in
 * every bootstrap script and demo deployment, which is exactly the risk here.
 * The bootstrap admin is the one account created without anyone approving it,
 * and it exists before any audit trail does.
 */
const OBVIOUS = new Set([
  'password', 'password1', 'password123', 'passw0rd',
  'admin', 'admin123', 'administrator', 'root', 'toor',
  'changeme', 'letmein', 'welcome', 'secret', 'default',
  'qwerty', '12345678', '123456789', '1234567890',
  'sdigf', 'greenhouse', 'greenhouse123',
]);

const MIN_LENGTH = 12;

/**
 * Check a password against policy.
 *
 * Length first. Composition rules ("one uppercase, one symbol") reliably produce
 * `Password1!` and little else, so length carries the weight here and the
 * blocklist catches the specific strings that would otherwise slip through it.
 *
 * @returns {string[]} reasons it was refused; empty means acceptable
 */
export function checkPasswordStrength(plain) {
  const problems = [];

  if (typeof plain !== 'string' || plain.length === 0) {
    return ['no password supplied'];
  }
  if (plain.length < MIN_LENGTH) {
    problems.push(`must be at least ${MIN_LENGTH} characters, got ${plain.length}`);
  }

  const lower = plain.toLowerCase();
  if (OBVIOUS.has(lower)) {
    problems.push('is a commonly used password');
  }
  // Catches `greenhouse123`, `admin2024` and similar — an obvious base with a
  // short numeric tail is the most common way a blocklist gets sidestepped.
  for (const bad of OBVIOUS) {
    if (lower.startsWith(bad) && /^\d{0,4}[!@#$%^&*]?$/.test(lower.slice(bad.length))) {
      problems.push(`is a commonly used password with digits appended`);
      break;
    }
  }
  if (/^(.)\1+$/.test(plain)) {
    problems.push('is a single repeated character');
  }
  if (new Set(plain).size < 5) {
    problems.push('uses too few distinct characters');
  }

  return problems;
}
