/**
 * Tests for provider-crypto.js.
 *
 * PURE — no database, no environment. Runs with `node --test` anywhere.
 *
 * These exist to pin the failure modes the phase record promises: a malformed
 * KEK is rejected (not silently truncated), a tampered ciphertext fails with a
 * distinct code (not garbage), a rotated KEK is distinguishable from tampering
 * by fingerprint, and the plaintext never appears in what gets stored.
 *
 * Run: node --test test/provider-crypto.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  parseKek,
  generateKek,
  kekFingerprint,
  seal,
  open,
  sameFingerprint,
  KekError,
  SealError,
  KEK_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
} from '../src/provider-crypto.js';

const KEK = randomBytes(KEK_BYTES);
const SAMPLE_KEY = 'sk-ant-api03-EXAMPLEEXAMPLEEXAMPLEEXAMPLE-abcd';

// ── KEK parsing ─────────────────────────────────────────────────────────────

test('parseKek: accepts what generateKek produces', () => {
  const raw = generateKek();
  const kek = parseKek(raw);
  assert.equal(kek.length, KEK_BYTES);
  assert.equal(kek.toString('base64'), raw);
});

test('parseKek: tolerates surrounding whitespace (Dokploy paste)', () => {
  const raw = generateKek();
  assert.equal(parseKek(`  ${raw}\n`).toString('base64'), raw);
});

test('parseKek: wrong length is WRONG_LENGTH, not silently truncated', () => {
  for (const n of [16, 31, 33, 64]) {
    assert.throws(
      () => parseKek(randomBytes(n).toString('base64')),
      (e) => e instanceof KekError && e.code === 'WRONG_LENGTH',
      `${n} bytes must be rejected`
    );
  }
});

test('parseKek: not-base64 is MALFORMED', () => {
  assert.throws(() => parseKek('this is not base64 at all!!'), (e) => e instanceof KekError && e.code === 'MALFORMED');
  assert.throws(() => parseKek(''), (e) => e instanceof KekError && e.code === 'MALFORMED');
  assert.throws(() => parseKek(undefined), (e) => e instanceof KekError && e.code === 'MALFORMED');
});

test('parseKek: a KEK with one corrupted character does not decode to the same bytes', () => {
  const raw = generateKek();
  const corrupted = raw.slice(0, 5) + (raw[5] === 'A' ? 'B' : 'A') + raw.slice(6);
  const a = parseKek(raw);
  let b;
  try {
    b = parseKek(corrupted);
  } catch (e) {
    // MALFORMED is also acceptable — the point is it must not equal `a`.
    assert.ok(e instanceof KekError);
    return;
  }
  assert.notDeepEqual(a, b);
});

// ── seal / open ─────────────────────────────────────────────────────────────

test('seal → open round-trips', () => {
  const { ciphertext, nonce, last4 } = seal(KEK, SAMPLE_KEY);
  assert.equal(open(KEK, ciphertext, nonce), SAMPLE_KEY);
  assert.equal(last4, 'abcd');
  assert.equal(nonce.length, NONCE_BYTES);
  assert.equal(ciphertext.length, Buffer.byteLength(SAMPLE_KEY) + TAG_BYTES);
});

test('seal: plaintext never appears in the stored blob', () => {
  const { ciphertext, nonce } = seal(KEK, SAMPLE_KEY);
  const stored = Buffer.concat([ciphertext, nonce]).toString('latin1');
  assert.equal(stored.includes(SAMPLE_KEY), false);
  // Not even a substantial substring — GCM is a stream mode, but with a fresh
  // nonce the keystream is unrelated to the plaintext.
  assert.equal(stored.includes(SAMPLE_KEY.slice(0, 12)), false);
});

test('seal: two seals of the same key produce different nonces and ciphertexts', () => {
  const a = seal(KEK, SAMPLE_KEY);
  const b = seal(KEK, SAMPLE_KEY);
  assert.notDeepEqual(a.nonce, b.nonce);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert.equal(open(KEK, a.ciphertext, a.nonce), open(KEK, b.ciphertext, b.nonce));
});

test('seal: refuses an empty or trivially short plaintext', () => {
  for (const bad of ['', '   ', 'abc', undefined, 42]) {
    assert.throws(() => seal(KEK, bad), (e) => e instanceof SealError && e.code === 'BAD_INPUT');
  }
});

// ── tamper detection ────────────────────────────────────────────────────────

test('open: one flipped ciphertext byte → BAD_TAG, not garbage', () => {
  const { ciphertext, nonce } = seal(KEK, SAMPLE_KEY);
  for (const i of [0, 5, ciphertext.length - TAG_BYTES - 1]) {
    const tampered = Buffer.from(ciphertext);
    tampered[i] ^= 0x01;
    assert.throws(() => open(KEK, tampered, nonce), (e) => e instanceof SealError && e.code === 'BAD_TAG', `byte ${i}`);
  }
});

test('open: one flipped tag byte → BAD_TAG', () => {
  const { ciphertext, nonce } = seal(KEK, SAMPLE_KEY);
  const tampered = Buffer.from(ciphertext);
  tampered[tampered.length - 1] ^= 0x80;
  assert.throws(() => open(KEK, tampered, nonce), (e) => e instanceof SealError && e.code === 'BAD_TAG');
});

test('open: altered nonce → BAD_TAG; wrong-length nonce → BAD_NONCE', () => {
  const { ciphertext, nonce } = seal(KEK, SAMPLE_KEY);
  const altered = Buffer.from(nonce);
  altered[3] ^= 0xff;
  assert.throws(() => open(KEK, ciphertext, altered), (e) => e.code === 'BAD_TAG');
  assert.throws(() => open(KEK, ciphertext, randomBytes(16)), (e) => e.code === 'BAD_NONCE');
});

test('open: truncated blob → BAD_INPUT', () => {
  const { nonce } = seal(KEK, SAMPLE_KEY);
  assert.throws(() => open(KEK, randomBytes(TAG_BYTES), nonce), (e) => e.code === 'BAD_INPUT');
});

test('open: a different KEK cannot open the blob (rotation scenario)', () => {
  const { ciphertext, nonce } = seal(KEK, SAMPLE_KEY);
  const rotated = randomBytes(KEK_BYTES);
  assert.throws(() => open(rotated, ciphertext, nonce), (e) => e.code === 'BAD_TAG');
});

// ── fingerprint ─────────────────────────────────────────────────────────────

test('kekFingerprint: 16 hex chars, stable, distinct across KEKs', () => {
  const fp = kekFingerprint(KEK);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, kekFingerprint(KEK));
  assert.notEqual(fp, kekFingerprint(randomBytes(KEK_BYTES)));
});

test('fingerprint distinguishes rotation from tampering', () => {
  // Same GCM failure in both cases; the fingerprint is what tells them apart.
  const storedFp = kekFingerprint(KEK);
  const { ciphertext, nonce } = seal(KEK, SAMPLE_KEY);

  // Case A — KEK rotated: open fails AND fingerprint differs → expected, re-enter.
  const rotated = randomBytes(KEK_BYTES);
  assert.throws(() => open(rotated, ciphertext, nonce), (e) => e.code === 'BAD_TAG');
  assert.equal(sameFingerprint(kekFingerprint(rotated), storedFp), false);

  // Case B — ciphertext tampered: open fails AND fingerprint matches → alarm.
  const tampered = Buffer.from(ciphertext);
  tampered[2] ^= 0x10;
  assert.throws(() => open(KEK, tampered, nonce), (e) => e.code === 'BAD_TAG');
  assert.equal(sameFingerprint(kekFingerprint(KEK), storedFp), true);
});

test('sameFingerprint: false on type or length mismatch, never throws', () => {
  assert.equal(sameFingerprint('abcd', 'abcde'), false);
  assert.equal(sameFingerprint(undefined, 'abcd'), false);
  assert.equal(sameFingerprint('0123456789abcdef', '0123456789abcdef'), true);
});

// ── guard rails ─────────────────────────────────────────────────────────────

test('seal/open/fingerprint refuse a wrong-size KEK', () => {
  const short = randomBytes(16);
  assert.throws(() => seal(short, SAMPLE_KEY), (e) => e instanceof KekError);
  assert.throws(() => kekFingerprint(short), (e) => e instanceof KekError);
  const { ciphertext, nonce } = seal(KEK, SAMPLE_KEY);
  assert.throws(() => open(short, ciphertext, nonce), (e) => e instanceof KekError);
});
