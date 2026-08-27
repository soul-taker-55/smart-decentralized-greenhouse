// SDIGF mock edge — inbound message handling.
//
// ═══════════════════════════════════════════════════════════════════════════
// THIS FILE IS THE REFERENCE FOR PHASE 02 FIRMWARE.
// ═══════════════════════════════════════════════════════════════════════════
//
// The sequence below — parse, check schema, check integrity, check freshness,
// check the safety envelope, apply, acknowledge — is what the ESP32 will do in
// C++. The ORDER MATTERS and is not arbitrary:
//
//   1. PARSE first.        Nothing else can be checked on bytes that are not
//                          valid JSON.
//   2. SCHEMA next.        An unsupported envelope version means the fields
//                          below may not mean what this firmware thinks.
//   3. INTEGRITY next.     If cfg_hash does not match the bytes received, the
//                          payload is corrupt or tampered and every value in
//                          it is untrustworthy — including `ver`, so freshness
//                          cannot be checked yet either.
//   4. FRESHNESS next.     Reject a replay before spending effort validating
//                          values that may be an old config resent.
//   5. ENVELOPE next.      Only now, on a payload known intact and current, is
//                          it worth asking whether the values are survivable.
//   6. APPLY, then ACK.    Apply before acknowledging, so an ack never claims
//                          something the device has not actually done.
//
// Reordering these produces subtly wrong behaviour rather than obvious
// failures. Checking the envelope before the hash, for instance, means
// rejecting a corrupt payload with a field-specific ENVELOPE error that sends
// an operator hunting for a config mistake that does not exist.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE HASH IS COMPUTED OVER THE BYTES AS RECEIVED. NEVER RE-SERIALIZE.
// ═══════════════════════════════════════════════════════════════════════════
//
// `cfg_canonical` is on the wire precisely so the edge never has to implement
// canonicalization. Hash the raw string exactly as it arrived. Parsing it and
// re-serializing would reintroduce every cross-language formatting difference
// that cfg_canonical exists to eliminate, and the mismatch would appear only
// for configs containing whatever construct the two serializers disagree on.

import { createHash } from 'node:crypto';
import { checkEnvelope, checkCommand } from './safety.js';

/**
 * Contract v4 §3.4 rejection codes. Structured, never free text — the dashboard
 * renders them, the ledger records them, and the thesis counts them by
 * category. Free-form strings cannot be aggregated.
 */
export const REJECT = {
  PARSE: 'PARSE',
  SCHEMA: 'SCHEMA',
  SEQ_STALE: 'SEQ_STALE',
  GH_MISMATCH: 'GH_MISMATCH',
  ESTOP: 'ESTOP',
  HASH_MISMATCH: 'HASH_MISMATCH',
  NOT_NEWER: 'NOT_NEWER',
  VER_STALE: 'VER_STALE',
  ENVELOPE: 'ENVELOPE',
};

const SUPPORTED_SCHEMA_V = 1;

/**
 * Handle a down/config message.
 *
 * @param {Buffer} raw     bytes exactly as received
 * @param {EdgeState} state
 * @param {string} ghId
 * @returns {{result:'accepted'|'rejected', ref, applied, reason, cancelledOverrides?}}
 */
