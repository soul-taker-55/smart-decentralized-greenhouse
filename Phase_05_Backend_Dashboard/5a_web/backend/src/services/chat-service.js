/**
 * SDIGF Phase 05c — chat service.
 *
 * One exported function, runChatTurn(), which is the whole read-only
 * assistant:
 *
 *   1. Fetch /api/status ONCE, with the caller's session, and inject it into
 *      the system prompt. The model does not get to skip it.
 *   2. Build the system prompt: brief + role framing + status.
 *   3. Ask the provider. If it asks for tools, run them through mcp/tools.js
 *      with a ctx that forwards the SAME session — the tool layer is a client
 *      of the REST API with no privileges of its own. Loop, bounded.
 *   4. Run the final text through the guard. On rejection, feed the specific
 *      violation back and regenerate, bounded. On exhaustion, a fixed reply.
 *
 * ── Session forwarding ───────────────────────────────────────────────────
 * Every HTTP call this module makes goes to the backend's own listener on
 * 127.0.0.1 with the caller's Cookie header attached. There is no service
 * token, no direct database access, no service import for data. If the
 * caller's session cannot read something, neither can the chat.
 *
 * ── Two providers, one interface ─────────────────────────────────────────
 * ADAPTERS[provider] = { complete(...) } returning { text, toolCalls, raw },
 * and toolResults(...) returning the messages to append. Everything above
 * this line is provider-independent. Wire formats:
 *   anthropic  POST /v1/messages; tools as input_schema; tool_use content
 *              blocks; results as tool_result blocks in a user message.
 *   openai     POST /v1/chat/completions; tools as function; tool_calls on
 *              the assistant message; results as role=tool messages.
 *
 * ── What the API key touches ─────────────────────────────────────────────
 * Only the Authorization / x-api-key header inside the adapter's fetch,
 * within withProviderKey()'s callback. It is never assigned to a variable
 * that outlives the request, never logged, never included in an error.
 */

import { config } from '../config.js';
import { withProviderKey, ProviderError } from './provider-service.js';
import { buildSystemPrompt, KNOWN_ROLES } from '../mcp/brief.js';
import { listTools, callTool, freshnessLine, STALE_AFTER_S } from '../mcp/tools.js';
import { generateWithGuard } from '../mcp/guard.js';

// ── bounds ──────────────────────────────────────────────────────────────────

/** Tool-call rounds per generation attempt. Enough for status + two lookups + a follow-up. */
export const MAX_TOOL_ROUNDS = 6;
/** Prior turns kept from the client-supplied history. */
export const MAX_HISTORY_TURNS = 12;
/** Per-message character cap on history and the new message. */
export const MAX_MESSAGE_CHARS = 4000;
/** Provider HTTP timeout. */
const PROVIDER_TIMEOUT_MS = 60_000;
/** Tokens the model may produce per call. */
const MAX_OUTPUT_TOKENS = 1024;

// ── REST client bound to the caller's session ───────────────────────────────

function makeCtx(cookieHeader) {
  const base = `http://127.0.0.1:${config.port}`;
  const ctx = {
    status: null,
    async get(path, query) {
      const url = new URL(path, base);
      for (const [k, v] of Object.entries(query ?? {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
      const res = await fetch(url, { headers: { cookie: cookieHeader, accept: 'application/json' } });
      if (!res.ok) {
        let msg = `${res.status}`;
        try {
          const body = await res.json();
          msg += ` ${body.error ?? ''} ${body.message ?? ''}`.trim();
        } catch {
          /* non-JSON error body */
        }
        throw new Error(`GET ${path} → ${msg}`);
      }
      return res.json();
    },
  };
  return ctx;
}

function guardContextFrom(status) {
  const edge = status?.edge ?? {};
  const age = edge.lastTelemetryAgeSeconds;
  const edgeStale = !edge.everSeen || age === null || age === undefined || age >= STALE_AFTER_S;
  return { edgeStale, mock: edge.verify === 'unsupported' };
}

// ── history hygiene ─────────────────────────────────────────────────────────

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const m of history.slice(-MAX_HISTORY_TURNS)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (typeof m.content !== 'string' || m.content.trim() === '') continue;
    out.push({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) });
  }
  // Providers require alternation starting with user; drop a leading assistant.
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

// ── adapters ────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, init) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function readError(res, provider) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message ?? body?.message ?? JSON.stringify(body).slice(0, 200);
  } catch {
    /* ignore */
  }
  // Status code and provider only. The request headers are never echoed.
  return new ProviderError(`${provider} API error ${res.status}${detail ? `: ${detail}` : ''}`, 'provider_error', 502);
}

