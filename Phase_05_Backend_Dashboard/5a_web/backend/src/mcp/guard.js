/**
 * SDIGF Phase 05c — the guard.
 *
 * PURE MODULE. Text in, verdict out. No provider, no database, no I/O.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The brief tells the model the rules. The tool layer withholds numbers it
 * must not see. Neither is enforcement of what the model WRITES. This is: a
 * reply is checked after generation, rejected with the specific violation,
 * regenerated with that feedback, and after a bounded number of attempts
 * replaced with a fixed refusal. "The model usually gets it right" is not a
 * mechanism; a rejection loop with a ceiling is.
 *
 * ── What is checked here, and what is not ────────────────────────────────
 *   §8.1 ledger overclaim      CHECKED — forbidden strength words in a ledger
 *                              context, negation-aware.
 *   §8.2 stale as current      CHECKED — a reply that reports readings while
 *                              the edge is stale/offline/never seen must say so.
 *   §8.3 self-regulating       CHECKED (narrow) — "the greenhouse is
 *                              regulating/maintaining…" with no mention of the
 *                              mock while the source is the mock.
 *   §8.4 growing values        CHECKED — an advisory or imperative phrase
 *                              followed by a number with an environmental unit.
 *   §8.5 flags into prose      NOT CHECKED HERE — enforced upstream in
 *                              mcp/tools.js, which never places a flagged
 *                              reading's value in the text the model receives.
 *                              A guard cannot detect a number that was never
 *                              available; the tool layer is the mechanism.
 *   secrets                    CHECKED — a provider key prefix in the output
 *                              is rejected regardless of context.
 *
 * Every check is a regular expression. Regular expressions have false
 * negatives; a determined phrasing can evade them. That is stated in the
 * phase record. What they cannot have is the failure mode of a prompt-only
 * rule: silently not running.
 */

export const MAX_RETRIES = 2;

export const FALLBACK_REPLY =
  'I could not produce an answer that stays within the presentation rules for this system ' +
  '(no overclaiming the ledger, no stale data as current, no growing recommendations). ' +
  'Please rephrase the question, or look at the dashboard directly.';

// ── §8.1 ledger overclaim ───────────────────────────────────────────────────

const LEDGER_CONTEXT = /\b(ledger|chain|hash[- ]chain|audit (log|trail)|history|records?)\b/i;

// Each is a strength claim the chain does not support. Matched only in a
// ledger context, and only when not negated within the preceding few words.
const OVERCLAIM_TERMS = [
  /\btrustworthy\b/i,
  /\btrusted\b/i,
  /\bsecure(d)?\b/i,
  /\btamper[- ]?(proof|resistant)\b/i,
  /\bimmutable\b/i,
  /\bblockchain\b/i,
  /\bcannot be (altered|modified|changed|tampered|forged|faked)\b/i,
  /\b(guarantees?|proves?) (the )?(authenticity|truth|honesty|accuracy)\b/i,
  /\bfully verified\b/i,
];

const NEGATION = /\b(not|n't|never|no|neither|nor|isn't|aren't|doesn't|does not|cannot claim|without)\b/i;

function negatedBefore(text, index, window = 40) {
  return NEGATION.test(text.slice(Math.max(0, index - window), index));
}

export function checkLedgerOverclaim(reply) {
  if (!LEDGER_CONTEXT.test(reply)) return [];
  const hits = [];
  for (const re of OVERCLAIM_TERMS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(reply)) !== null) {
      if (!negatedBefore(reply, m.index)) hits.push({ rule: 'ledger_overclaim', match: m[0] });
    }
  }
  return hits;
}

// ── §8.2 stale presented as current ─────────────────────────────────────────

// A reading in prose: a number followed by an environmental unit or a
// percentage, or a relay named with ON/off.
const READING_IN_PROSE = /\d+(\.\d+)?\s*(°\s?c|%\s?rh|%|hpa|raw adc)(?![a-z0-9])|\b(pump|s_fan|internal_fan|n_fan|humidifier|lights|grow_light)\b[^.\n]{0,20}\b(on|off)\b/i;

const STALENESS_ACKNOWLEDGED =
  /\b(stale|offline|out[- ]of[- ]date|not current|predate|no longer current|never (been )?seen|no (recent )?data|last (seen|reported|telemetry)|minutes? ago|hours? ago|days? ago)\b/i;

/**
 * @param {string} reply
 * @param {{ edgeStale: boolean }} ctx  true when status.edge is stale, offline or never seen
 */
export function checkStaleAsCurrent(reply, ctx) {
  if (!ctx?.edgeStale) return [];
  if (!READING_IN_PROSE.test(reply)) return [];
  if (STALENESS_ACKNOWLEDGED.test(reply)) return [];
  return [{ rule: 'stale_as_current', match: reply.match(READING_IN_PROSE)[0] }];
}

// ── §8.3 self-regulating ────────────────────────────────────────────────────

const SELF_REGULATING =
  /\b(greenhouse|system|controller|edge|esp32)\b[^.\n]{0,30}\b(is|are|has been|keeps?|continues?)\b[^.\n]{0,20}\b(regulating|maintaining|controlling|managing|holding|keeping)\b[^.\n]{0,40}\b(temperature|humidity|conditions|climate|environment)\b/i;

const MOCK_ACKNOWLEDGED = /\b(mock|simulat(or|ed|ion)|no firmware|not a real device)\b/i;

