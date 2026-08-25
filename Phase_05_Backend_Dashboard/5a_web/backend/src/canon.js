/**
 * SDIGF — canonical serialization and hashing.
 *
 * THE SINGLE IMPLEMENTATION. Contract v4 §5. Do not write a second one.
 *
 * The whole point of `cfg_canonical` existing on the wire is that exactly one
 * serializer produces it. The edge hashes the bytes it received and never
 * re-serializes; the browser signs the same string in 05b. A second
 * implementation anywhere reintroduces the drift this design exists to kill.
 *
 * SOURCE OF TRUTH — the frozen test vector from contract v4 §5:
 *   input   {"a":[3,1,2],"b":{"x":1,"y":2},"c":null,"d":true}
 *   sha256  911a7250d4853dec84df401015ab201c6241ee1c87fb6e70862afd13e087a908
 * If a change to this file breaks that vector, the change is wrong, not the vector.
 *
 * RULES (§5 "Canonicalization rules"):
 *   - object KEYS sorted recursively (lexicographic, by UTF-16 code unit — JS default)
 *   - ARRAYS keep their order; they are data, not sets
 *   - no whitespace anywhere
 *   - integers only, no floats
 *   - nulls included, never dropped
 *   - no trailing newline
 */

import { createHash } from 'node:crypto';

/**
 * Thrown when a value cannot be canonicalized. Carries the path to the offending
 * value so a validation error can name the field, matching the `field` path that
 * up/ack rejection reasons use (e.g. "cfg.pump.max_runtime_s").
 */
export class CanonError extends Error {
  constructor(message, path) {
    super(path ? `${message} at ${path}` : message);
    this.name = 'CanonError';
    this.path = path;
  }
}

/**
 * Serialize a value to its canonical string form.
 *
 * @param {*} value
 * @param {string} [path] - internal, for error messages
 * @returns {string}
 */
export function canonicalize(value, path = '') {
  // null is a value, not an absence. The config uses it to mark fields the
  // agriculture engineer must supply, so dropping it would change the shape.
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    // Floats are the single most common cause of cross-language hash mismatch:
    // JS writes 1.0 as "1", C prints "1.000000". The contract forbids them
    // outright — temperatures are deci-Celsius integers instead.
    if (!Number.isInteger(value)) {
      throw new CanonError(`non-integer number ${value} (contract v4 forbids floats)`, path);
    }
    if (!Number.isSafeInteger(value)) {
      throw new CanonError(`integer ${value} exceeds safe range`, path);
    }
    // Number.isInteger(-0) is true and String(-0) is "0", which is what we want:
    // -0 and 0 must not produce different hashes.
    return String(value);
  }

  if (t === 'string') {
    // JSON.stringify handles escaping (quotes, backslashes, control chars,
    // lone surrogates) exactly as JSON requires. Hand-rolling this is a
    // reliable way to produce bytes no other language agrees with.
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    // Order preserved. vent.stage_offsets_dc [0,20,40] means stage 1, 2, 3 —
    // sorting it would silently reassign which fan runs when.
    return '[' + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',') + ']';
  }

  if (t === 'object') {
    // Reject things that look like objects but serialize unpredictably.
    if (value instanceof Date) {
      throw new CanonError('Date is not canonicalizable; use an integer timestamp', path);
    }

    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      // undefined has no JSON representation. Silently dropping it would let a
      // typo'd field vanish from the hash while looking present in the editor.
      if (v === undefined) {
        throw new CanonError(`undefined value for key "${k}" (use null to mark unset)`, path);
      }
      parts.push(JSON.stringify(k) + ':' + canonicalize(v, path ? `${path}.${k}` : k));
    }
    return '{' + parts.join(',') + '}';
  }

  throw new CanonError(`unsupported type "${t}"`, path);
}

/**
 * SHA-256 of the UTF-8 bytes of a canonical string, lowercase hex.
 *
 * Contract §3.6: "SHA-256 of the UTF-8 bytes of cfg_canonical, lowercase hex.
 * Not of a re-serialization."
 *
 * @param {string} canonicalString
 * @returns {string} 64 lowercase hex chars
 */
export function hashCanonical(canonicalString) {
  if (typeof canonicalString !== 'string') {
    throw new CanonError('hashCanonical expects the canonical string, not an object');
  }
  return createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

/**
 * Build the signed content for down/config and return both the canonical string
 * and its hash.
 *
 * `gh` and `ver` live INSIDE the signed content, not just the envelope. Contract
 * v4 moved them there to close a replay/downgrade hole: in v3 the hash covered
 * `cfg` alone, so an administrator could take any legitimately signed config,
 * republish it with ver bumped to 99, and permanently pin the device against
 * every future config — with genuine signatures and no forgery required.
 *
 * @param {object} cfg - the config object, contract §4 shape
 * @param {string} ghId - greenhouse id, e.g. "gh1"
 * @param {number} ver - monotonic config version
 * @returns {{ cfgCanonical: string, cfgHash: string }}
 */
export function buildSignedContent(cfg, ghId, ver) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new CanonError('cfg must be an object');
  }
  if (typeof ghId !== 'string' || ghId.length === 0) {
    throw new CanonError('gh must be a non-empty string');
  }
  if (!Number.isInteger(ver) || ver < 0) {
    throw new CanonError('ver must be a non-negative integer');
  }

  const cfgCanonical = canonicalize({ cfg, gh: ghId, ver });
  return { cfgCanonical, cfgHash: hashCanonical(cfgCanonical) };
}

/**
 * Verify this implementation still reproduces the frozen vector.
 *
 * Called at service startup. A canonicalizer that has silently drifted produces
 * hashes that look fine and that no device will ever accept — so failing loudly
 * on boot is far better than discovering it when a config is rejected in the field.
 *
 * @throws {Error} if the vector does not reproduce
 */
export function assertFrozenVector() {
  const input = { a: [3, 1, 2], b: { x: 1, y: 2 }, c: null, d: true };
  const expectedCanonical = '{"a":[3,1,2],"b":{"x":1,"y":2},"c":null,"d":true}';
  const expectedHash = '911a7250d4853dec84df401015ab201c6241ee1c87fb6e70862afd13e087a908';

  const actualCanonical = canonicalize(input);
  if (actualCanonical !== expectedCanonical) {
    throw new Error(
      `Canonicalization drift: expected ${expectedCanonical} but got ${actualCanonical}`
    );
  }

  const actualHash = hashCanonical(actualCanonical);
  if (actualHash !== expectedHash) {
    throw new Error(`Canonicalization drift: expected hash ${expectedHash} but got ${actualHash}`);
  }
}