const ADAPTERS = {
  anthropic: {
    toTools: (tools) => tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    async complete({ apiKey, model, system, messages, tools }) {
      const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, system, messages, tools }),
      });
      if (!res.ok) throw await readError(res, 'anthropic');
      const body = await res.json();
      const blocks = body.content ?? [];
      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
        toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
        assistantMessage: { role: 'assistant', content: blocks },
      };
    },
    toolResults(calls, results) {
      return [
        {
          role: 'user',
          content: calls.map((c, i) => ({
            type: 'tool_result',
            tool_use_id: c.id,
            content: results[i].content.map((b) => b.text).join('\n'),
            is_error: Boolean(results[i].isError),
          })),
        },
      ];
    },
  },

  openai: {
    toTools: (tools) =>
      tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    async complete({ apiKey, model, system, messages, tools }) {
      const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [{ role: 'system', content: system }, ...messages],
          tools,
        }),
      });
      if (!res.ok) throw await readError(res, 'openai');
      const body = await res.json();
      const msg = body.choices?.[0]?.message ?? {};
      const calls = (msg.tool_calls ?? []).map((c) => {
        let args = {};
        try {
          args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          args = { __parse_error: c.function?.arguments };
        }
        return { id: c.id, name: c.function?.name, args };
      });
      return {
        text: (msg.content ?? '').trim(),
        toolCalls: calls,
        assistantMessage: { role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls },
      };
    },
    toolResults(calls, results) {
      return calls.map((c, i) => ({
        role: 'tool',
        tool_call_id: c.id,
        content: results[i].content.map((b) => b.text).join('\n'),
      }));
    },
  },
};

// ── the turn ────────────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.message               The new user message.
 * @param {Array<{role:string, content:string}>} [args.history]
 * @param {{ id:string, role:string, username?:string }} args.actor
 * @param {string} args.cookieHeader          The caller's raw Cookie header.
 * @param {object} [args.logger]
 * @returns {Promise<{
 *   reply: string, toolsUsed: string[], attempts: number, guarded: boolean,
 *   provider: string, model: string, freshness: string
 * }>}
 */
export async function runChatTurn({
  message,
  history,
  actor,
  cookieHeader,
  logger = console,
  // Injectable for tests only: lets the turn loop run against a fake provider
  // without a database. Production callers never pass it.
  keyProvider = withProviderKey,
}) {
  if (!actor?.role || !KNOWN_ROLES.includes(actor.role)) {
    throw new ProviderError('unknown role', 'forbidden', 403);
  }
  if (typeof message !== 'string' || message.trim() === '') {
    throw new ProviderError('message is required', 'bad_request', 400);
  }
  if (typeof cookieHeader !== 'string' || cookieHeader === '') {
    throw new ProviderError('no session to forward', 'unauthenticated', 401);
  }

  const ctx = makeCtx(cookieHeader);
  // Status ONCE per turn. Injected into the prompt AND reused by every tool
  // handler, so the freshness the model is told and the freshness the tools
  // report cannot disagree within a turn.
  ctx.status = await ctx.get('/api/status');
  const freshness = freshnessLine(ctx.status);
  const guardCtx = guardContextFrom(ctx.status);

  const system =
    buildSystemPrompt({ role: actor.role, username: actor.username }) +
    `\n\nCURRENT SERVER STATUS (fetched for this turn)\n${freshness}\n` +
    `Server active config v${ctx.status.server?.activeCfgVer ?? 'none'}; device running v${
      ctx.status.edge?.runningCfgVer ?? 'none'
    }; in sync: ${ctx.status.configInSync === null ? 'unknown' : ctx.status.configInSync ? 'yes' : 'NO'}.`;

  const baseMessages = [...sanitizeHistory(history), { role: 'user', content: message.slice(0, MAX_MESSAGE_CHARS) }];
  const toolDefs = listTools();
  const toolsUsed = new Set();
  let providerName = null;
  let modelName = null;

  const generate = (feedback) =>
    keyProvider(async ({ apiKey, provider, model }) => {
      providerName = provider;
      modelName = model;
      const adapter = ADAPTERS[provider];
      if (!adapter) throw new ProviderError(`no adapter for provider "${provider}"`, 'bad_provider', 500);

      const messages = feedback ? [...baseMessages, { role: 'user', content: feedback }] : [...baseMessages];
      const tools = adapter.toTools(toolDefs);

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const out = await adapter.complete({ apiKey, model, system, messages, tools });
        if (out.toolCalls.length === 0) return out.text;

        const results = [];
        for (const call of out.toolCalls) {
          toolsUsed.add(call.name);
          results.push(await callTool(call.name, call.args, ctx));
        }
        messages.push(out.assistantMessage, ...adapter.toolResults(out.toolCalls, results));
      }
      // Tool loop exhausted. Ask once more without tools so the model must answer.
      const final = await adapter.complete({ apiKey, model, system, messages, tools: [] });
      return final.text || 'I ran out of lookups before I could form an answer. Please ask something narrower.';
    }, { logger });

  const result = await generateWithGuard(generate, guardCtx);

  if (result.guarded) {
    logger.warn(
      `chat guard exhausted retries for ${actor.role} ${actor.id}: ` + result.violations.map((v) => v.rule).join(', ')
    );
  }

  return {
    reply: result.reply,
    toolsUsed: [...toolsUsed],
    attempts: result.attempts,
    guarded: result.guarded,
    provider: providerName,
    model: modelName,
    freshness,
  };
}
