/**
 * SDIGF dashboard — signing keys, in the browser.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PRIVATE KEY NEVER LEAVES THIS DEVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Keypairs are generated here, by WebCrypto. Only the public half is sent to
 * the server. That is what makes an approval unforgeable by whoever runs the
 * server: they can read every row of the database and still cannot produce a
 * signature that was never given.
 *
 * ─── HOW THE KEY IS STORED, AND WHY IN TWO FORMS ───────────────────────────
 *
 * Generated EXTRACTABLE, exported once for the operator's backup, then
 * re-imported NON-EXTRACTABLE and kept in IndexedDB for daily use.
 *
 * The two-step exists because the two needs conflict. A key that can never be
 * exported cannot be backed up, and losing a browser profile would mean losing
 * the ability to approve anything. A key that remains extractable can be read
 * by any script that runs on this origin — an XSS bug becomes a stolen signing
 * identity. Exporting once, then discarding extractability, gives a backup
 * without leaving the key readable afterwards.
 *
 * The backup is the operator's problem from that moment on, and deliberately
 * so. There is no recovery path: the server has no copy to send.
 */

const DB_NAME = 'sdigf-keys';
const STORE = 'keys';
const KEY_RECORD = 'signing-key';

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// Key lifecycle
// ---------------------------------------------------------------------------

/**
 * Generate a keypair and return everything needed to register and back it up.
 *
 * Nothing is stored yet — the caller must confirm the operator has saved the
 * backup first. A key stored before its backup is acknowledged is a key that
 * can be lost between two clicks.
 */
export async function generateKeypair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, // extractable, for this one export
    ['sign', 'verify']
  );

  // Raw uncompressed point, 04||X||Y. This is the form the server stores and
  // the form Phase 03 ships to the ESP32 — a fixed-length field needing no
  // DER parser on the device.
  const publicKeyHex = toHex(await crypto.subtle.exportKey('raw', kp.publicKey));

  // JWK for the backup: self-describing, and re-importable by any WebCrypto
  // implementation without the operator needing to know what a curve is.
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);

  return { keyPair: kp, publicKeyHex, privateJwk };
}

/**
 * Store the key for daily use, discarding extractability.
 *
 * Re-imported with extractable: false, so from here on the key can sign but
 * cannot be read back out — not by this application, and not by anything else
 * that manages to run on this origin.
 */
export async function persistKey({ privateJwk, publicKeyHex, keyId, userId }) {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // NOT extractable — the backup already exists, this copy is for use
    ['sign']
  );

  await idbPut(KEY_RECORD, { privateKey, publicKeyHex, keyId, userId, storedAt: Date.now() });
}

/** The stored key, or null. Null is ordinary on a new browser. */
export async function loadKey() {
  return idbGet(KEY_RECORD);
}

/** Remove the key from this browser. Does not revoke it server-side. */
export async function forgetKey() {
  await idbDelete(KEY_RECORD);
}

/**
 * Restore from a backup file.
 *
 * Imported non-extractable, exactly like a freshly generated key — a restored
 * key is no more readable than the original. The public half is recomputed
 * from the JWK rather than trusted from the file, so a tampered backup
 * produces a key that simply will not match any registered key_id.
 */
export async function restoreFromBackup(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) {
    throw new Error('This is not an SDIGF signing key backup.');
  }

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  // Recompute the public half from the JWK's own coordinates.
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
  const publicKeyHex = toHex(await crypto.subtle.exportKey('raw', publicKey));

  await idbPut(KEY_RECORD, { privateKey, publicKeyHex, keyId: null, userId: null, storedAt: Date.now() });
  return { publicKeyHex };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Sign a config's canonical string.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SIGN THE CANONICAL BYTES. NEVER SIGN cfg_hash.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WebCrypto has no prehashed mode. Passing cfg_hash here as the data would sign
 * SHA-256(cfg_hash) — a double hash. It verifies perfectly in this browser and
 * is rejected by mbedTLS on the ESP32, which verifies against cfg_hash
 * directly. The failure surfaces as an approved config the hardware refuses,
 * with nothing in the browser to indicate why.
 *
 * Signing cfg_canonical lets WebCrypto's internal SHA-256 produce a signature
 * over cfg_hash, which is exactly what the device checks.
 *
 * Contract v4 §5 documented this the wrong way round until 2026-08-26.
 *
 * @param {string} cfgCanonical the exact string the server stored
 * @returns {Promise<string>} raw r||s as 128 hex chars (IEEE P1363)
 */
export async function signCanonical(cfgCanonical) {
  const record = await loadKey();
  if (!record) {
    throw new Error('No signing key on this device. Register or restore one first.');
  }

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    record.privateKey,
    new TextEncoder().encode(cfgCanonical) // ← the bytes, not the hash
  );

  // WebCrypto emits raw r||s, which is what the server and the contract expect.
  // ASN.1 DER would be ~140 hex chars and is a different encoding entirely;
  // the firmware converts, not this.
  return toHex(signature);
}

// ---------------------------------------------------------------------------
// Backup artefacts
// ---------------------------------------------------------------------------

/** Downloadable backup file. The only copy of the private key that will exist. */
export function backupBlob({ privateJwk, publicKeyHex, username, keyId }) {
  const payload = {
    _warning:
      'This file contains a PRIVATE SIGNING KEY. Anyone holding it can approve greenhouse configuration changes as you. Store it offline. There is no way to recover it if lost — the server does not have a copy.',
    system: 'SDIGF',
    username,
    keyId,
    publicKey: publicKeyHex,
    privateKey: privateJwk,
    createdAt: new Date().toISOString(),
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

export function backupFilename(username) {
  const date = new Date().toISOString().slice(0, 10);
  return `sdigf-signing-key-${username || 'engineer'}-${date}.json`;
}
