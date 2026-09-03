/**
 * SDIGF Phase 05c — the read-only tool layer.
 *
 * ── What this is ─────────────────────────────────────────────────────────
 * Eight tools, every one a GET against the Phase 05a REST API. Each tool is
 * defined in the shape an MCP server would serve (`name`, `description`,
 * `inputSchema` as JSON Schema) and returns the shape an MCP `tools/call`
 * would return (`content[]` of text blocks plus `structuredContent`).
 *
 * ── What this is NOT ─────────────────────────────────────────────────────
 * Not an MCP server. Nothing in this phase speaks the MCP protocol over the
 * wire; the chat endpoint calls these handlers in-process. Calling it an
 * "MCP server" would claim more than the artifact delivers. It is MCP-SHAPED
 * so that exposing it at /api/mcp later is one route: transport plus session
 * handling for an external client, no changes here. If exposing it later
 * requires refactoring this file, it was not MCP-shaped.
 *
 * ── The one rule that keeps it honest ────────────────────────────────────
 * Handlers receive a `ctx.get(path, query)` that ALREADY carries the caller's
 * session. This module has no idea what a session is, never touches a
 * database, and imports no service. It is a client of the API with no
 * privileges of its own — the same property the brief demanded of the
 * "MCP server", made literal.
 *
 * ── Output shaping IS enforcement ────────────────────────────────────────
 * Presentation constraints §8.2 and §8.5 (stale-as-current, flags-into-prose)
 * are enforced here, before the model ever sees a number:
 *   • a reading whose quality is not `ok` is rendered as TEXT with its flag
 *     and age — the numeric value is not placed in the text block at all;
 *   • every text block that carries readings opens with a freshness line
 *     derived from server status;
 *   • the ledger tool passes the API's own `claim` block through verbatim.
 * The model cannot print a number it was never given.
 */

// ── constants ───────────────────────────────────────────────────────────────

/** Matches /api/status `bridge.writingRecently` (< 300 s). One threshold, not two. */
export const STALE_AFTER_S = 300;

/** The device-declared verify value that identifies the Phase 04 mock. */
const MOCK_VERIFY = 'unsupported';

// ── small formatters (pure) ─────────────────────────────────────────────────