/**
 * @param {{ mock: boolean }} ctx  true when status.edge.verify === 'unsupported'
 */
export function checkSelfRegulating(reply, ctx) {
  if (!ctx?.mock) return [];
  const m = reply.match(SELF_REGULATING);
  if (!m) return [];
  if (MOCK_ACKNOWLEDGED.test(reply)) return [];
  return [{ rule: 'self_regulating', match: m[0] }];
}

// ── §8.4 growing values ─────────────────────────────────────────────────────

const UNIT = String.raw`\d+(?:\.\d+)?\s*(?:°\s?c|%\s?rh|%|hpa|lux|raw adc|hours?|h\b|min(?:utes)?)`;

const ADVISORY_VALUE = new RegExp(
  String.raw`\b(?:you (?:should|could|can|might|may|want to|need to)|try|consider|i(?:'d| would)? (?:recommend|suggest|advise)|it(?:'s| is) (?:best|advisable))\b[^.\n]{0,80}?` +
    UNIT,
  'i'
);

const IMPERATIVE_VALUE = new RegExp(
  String.raw`(?:^|[.!?]\s+)(?:raise|lower|increase|decrease|set|adjust|reduce|bring|keep|target|aim for|bump|drop)\b[^.\n]{0,60}?` +
    UNIT,
  'im'
);

const IDEAL_VALUE = new RegExp(
  // "The ideal humidity for lettuce is 70 %" — any of these words within a
  // clause of a value is a recommendation, whatever noun sits between.
  String.raw`\b(?:ideal(?:ly)?|optimal(?:ly)?|optimum|recommended|should be|ought to be)\b[^.\n]{0,40}?` + UNIT,
  'i'
);

export function checkGrowingValue(reply) {
  const hits = [];
  for (const [re, label] of [
    [ADVISORY_VALUE, 'advisory'],
    [IMPERATIVE_VALUE, 'imperative'],
    [IDEAL_VALUE, 'ideal'],
  ]) {
    const m = reply.match(re);
    if (m) hits.push({ rule: 'growing_value', match: m[0].replace(/^[.!?]\s+/, '').trim(), kind: label });
  }
  return hits;
}

// ── secrets ─────────────────────────────────────────────────────────────────

const SECRET_SHAPES = [/\bsk-ant-[A-Za-z0-9_-]{8,}/, /\bsk-[A-Za-z0-9]{20,}/, /\bPROVIDER_KEK\s*=\s*\S{20,}/];

export function checkSecrets(reply) {
  for (const re of SECRET_SHAPES) {
    const m = reply.match(re);
    if (m) return [{ rule: 'secret_leak', match: m[0].slice(0, 12) + '…' }];
  }
  return [];
}

// ── verdict ─────────────────────────────────────────────────────────────────

/**
 * @param {string} reply
 * @param {{ edgeStale?: boolean, mock?: boolean }} ctx
 * @returns {{ ok: boolean, violations: Array<{rule:string, match:string}> }}
 */
export function checkReply(reply, ctx = {}) {
  const text = String(reply ?? '');
  const violations = [
    ...checkSecrets(text),
    ...checkLedgerOverclaim(text),
    ...checkStaleAsCurrent(text, ctx),
    ...checkSelfRegulating(text, ctx),
    ...checkGrowingValue(text),
  ];
  return { ok: violations.length === 0, violations };
}

/** The feedback appended to the conversation when a reply is rejected. */
export function rejectionFeedback(violations) {
  const lines = violations.map((v) => {
    switch (v.rule) {
      case 'ledger_overclaim':
        return `You wrote "${v.match}" about the ledger. The chain proves internal consistency only. Use the tool's own "proves / does not prove" wording.`;
      case 'stale_as_current':
        return `You reported "${v.match}" while the edge is stale or offline. State explicitly that the data is stale and predates the outage before any reading.`;
      case 'self_regulating':
        return `You wrote "${v.match}". No firmware exists; the source is a mock simulator. Say so.`;
      case 'growing_value':
        return `You wrote "${v.match}". Do not recommend growing values. You may say what the configuration sets; you may not say what it should be.`;
      case 'secret_leak':
        return 'Your reply contained something shaped like a credential. Remove it.';
      default:
        return `Rule ${v.rule} violated: "${v.match}".`;
    }
  });
  return 'Your previous answer was rejected by the presentation guard:\n- ' + lines.join('\n- ') + '\nRewrite it to comply. Do not mention the guard.';
}

/**
 * The bounded loop.
 *
 * @param {(feedback: string|null) => Promise<string>} generate
 *   Produces a reply. Receives the rejection feedback on retries, null first.
 * @param {{ edgeStale?: boolean, mock?: boolean }} ctx
 * @returns {Promise<{ reply: string, attempts: number, guarded: boolean, violations: Array }>}
 *   `guarded` is true when the FALLBACK was returned. `violations` are those
 *   of the LAST rejected attempt, for logging — never shown to the user.
 */
export async function generateWithGuard(generate, ctx = {}) {
  let feedback = null;
  let last = { ok: false, violations: [] };
  for (let attempt = 1; attempt <= 1 + MAX_RETRIES; attempt++) {
    const reply = await generate(feedback);
    last = checkReply(reply, ctx);
    if (last.ok) return { reply, attempts: attempt, guarded: false, violations: [] };
    feedback = rejectionFeedback(last.violations);
  }
  return { reply: FALLBACK_REPLY, attempts: 1 + MAX_RETRIES, guarded: true, violations: last.violations };
}