export function handleConfig(raw, state, ghId) {
  const reject = (code, field, detail, ref = { ver: null, hash: null }) => ({
    result: 'rejected',
    ref,
    applied: state.appliedRef(),
    reason: { code, field, detail },
  });

  // ── 1. Parse ──────────────────────────────────────────────────────────────
  const text = raw.toString('utf8');

  // An empty retained payload is how a retained message is DELETED, not a
  // malformed config. The server clears down/config this way when no profile is
  // active, and every subscriber sees it on connect. Checked BEFORE parsing —
  // JSON.parse('') throws, which would report a spurious PARSE rejection on
  // every startup against a system with no active config.
  if (text.trim() === '') {
    return { result: 'ignored', reason: { code: null, detail: 'retained config cleared by the server' } };
  }

  let msg;
  try {
    msg = JSON.parse(text);
  } catch (err) {
    return reject(REJECT.PARSE, null, `not valid JSON: ${err.message}`);
  }

  const ref = { ver: msg.ver ?? null, hash: msg.cfg_hash ?? null };

  // ── 2. Schema ─────────────────────────────────────────────────────────────
  if (msg.v !== SUPPORTED_SCHEMA_V) {
    return reject(REJECT.SCHEMA, 'v', `unsupported schema version ${msg.v}`, ref);
  }
  for (const field of ['ver', 'gh', 'cfg_hash', 'cfg_canonical']) {
    if (msg[field] === undefined || msg[field] === null) {
      return reject(REJECT.PARSE, field, 'required field missing', ref);
    }
  }

  // ── 3. Integrity ──────────────────────────────────────────────────────────
  // SHA-256 of the UTF-8 bytes of cfg_canonical, lowercase hex, as received.
  const computed = createHash('sha256').update(msg.cfg_canonical, 'utf8').digest('hex');
  if (computed !== String(msg.cfg_hash).toLowerCase()) {
    return reject(
      REJECT.HASH_MISMATCH,
      'cfg_hash',
      `computed ${computed.slice(0, 16)}… over the received bytes, envelope claims ${String(msg.cfg_hash).slice(0, 16)}…`,
      ref
    );
  }

  // The signed content must now be parseable — the hash just proved it intact.
  let signed;
  try {
    signed = JSON.parse(msg.cfg_canonical);
  } catch (err) {
    return reject(REJECT.PARSE, 'cfg_canonical', `intact but unparseable: ${err.message}`, ref);
  }

  // ── 4. Freshness, and envelope-vs-signed agreement ────────────────────────
  //
  // v4 moved `ver` and `gh` INSIDE the signed content specifically to close a
  // replay/downgrade hole: in v3 the hash covered `cfg` alone, so an
  // administrator could take any legitimately signed config, republish it with
  // ver bumped, and permanently pin a device against every future config — with
  // genuine signatures and no forgery required.
  //
  // The envelope copies are convenience only. THE SIGNED COPIES WIN, and a
  // disagreement between them is itself the attack signature.
  if (signed.ver !== msg.ver || signed.gh !== msg.gh) {
    return reject(
      REJECT.VER_STALE,
      null,
      `envelope (ver ${msg.ver}, gh ${msg.gh}) disagrees with signed content (ver ${signed.ver}, gh ${signed.gh})`,
      ref
    );
  }
  if (signed.gh !== ghId) {
    return reject(REJECT.VER_STALE, 'gh', `addressed to ${signed.gh}, this device is ${ghId}`, ref);
  }
  // Monotonic versions are the replay defence. Equal counts as stale: a config
  // already applied has nothing to add, and re-applying would cancel active
  // overrides for no reason.
  if (signed.ver <= state.applied.ver) {
    return reject(
      REJECT.NOT_NEWER,
      'ver',
      `received ver ${signed.ver}, already running ver ${state.applied.ver}`,
      ref
    );
  }

  // ── 5. Safety envelope ────────────────────────────────────────────────────
  //
  // The second gate, and independent of the first. A config signed by a full
  // quorum is still rejected here if the values would damage equipment. Server
  // RBAC and edge safety answer different questions, and neither substitutes
  // for the other.
  //
  // NOTE ON SIGNATURES: this mock does NOT verify them, and never will. It
  // stands in for firmware; claiming `enforced` would put a capability the
  // hardware does not have into the event log and onto the dashboard. Signature
  // verification is Phase 03 firmware work. `verify` stays 'unsupported', and
  // a device reporting `unsupported` still applies configs that clear the
  // envelope — failing closed would mean an unverifying device ignores every
  // configuration ever sent to it.
  const violations = checkEnvelope(signed.cfg);
  if (violations.length > 0) {
    const first = violations[0];
    return reject(
      REJECT.ENVELOPE,
      first.field,
      violations.length === 1
        ? first.detail
        : `${first.detail} (and ${violations.length - 1} more)`,
      ref
    );
  }

  // ── 6. Apply, then acknowledge ────────────────────────────────────────────
  //
  // §3.9 rule 3: while stopped, a config is STORED but not acted on. Refusing
  // it outright would mean a halted greenhouse could not be reconfigured before
  // being restarted — which is exactly when reconfiguring is most likely.
  const cancelled = state.applyConfig({
    ver: signed.ver,
    hash: msg.cfg_hash,
    cfg: signed.cfg,
    src: 'mqtt',
  });

  return {
    result: 'accepted',
    ref,
    applied: state.appliedRef(),
    reason: null,
    cancelledOverrides: cancelled,
  };
}

/**
 * Handle a down/estop message. Contract v4 §3.9.
 *
 * Persist BEFORE acknowledging. An ack claiming a stop that was not written to
 * NVS would survive a power cut as a lie — the server would believe the
 * greenhouse is halted and the hardware would come back running.
 */
