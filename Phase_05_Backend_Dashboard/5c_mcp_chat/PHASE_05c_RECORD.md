# PHASE 05c RECORD — Read-Only Assistant (tool-calling chat)

**Status:** built, deployed to `greenhouse.progrex.tech`, live-verified. Last server-tier phase.
**Commits:** `9a487ef` … `c816d20` (15 commits, 3 September 2026). Base: `e011904`.
**Tests:** 135 passing, all database-free (`node --test test/*.test.js`).

This record states what was decided, what was found, what was wrong, and what
was observed — in that order, with the commit that carries each.

---

## 1. Naming correction — this is not an MCP server

The kickoff brief called this phase "the MCP server". Nothing in it speaks the
MCP protocol over the wire. The tools are called in-process by the chat
endpoint. The honest name is **tool-calling chat** / **read-only assistant**,
and that is what the README, the thesis chapter and this record use.

"MCP-shaped" is retained as a property of the code, with a precise meaning:

- tool definitions in the schema an MCP server would serve (`name`,
  `description`, `inputSchema` as JSON Schema) — `listTools()`;
- handlers taking the argument shape an MCP `tools/call` delivers and
  returning its result shape (`content[]`, `structuredContent`, `isError`) —
  `callTool()`;
- no chat-specific coupling in `mcp/tools.js`: it imports no service, no
  database, no framework; it receives a `ctx.get()` with the session already
  attached and knows nothing else.

**The one-route future step (`/api/mcp`):** a Streamable-HTTP transport that
maps `tools/list` → `listTools()` and `tools/call` → `callTool()`. The open
design question it carries is session handling for an external client, which
cannot present the dashboard's HttpOnly cookie; a per-user token or an OAuth
flow would be needed, and that is a Phase 05b identity question, not a tools
question. If exposing it requires changing `tools.js`, it was not MCP-shaped.
Not built: no external client exists in this project, so it would be real work
with no demonstration value.

## 2. Decisions

| Decision | Reason | Where |
|---|---|---|
| Read-only, by decision | The LLM is structurally outside the control loop. The `commands.via = 'mcp'` seam from 002 exists and is deliberately unused | brief §4; `tools.js` |
| Available to all three roles | A tool whose only power is explanation has nothing to gate | `routes.js` `/api/chat` = `CAP.VIEW` |
| Role tailoring as context, not capability filter | Same tools for everyone; the brief tells the model who it is talking to | `brief.js` `buildSystemPrompt()` |
| Session forwarding, no service token | Every REST call carries the caller's own cookie to `127.0.0.1`. The assistant reads exactly what the caller can read | `chat-service.js` `makeCtx()` |
| Status fetched once per turn, injected before the model sees anything | The model must not be able to skip it | `chat-service.js` |
| Flagged readings carry no number | Enforcement by omission is stronger than enforcement by instruction | `tools.js` `fmtReading()` |
| Post-generation guard with bounded retry (max 2), fixed fallback | "The model usually gets it right" is not a mechanism | `guard.js` `generateWithGuard()` |
| Envelope encryption with role separation for the provider key | See §3 | `provider-crypto.js`, migration 007 |
| Both Anthropic and OpenAI adapters | Adaptability; the difference is ~40 lines of wire shape each | `chat-service.js` `ADAPTERS`; migration 008 |
| Write-only key panel, no reveal | A reveal serves no operational purpose and is a real exposure | `AdminPage.jsx` `ProviderControl` |
| No `<form>` elements | Project convention; Chrome's "password field not in a form" lint is expected | — |
| Client holds the conversation; server stores nothing | Nothing typed is persisted | `ChatPage.jsx` |

## 3. Provider-key threat model

Two administrators, two kinds of access. Neither alone can read the API key.

| Compromise | Attacker gets |
|---|---|
| database only | ciphertext, useless without the KEK |
| environment only | KEK, nothing to decrypt |
| dashboard admin session | can rotate the API key, cannot read it |
| server admin alone | KEK, but still needs the database row |

Rotating the API key never needs Dokploy. Rotating the KEK never needs the
dashboard. The encryption is the mechanism that makes the separation real.