export function fmtAge(seconds) {
  if (seconds === null || seconds === undefined) return 'never';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h ago`;
  return `${(s / 86400).toFixed(1)} days ago`;
}

/**
 * A single reading as prose. THE numeric value appears ONLY when quality is
 * `ok`. Everything else is a flag with an age.
 */
export function fmtReading(r, unit) {
  if (!r) return 'not a paired sensor';
  const age = fmtAge(r.ageSeconds);
  switch (r.quality) {
    case 'ok':
      return `${r.value} ${unit} (ok, ${age})`;
    case 'stale':
      return `STALE — last good value ${age}; do not treat as current`;
    case 'fail':
      return `FAILED — sensor reported failure ${age}; no value`;
    case 'init':
      return `INITIALISING — no valid reading yet (${age})`;
    case 'no_data':
      return 'NO DATA — never reported';
    default:
      return `UNKNOWN QUALITY "${r.quality}" — no value`;
  }
}

/** Freshness preamble every reading-bearing tool starts with. */
export function freshnessLine(status) {
  const edge = status?.edge ?? {};
  const age = edge.lastTelemetryAgeSeconds;
  const parts = [];
  if (!edge.everSeen) {
    parts.push('EDGE NEVER SEEN — there are no readings from any device.');
  } else if (age === null || age === undefined) {
    parts.push('EDGE FRESHNESS UNKNOWN.');
  } else if (age >= STALE_AFTER_S) {
    parts.push(
      `EDGE DATA IS STALE — last telemetry ${fmtAge(age)}. Every number below predates that; ` +
        `none of it describes the greenhouse now.`
    );
  } else {
    parts.push(`Edge data fresh: last telemetry ${fmtAge(age)}.`);
  }
  if (edge.verify === MOCK_VERIFY) {
    parts.push('Source is the MOCK EDGE SIMULATOR (verify=unsupported) — not a real device. No firmware exists.');
  }
  if (status?.broker && status.broker.connected === false) {
    parts.push('Server is NOT connected to the MQTT broker.');
  }
  return parts.join(' ');
}

// ── tool definitions ────────────────────────────────────────────────────────
//
// Each entry: { name, description, inputSchema, handler(args, ctx) }.
// `ctx.get(path, query?)` → parsed JSON, session already attached.
// `ctx.status` → the /api/status body fetched once per turn by the caller, so
//   handlers can prefix freshness without a second round-trip. If absent the
//   handler fetches it.

async function statusOf(ctx) {
  return ctx.status ?? (await ctx.get('/api/status'));
}

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

export const TOOLS = [
  {
    name: 'get_server_status',
    description:
      'Broker connection, inferred bridge health, edge presence and data freshness, whether the device ' +
      'is running the configuration the server considers active, and the device-declared verify status ' +
      '(unsupported = mock simulator). Consult this before reporting any reading as current.',
    inputSchema: NO_ARGS,
    async handler(_args, ctx) {
      const s = await statusOf(ctx);
      const lines = [
        freshnessLine(s),
        `Greenhouse: ${s.greenhouse?.name} (${s.greenhouse?.id}), plants: ${s.greenhouse?.plants}.`,
        `Broker: ${s.broker?.connected ? 'connected' : 'DISCONNECTED'} (${s.broker?.address ?? '?'}).`,
        `Bridge (inferred from row age, not a health check): ${
          s.bridge?.writingRecently ? 'writing recently' : 'NOT writing recently'
        }, last row ${fmtAge(s.bridge?.lastRowAgeSeconds)}.`,
        `Edge declared status: ${s.edge?.declaredStatus ?? 'none'} at ${s.edge?.declaredAt ?? 'never'}.`,
        `Configuration: server active v${s.server?.activeCfgVer ?? 'none'}; device running v${
          s.edge?.runningCfgVer ?? 'none'
        } (source ${s.edge?.cfgSrc ?? 'unknown'}); in sync: ${
          s.configInSync === null ? 'unknown' : s.configInSync ? 'yes' : 'NO'
        }.`,
        `Device verify: ${s.edge?.verify}.`,
        `Server time: ${s.serverTime}.`,
      ];
      return result(lines, s);
    },
  },

  {
    name: 'get_environment',
    description:
      'Latest reading of every sensor, inner and outer, WITH quality flags. Flagged readings carry no ' +
      'number. Begins with a freshness statement derived from server status.',
    inputSchema: NO_ARGS,
    async handler(_args, ctx) {
      const [s, live] = await Promise.all([statusOf(ctx), ctx.get('/api/state/live')]);
      const sensors = live.sensors ?? {};
      const lines = [freshnessLine(s)];
      if (sensors.unavailable) {
        lines.push(`TELEMETRY DATABASE UNAVAILABLE: ${sensors.reason ?? 'unknown reason'}. No readings.`);
        return result(lines, { status: s, sensors });
      }
      if (!sensors.hasData) lines.push('No sensor data has ever been recorded.');
      for (const g of sensors.groups ?? []) {
        const note = g.note ? ` [${g.note}]` : '';
        if (g.paired) {
          lines.push(`${g.label}${note}: inner ${fmtReading(g.inner, g.unit)}; outer ${fmtReading(g.outer, g.unit)}.`);
        } else {
          lines.push(`${g.label}${note}: ${fmtReading(g.single, g.unit)}.`);
        }
      }
      return result(lines, { status: s, sensors });
    },
  },

  {
    name: 'get_actuator_state',
    description:
      'State of the seven relays (pump, s_fan, internal_fan, n_fan, humidifier, lights, grow_light), the ' +
      'canopy position (believed, not measured), the ventilation stage, any manual override with its ' +
      'remaining time, and the emergency-stop state with its source (local or remote).',
    inputSchema: NO_ARGS,
    async handler(_args, ctx) {
      const [s, live, estop] = await Promise.all([statusOf(ctx), ctx.get('/api/state/live'), ctx.get('/api/estop')]);
      const a = live.actuators ?? {};
      const lines = [freshnessLine(s)];
      if (!a.hasData) lines.push('No actuator state has ever been reported.');
      for (const r of a.relays ?? []) {
        if (r.on === null || r.on === undefined) {
          lines.push(`${r.actuator}: never reported.`);
          continue;
        }
        let line = `${r.actuator}: ${r.on ? 'ON' : 'off'} (${r.src}, ${fmtAge(r.forSeconds)} in this state)`;
        if (r.overridden) line += `; MANUAL OVERRIDE, hands back in ${fmtAge(r.overrideRemainingSeconds).replace(' ago', '')}`;
        lines.push(line + '.');
      }
      lines.push(
        a.canopy
          ? `Canopy: ${a.canopy.positionPct}% (${a.canopy.src}; BELIEVED position — the servo has no feedback).`
          : 'Canopy: never reported.'
      );
      lines.push(`Ventilation stage: ${a.ventStage ?? 'unknown'} of 0–3.`);
      const req = estop.requested ?? {};
      const dev = estop.device ?? {};
      lines.push(
        `Emergency stop — server requested: ${req.state ?? 'unknown'}` +
          (req.state === 'stopped' ? ` (source ${req.source ?? '?'}, by ${req.byRole ?? 'unattributed'}, seq ${req.seq})` : '') +
          `; device declares: ${dev.active === null ? 'unknown' : dev.active ? 'STOPPED' : 'running'}` +
          `; confirmed stopped: ${estop.confirmed ? 'yes' : 'no'}. ` +
          `The server never asserts a stop — only the device's declaration counts.`
      );
      return result(lines, { status: s, actuators: a, estop });
    },
  },

  {
    name: 'get_active_config',
    description:
      'The configuration the server considers active: version, hash, status, and all nine blocks ' +
      '(sys, temp, hum, vent, pump, photo, canopy, arb_a, arb_b). Say what it SETS; never recommend values.',
    inputSchema: NO_ARGS,
    async handler(_args, ctx) {
      const [s, body] = await Promise.all([statusOf(ctx), ctx.get('/api/config/active')]);
      const p = body.active;
      if (!p) return result(['No active configuration. First-boot state.'], { status: s, active: null });
      const sync =
        s.configInSync === null ? 'device sync unknown' : s.configInSync ? 'device is running it' : 'DEVICE IS NOT RUNNING IT';
      const lines = [
        `Active configuration v${p.ver} (${p.name ?? 'unnamed'}), hash ${String(p.cfgHash ?? p.cfg_hash ?? '').slice(0, 16)}…, ${sync}.`,
        `Activated ${p.activatedAt ?? p.activated_at ?? 'unknown'}.`,
        'Blocks (as set by the approved configuration — the system does not know whether these suit the crop):',
        JSON.stringify(p.cfg ?? p.cfg_canonical ?? p, null, 0),
      ];
      return result(lines, { status: s, active: p });
    },
  },

  {
    name: 'get_history',
    description:
      'Trend of one sensor over a window, bucketed. Returns per-bucket avg/min/max and how many samples ' +
      'in each bucket were ok / stale / bad. Buckets with no ok samples are gaps, not zeros.',
    inputSchema: {
      type: 'object',
      properties: {
        sensor: {
          type: 'string',
          description: 'One of: temp_in, temp_out, hum_in, hum_out, press_in, press_out, light_in, light_out, air_quality, soil_moisture, water_level',
        },
        hours: { type: 'integer', minimum: 1, maximum: 8760, default: 24 },
      },
      required: ['sensor'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const hours = args.hours ?? 24;
      const [s, h] = await Promise.all([
        statusOf(ctx),
        ctx.get(`/api/state/history/${encodeURIComponent(args.sensor)}`, { hours }),
      ]);
      const pts = h.points ?? [];
      const lines = [freshnessLine(s)];
      if (!h.hasData) {
        lines.push(`${args.sensor}: no samples in the last ${hours} h.`);
        return result(lines, { status: s, history: h });
      }
      const okPts = pts.filter((p) => p.ok > 0 && p.avg !== null);
      const vals = okPts.map((p) => Number(p.avg));
      const gaps = pts.length - okPts.length;
      const summary =
        vals.length > 0
          ? `avg ${mean(vals).toFixed(1)}, min ${Math.min(...okPts.map((p) => Number(p.min))).toFixed(1)}, ` +
            `max ${Math.max(...okPts.map((p) => Number(p.max))).toFixed(1)} over ${okPts.length} buckets with ok samples`
          : 'NO buckets with ok samples';
      lines.push(
        `${args.sensor}, last ${hours} h in ${h.bucketMinutes}-min buckets: ${summary}; ` +
          `${gaps} bucket(s) with no ok sample (gaps, not zeros); ` +
          `${pts.reduce((n, p) => n + p.stale, 0)} stale and ${pts.reduce((n, p) => n + p.bad, 0)} bad samples in the window.`
      );
      // Downsample to at most 48 points for the text block so a 24 h window
      // does not put 288 rows in the model's context.
      const step = Math.max(1, Math.ceil(okPts.length / 48));
      const series = okPts.filter((_, i) => i % step === 0).map((p) => `${p.t}: ${Number(p.avg).toFixed(1)}`);
      lines.push(`Series (every ${step === 1 ? 'bucket' : `${step}th bucket`}): ${series.join('; ')}`);
      return result(lines, { status: s, history: h });
    },
  },

  {
    name: 'list_proposals',
    description:
      'Configuration profiles and their approval state (DRAFT, PROPOSED, PARTIALLY_APPROVED, APPROVED, ' +
      'ACTIVE, REJECTED, SUPERSEDED). Optional status filter.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['DRAFT', 'PROPOSED', 'PARTIALLY_APPROVED', 'APPROVED', 'ACTIVE', 'REJECTED', 'SUPERSEDED'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const body = await ctx.get('/api/config/profiles', { status: args.status, limit: args.limit ?? 20 });
      const rows = body.profiles ?? [];
      const lines = rows.length
        ? rows.map(
            (p) =>
              `v${p.ver ?? '?'} "${p.name ?? 'unnamed'}" — ${p.status} (created ${p.createdAt ?? p.created_at ?? '?'}` +
              `${p.proposedAt || p.proposed_at ? `, proposed ${p.proposedAt ?? p.proposed_at}` : ''})`
          )
        : ['No configuration profiles.'];
      return result(lines, { profiles: rows });
    },
  },

  {
    name: 'get_ledger_status',
    description:
      'Verification result of the hash-chained audit ledger, with the exact statement of what it proves ' +
      'and what it does not. Repeat that statement; do not paraphrase it into a stronger claim.',
    inputSchema: NO_ARGS,
    async handler(_args, ctx) {
      const v = await ctx.get('/api/ledger/verify');
      const lines = [
        `Verification: ${v.ok ? 'no alteration detected' : 'FAILED'}; chain length ${v.length}; ` +
          `verified through seq ${v.verifiedThrough}; real-time from seq ${v.realTimeFrom ?? 'none'}; ` +
          `unchained events: ${Array.isArray(v.unchainedEvents) ? v.unchainedEvents.length : v.unchainedEvents ?? 0}.`,
        v.firstFailure ? `First failure: ${JSON.stringify(v.firstFailure)}.` : null,
        `WHAT THIS PROVES: ${v.claim?.proves}`,
        `WHAT THIS DOES NOT PROVE: ${v.claim?.doesNotProve}`,
        `ORDERING: ${v.claim?.realTimeFrom}`,
        'This is a hash-chained log, not a blockchain. Past approvals cannot be invented; history can still be destroyed.',
      ].filter(Boolean);
      return result(lines, v);
    },
  },

  {
    name: 'get_recent_events',
    description:
      'Most recent server events (config, commands, keys, policy, e-stop, provider) and edge events ' +
      '(boot, online/offline, config applied/rejected), newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const body = await ctx.get('/api/events', { limit: args.limit ?? 25 });
      const ev = body.events ?? [];
      const lines = ev.length
        ? ev.map((e) => {
            const who = e.actorUsername ?? e.actor_username ?? e.actorRole ?? e.actor_role ?? (e.source === 'edge' ? 'device' : 'unattributed');
            const detail = e.detail ? ` ${compact(e.detail)}` : '';
            return `${e.time} [${e.source}] ${e.eventType ?? e.event_type} by ${who}${detail}`;
          })
        : ['No events.'];
      return result(lines, { events: ev });
    },
  },
];