export function handleEstop(raw, state, ghId) {
  const text = raw.toString('utf8');
  if (text.trim() === '') {
    return { result: 'ignored', reason: { code: null, detail: 'retained estop cleared' } };
  }

  let msg;
  try {
    msg = JSON.parse(text);
  } catch (err) {
    return {
      result: 'rejected',
      estopSeq: null,
      applied: { estop: state.estop.active },
      reason: { code: REJECT.PARSE, field: null, detail: `not valid JSON: ${err.message}` },
    };
  }

  const seq = msg.seq;
  const reject = (code, field, detail) => ({
    result: 'rejected',
    estopSeq: seq ?? null,
    applied: { estop: state.estop.active, seq: state.estop.seq },
    reason: { code, field, detail },
  });

  if (msg.v !== SUPPORTED_SCHEMA_V) return reject(REJECT.SCHEMA, 'v', `unsupported schema ${msg.v}`);
  if (msg.gh !== ghId) return reject(REJECT.GH_MISMATCH, 'gh', `addressed to ${msg.gh}, this device is ${ghId}`);
  if (!Number.isInteger(seq)) return reject(REJECT.PARSE, 'seq', 'required, must be an integer');
  if (!['stopped', 'clear'].includes(msg.state)) {
    return reject(REJECT.PARSE, 'state', 'must be stopped or clear');
  }

  const outcome = state.setEstop({ seq, state: msg.state, reason: msg.reason, by: msg.by });

  // A stale replay is IGNORED, not acked. Acking a redelivered retained message
  // every reconnect would fill the audit trail with noise that looks like
  // repeated emergencies.
  if (!outcome.applied) {
    return { result: 'ignored', estopSeq: seq, reason: { code: REJECT.SEQ_STALE, detail: outcome.ignored } };
  }

  return {
    result: 'accepted',
    estopSeq: seq,
    applied: { estop: state.estop.active, seq: state.estop.seq },
    reason: null,
  };
}

/**
 * Handle a down/cmd message.
 *
 * Commands are NOT retained — contract §3.7. A retained command would re-fire
 * on every reconnect, meaning a pump switched on manually last week restarts
 * itself after a power cut. Commands are events with an expiry; state belongs
 * on the config topic.
 */
export function handleCommand(raw, state) {
  const reject = (code, field, detail, id = null) => ({
    result: 'rejected',
    id,
    applied: state.appliedRef(),
    reason: { code, field, detail },
  });

  let cmd;
  try {
    cmd = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return reject(REJECT.PARSE, null, `not valid JSON: ${err.message}`);
  }

  if (cmd.v !== SUPPORTED_SCHEMA_V) {
    return reject(REJECT.SCHEMA, 'v', `unsupported schema version ${cmd.v}`, cmd.id ?? null);
  }

  // §3.9 rule 3: while stopped, down/cmd is ignored entirely. A halted
  // greenhouse that still honoured manual commands would not be halted.
  if (state.estop.active) {
    return reject(
      REJECT.ESTOP,
      null,
      'emergency stop is active; manual commands are refused until it is cleared',
      cmd.id ?? null
    );
  }
  if (!cmd.id) {
    // Without an id the server cannot correlate the ack, so the command becomes
    // unaccountable even if it succeeds.
    return reject(REJECT.PARSE, 'id', 'required for ack correlation');
  }

  // The same equipment limits that gate a config gate a command. A command
  // bypasses the control loop, so without this the envelope has a hole the size
  // of the dashboard.
  const violations = checkCommand(cmd);
  if (violations.length > 0) {
    const first = violations[0];
    return reject(REJECT.ENVELOPE, first.field, first.detail, cmd.id);
  }

  const { released, existed } = state.setOverride({
    target: cmd.target,
    action: cmd.action,
    value: cmd.value,
    ttl_s: cmd.ttl_s,
    id: cmd.id,
    // `via` distinguishes a dashboard command from an AI-issued one. The
    // contract's down/cmd carries `by` (user and role) but no channel field —
    // recorded here when present, and noted as a v5 gap otherwise.
    via: cmd.via ?? cmd.by?.via ?? null,
  });

  return {
    result: 'accepted',
    id: cmd.id,
    applied: state.appliedRef(),
    reason: null,
    detail: released
      ? existed
        ? `${cmd.target} handed back to autonomous control`
        : `${cmd.target} was already under autonomous control`
      : `${cmd.target} overridden for ${cmd.ttl_s}s`,
  };
}