**Mechanism:** AES-256-GCM, 32-byte KEK from `PROVIDER_KEK`, fresh 12-byte
nonce per write (CHECK-enforced), 16-byte tag, AAD bound to
`sdigf.provider_settings.api_key.v1`. Stored: ciphertext‖tag, nonce, last4,
`kek_fingerprint` = first 16 hex of SHA-256(KEK).

**The fingerprint exists to separate two failures that look identical to
GCM:** a rotated KEK (fingerprint differs → `kek_rotated`, expected, re-enter)
and altered ciphertext (fingerprint matches, tag fails → `tampered`, ERROR log
with marker `SDIGF_PROVIDER_KEY_TAMPER_SUSPECTED`).

**Startup:** KEK absent → warn, start, chat reports `kek_missing`. KEK
malformed → fatal, same class as a weak bootstrap password.

**KEK rotation makes existing ciphertext unreadable by design.** The dashboard
admin re-enters the API key. Intended behaviour, not a bug.

**Honest limitation (state it in the thesis):** on one VPS, database and
environment sit on the same machine, so compromising both is a single
compromise. The separation is real in design and becomes real in effect when
database and application run on separate hosts — the production shape. Do not
imply the PoC deployment already has that separation.

**Planner correction, recorded:** the planner first said encrypting at rest was
"one layer of indirection, not more security." That was wrong — it missed that
the two halves are held by different roles — and the planner withdrew it.

## 4. Presentation constraints — enforcement, honestly

| Constraint | Mechanism | Level |
|---|---|---|
| §8.1 ledger overclaim | API's `claim` block passed verbatim; regex in ledger context, negation-aware | guard |
| §8.2 stale as current | status injected first; reply with a reading while edge stale must acknowledge staleness | guard |
| §8.3 self-regulating | brief; mock named in status line; narrow regex | guard (narrow) |
| §8.4 growing values | advisory / imperative / ideal phrasing + number with unit | guard |
| §8.5 flags into prose | number never given to the model | tool layer |
| offers to act (added live) | "would you like me to", "shall I", "would/do you like to <act-verb>", "I can <act-verb>" | guard |
| crop judgment without a number (found live) | "these levels are not excessively low" — no regex handle | **brief only** |
| secrets in output | key-shaped strings | guard |

Regular expressions have false negatives; a determined phrasing can evade them.
What they cannot have is the failure mode of a prompt-only rule: silently not
running. The page shows the guard verdict under every reply at full weight.

## 5. Stale claims caught (two; project total now seven)

1. **"AI provider configuration comes from the admin settings page built in
   05b."** Nothing existed — no table, route, column, or env var. Built in 05c.
2. **Role matrix.** `auth.js` is `farmer: [VIEW, COMMAND, ESTOP_TRIGGER]` —
   farmer commands, does not propose. Chapter 10 §10.7 says the opposite.
   Decision recorded: the matrix is frozen and correct; the thesis drifted and
   is corrected to match the code. Rationale: a farmer at the enclosure should
   be able to run the pump for thirty seconds (TTL-bounded, self-reverting,
   operational) and should not rewrite the crop recipe (persistent, agronomic).

Also stale: Chapter 10 §10.13 ("not in the public repo") — 05a/05b/07 are
pushed.

## 6. Mistakes made in this phase, and their corrections

| Mistake | Caught by | Correction |
|---|---|---|
| Migration 007 declared `updated_by UUID`; `users.id` is `TEXT` (003) and every attribution column is TEXT. The column type was assumed, not read | first live `GET /api/provider` → 500 `operator does not exist: text = uuid` | migration 009 (`619d324`); 007 left as applied, error recorded in 009's header |
| `PROVIDER_KEK` was documented for Dokploy but `docker-compose.yml` passes variables explicitly, so it never reached the container | `docker exec … test -n "$PROVIDER_KEK"` → `KEK ABSENT` | compose passthrough (`6bfec82`) |
| A freshly generated KEK was pasted into the working chat as an "example" | operator noticed on prompt | treated as burned; regenerated before any seal existed, so nothing had to be re-entered — the "KEK before API key" ordering is what made this free |
| `rolenote danger` class used before it existed in CSS | review of round 8 | added in round 9 (`020d76b`) |
| Guard `offers_to_act` written for "would you like to proceed" only; model produced "would you like to issue…" | live conversation 2 | rule rebuilt around a shared `ACT_VERBS` list (`c816d20`) |