// ── MCP-shaped entry points ─────────────────────────────────────────────────

/** `tools/list` shape: name, description, inputSchema — nothing else. */
export function listTools() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/**
 * `tools/call` shape. Validates arguments against the declared schema (the
 * subset used above: object, string/integer/enum, min/max, required,
 * additionalProperties:false), then runs the handler.
 *
 * Errors come back as `{ isError: true, content: [text] }` — the MCP
 * convention — rather than thrown, so a failing tool becomes something the
 * model can read and report instead of a 500.
 */
export async function callTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`unknown tool "${name}"`);
  const problems = validateArgs(tool.inputSchema, args ?? {});
  if (problems.length) return errorResult(`invalid arguments for ${name}: ${problems.join('; ')}`);
  try {
    return await tool.handler(args ?? {}, ctx);
  } catch (err) {
    return errorResult(`${name} failed: ${err.message}`);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function result(lines, structured) {
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: structured,
    isError: false,
  };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function compact(detail) {
  const s = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

/** Minimal JSON-Schema validator for the shapes declared in this file. */
export function validateArgs(schema, args) {
  const out = [];
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return ['arguments must be an object'];
  const props = schema.properties ?? {};
  for (const req of schema.required ?? []) {
    if (!(req in args)) out.push(`missing required "${req}"`);
  }
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) {
      if (schema.additionalProperties === false) out.push(`unexpected "${k}"`);
      continue;
    }
    if (v === undefined) continue;
    if (p.type === 'string' && typeof v !== 'string') out.push(`"${k}" must be a string`);
    if (p.type === 'integer' && !Number.isInteger(v)) out.push(`"${k}" must be an integer`);
    if (p.enum && !p.enum.includes(v)) out.push(`"${k}" must be one of ${p.enum.join(', ')}`);
    if (p.minimum !== undefined && typeof v === 'number' && v < p.minimum) out.push(`"${k}" must be ≥ ${p.minimum}`);
    if (p.maximum !== undefined && typeof v === 'number' && v > p.maximum) out.push(`"${k}" must be ≤ ${p.maximum}`);
  }
  return out;
}