**Process notes.** Three of fifteen commits were staged with `git add .`
against the phase's own rule; each was checked byte-for-byte against the
delivered file after push and found identical, which is the check that made
them safe, not the command. One "pushed successfully" report was false
(`tools.js` was on disk, uncommitted) and was caught by the mandatory
`git log origin/main` verify step.

## 7. Live checks — what was actually observed

All on `greenhouse.progrex.tech`, 3 September 2026, container
`smart-greenhouse-project-sdigfbackend-vzhl26-sdigf-backend-1`.

| # | Check | Observed |
|---|---|---|
| 1 | Deploy without KEK | level-40 `PROVIDER_KEK not set — AI assistant unavailable…`; server listened normally |
| 2 | Deploy with KEK | `KEK present, length 44`; level-30 `provider key-encrypting key installed` |
| 3 | Status routes before any key | `/api/provider` and `/api/chat/status` → `status: "not_configured"`; non-admin route omits `updatedBy` |
| 4 | First seal (OpenAI, gpt-4o) | panel: `Configured · openai · gpt-4o · ends in …r04A · changed 9/3/2026 12:21:34 PM by admin`; DB row: `nonce_bytes 12`, `ct_bytes 180` (164-char key + 16 tag), `kek_fingerprint 8fbae07045763ec7` |
| 5 | **Tamper, reversible** — one bit flipped in ciphertext byte 3 via `set_byte` | `/api/provider` → `status: "tampered"`, `usable: false`; log level 50: `SDIGF_PROVIDER_KEY_TAMPER_SUSPECTED provider_settings ciphertext failed AES-GCM authentication under the SAME KEK that sealed it (fp 8fbae07045763ec7). The row was altered after it was written. last4=r04A updated_at=… updated_by=admin-12929e6b` — no key material. Restored from backup → `status: "ok"` |
| 6 | First conversation, "humidity is low, what should I do?", as engineer, admin, farmer | Every reply opened with the freshness line naming the mock and "No firmware exists". Flags survived as words ("marked as ok"). No growing value. Engineer → manual command or review configuration; farmer → manual command or raise with an engineer; admin → explanation, no operational suggestion. Guard accepted attempt 1 ×3 |
| 6a | Finding: engineer reply ended "Would you like to proceed with a manual command…?" | offer to act; no rule existed → `78cc3ee` |
| 6b | Finding: admin reply said "These levels are not excessively low" | crop judgment with no number; brief-level rule → `78cc3ee`; recorded as not guard-enforceable |
| 6c | Suspected: engineer reply said "no humidity thresholds configured" | verified: `cfg.hum` is all `null`. Model was right. Not a finding |
| 7 | Same question after `78cc3ee` | reply ended "Would you like to issue a temporary command…?" — guard accepted. Regex gap → `c816d20`. Also: markdown rendered raw → brief: plain text only |
| 8 | Same question after `c816d20` | plain text, no closing offer, defers the low/high judgment to the person, suggestion in the shape the engineer performs. Guard accepted attempt 1 |

## 8. Known limitations

- Crop judgments without numbers are prompt-enforced only (§4).
- Regex guards have false negatives by nature.
- The tool loop is capped at 6 rounds per attempt and history at 12 turns; a
  long investigation will hit the cap and be told to ask something narrower.
- `get_active_config` reads field names with fallbacks (`cfgHash`/`cfg_hash`)
  because the row mapper was read through the route, not directly; harmless,
  untidy.
- One VPS: the key-split is design-level, not effect-level (§3).
- The Chrome "password field not in a form" console warning prints the input
  element including its `value`. On the login page that is the password. It is
  a browser lint, not the app, but screenshots of the console should be taken
  with care.

## 9. Not done, by decision

- `/api/mcp` external endpoint (§1).
- Any write path.
- Camera / image inspection (Phase 06 does not exist).
- Changes to 05a, 05b or 07 to accommodate this phase — none were needed. The
  05a API wrapped without retrofitting, as it was built to.

## 10. Thesis follow-ups (recorded here, done in the thesis chat)

- Chapter 10 §10.7: farmer capabilities → match `auth.js`.
- Chapter 10 §10.13: replace "not pushed" with the pushed state.
- Name the phase "read-only assistant / tool-calling chat", not "MCP server".
- Carry the §3 limitation and the Oracle-Problem framing through unchanged.
