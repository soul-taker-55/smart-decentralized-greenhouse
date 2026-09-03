# PHASE 07 — STATUS FOR THE PROJECT PLANNER

**As of:** `1418eb6` on `origin/main`, working tree clean.
**Phase state:** CLOSED AND VERIFIED. One decision blocking follow-on work.

---

## 0 · ONE-PARAGRAPH SUMMARY

Phase 07 built a hash-chained audit ledger over `server_events`, with the
referenced approval signature resolved and hashed into each link so that
tampering with either table breaks the chain. It is deployed and live on the VPS.
Verification passes on the real chain: 59 links, `realTimeFrom = 58`, no
unchained events. The phase's thesis deliverable — a six-scenario tamper
demonstration — is committed and runs. All four pre-closure checks were run
against the live system rather than carried forward from the build session, and
one stale claim in the phase record was caught and corrected in the process.
**One item is blocked pending a decision: the tamper demo does not run from a
fresh clone without preparation, which matters because it is meant to be run in
front of an examiner.**

---

## 1 · WHAT PHASE 07 CONTRIBUTES — STATED NARROWLY

Phase 07 adds **nothing** to the trust model. It is not a second trust mechanism.

> **The chain-integrity check turns "erasable" into "detectably erasable."**

An administrator can still delete or rewrite session-attributed history. What
they cannot do is leave the chain consistent afterwards without rebuilding every
subsequent link. The record does not become unfalsifiable; it becomes falsifiable
only in ways that announce themselves.

Not a blockchain, not consensus, not distributed trust. One operator, one
database, one root credential.

**The Oracle Problem is stated rather than omitted.** No ledger can verify that a
sensor reading was honest, only that what was written has not been altered since.
Some chained events — retrospective local emergency stops — describe things the
server did not witness. The chain proves such a record was not altered after the
fact. It does not prove the originally reported time was true. That is a
different claim from the chain's usual one.

---

## 2 · THE BUILD, STEP BY STEP

The build order came from the phase brief. Each step was verifiable before the
next began.

### Step 1 — Schema (`db/006_ledger.sql`)

`ledger(seq, event_id, prev_hash, entry_hash, canonical, backfilled, created_at)`.

Four deliberate omissions, each of which looks like an oversight:

| Omission | Why |
|---|---|
| No FK `prev_hash → entry_hash` | a constraint that refuses to STORE a broken chain leaves verification nothing to detect |
| No FK `event_id → server_events(id)` | a REFERENCES constraint makes deleting an event impossible, so the `EVENT_MISSING` check becomes unreachable dead code |
| No `ON DELETE CASCADE` | a dangling link IS the evidence; cascading lets deletion tidy up after itself |
| `seq` explicit, not `BIGSERIAL` | `seq` is hashed content; a sequence does not reset on delete, so the column can silently diverge from the hashed value |

`canonical` is **stored, not recomputed** — an auditor sees the exact bytes that
were hashed, and a mismatch becomes diffable down to the field that changed.

Applied live to `sdigf_backend`. Three verification queries passed at the time
and again at closure.

### Step 2 — Service

Split into two files, and the split was **forced, not chosen**:

- `src/ledger-link.js` — pure core. `buildLink`, `timeSql`, `TIME_VECTORS`,
  `signedFields`, `diffCanonical`. Imports `canon.js` and nothing else.
- `src/services/ledger-service.js` — I/O shell. `appendToLedger`,
  `appendBestEffort`, `verifyChain`, `backfillLedger`, `getHead`,
  `assertTimeVector`.

**Why the split was necessary:** `ledger-service.js` imports `db.js` →
`config.js`, which throws on a missing `PG_PASS` **at import time**. The existing
test suite works around this by skipping whole files unless `SDIGF_TEST_DB=1`.
Applying that pattern here would have meant the frozen-vector assertions ran only
on a machine with a database — the most important tests being the most often
skipped. The pure core is importable with no infrastructure.

### Step 3 — Tests (`test/ledger-link.test.js`)

25 tests, no database required. Frozen wire names, frozen time format, the INT8
type-parser pin, determinism across key insertion order, strictness inherited
from `canon.js`.

### Step 4 — Wiring

Six write paths. Five strict, one best-effort.

| Service | Mode | Events covered |
|---|---|---|
| `config-service.recordEvent` | strict | five config lifecycle event types |
| `key-service` | strict | `KEY_REGISTERED` |
| `command-service` | strict | `COMMAND_ISSUED` |
| `approval-service` (policy) | strict | `APPROVAL_POLICY_CHANGED` |
| `approval-service` (vote) | strict | `CONFIG_APPROVED` — **the only signature-bearing link** |
| `estop-service` ×2 | **best-effort** | `ESTOP_TRIGGERED` / `ESTOP_CLEARED` |

Plus `index.js`: `assertTimeVector()` after `checkConnections()`, hard startup
failure, and a warning comment at `db.js`'s `setTypeParser(INT8, Number)` line.

**Every insert site was re-read before writing.** A concern that
`config-service`'s event logger used the pool directly turned out to be wrong —
it already took a transaction client and all five callers passed one, making it
the cheapest site rather than the most expensive. Flagging it at plan stage cost
nothing and would have caught the opposite.

### Step 5 — Backfill

57 pre-ledger events chained in one transaction, `backfilled = true`.
`{ chained: 57, fromSeq: 1, toSeq: 57 }`, then `verifyChain` → `ok`,
`realTimeFrom: null` (correct: nothing yet written in real time).

### Step 6 — Tamper demonstration (`tools/tamper-demo.mjs`)

Six scenarios against a disposable database. In `tools/` rather than `test/`
deliberately: scenario 6 correctly returns `ok` after a successful attack, which
under `node --test` would read as a passing test of a failing system.

### Step 7 — Endpoint and panel

`GET /api/ledger/verify`, guarded by `CAP.VIEW` — all three roles including
admin. The chain defends against an admin **altering** it, not **reading** it;
hiding the result would protect nothing while making the audit visible to only
some staff.

The response carries a `claim` block in the payload, not only the UI, so any
future consumer (Phase 05c MCP server, a thesis figure script) inherits the
bounded claim. A caller rendering `ok` without it is visibly discarding
something.

---

## 3 · VERIFIED LIVE vs VERIFIED IN SANDBOX

**Never blur these.**

### VERIFIED LIVE — deployed VPS stack

| Claim | Evidence |
|---|---|
| Schema applied | `BEGIN … CREATE TABLE … COMMIT` on TimescaleDB 2.29.2-pg16 |
| Zero foreign keys | `SELECT … contype='f'` → 0 rows |
| No default on `seq` | `column_default` empty |
| UNIQUE constraints retained | `UNIQUE (entry_hash)`, `UNIQUE (event_id)` |
| Frozen time vectors | `time_format_frozen = t` against the real database |
| `assertTimeVector()` gates startup | log line 2, after canonicalization, before MQTT |
| Backfill | `{ chained: 57, fromSeq: 1, toSeq: 57 }` |
| Strict append through real services | seq 58, 59 `COMMAND_ISSUED`, `backfilled = false` |
| Chain state | `59 links · min 1 · max 59 · 57 backfilled` |
| Endpoint | `ok true · verifiedThrough 59 · realTimeFrom 58 · unchainedEvents [] · claim intact` |
| Deployed bundle | `index-JPbHynHa.js` |
| Panel figure | captured, caveat at full weight |

**Cross-check worth noting:** the endpoint's `head.entryHash` begins
`5be47bfed5f3e157`, matching the seq-59 hash read directly from the table. Two
independent paths, same value.

### VERIFIED IN SANDBOX — local Postgres 16.15

| Claim | Evidence |
|---|---|
| All five strict services chain | 7 links incl. a signature-bearing one at seq 6 |
| Cross-table reach | editing `config_approvals.signature` → `CONTENT_CHANGED`, diff names `signature.signature` |
| **E-stop publishes with the ledger broken** | `ledger` renamed away → `published=true`, `chained=false`, MQTT fired, no throw |
| Gap flagged, not silent | `UNCHAINED_EVENT`, then reconciled `backfilled=true` |
| Six tamper scenarios | full output |
| Concurrent genesis appends | no fork; PK rejects the second |
| Tests without infrastructure | 88 pass, 0 skipped, `SDIGF_TEST_DB` unset |

**NOT verified live: the e-stop path.** Its most important property — publish
survives ledger failure — cannot be shown live without deliberately breaking the
deployed audit trail. Deferred to Phase 02 bring-up, where a real device makes it
worth more.

---

## 4 · SPECIFICATION POINTS THAT CAME FROM TESTING, NOT REASONING

Three came from the brief. A fourth was found during this phase.

**1 — No foreign key on `ledger.event_id`.** Same mistake as `prev_hash`, one
column over. Demonstrated by scenario 2, which is only reachable because the
constraint is absent.

**2 — `seq` inserted explicitly.** A sequence does not reset when rows are
deleted, so the column value can diverge from the hashed value, and every later
verification fails indistinguishably from tampering.

**3 — Check 5 and `realTimeFrom` computed outside the chain walk.** The walk
returns at its first failure; a check running after it would be missing exactly
when verification fails. Demonstrated live in scenario 4, which reports
`PREV_MISMATCH` at seq 5 **and** `unchained events 4` from one call.

**4 — NEW: restoring a row through a JS `Date` loses microseconds.** The tamper
demo's first run reported the wrong failure at the wrong link, with a diff naming
`time`: `…331412Z` stored vs `…331000Z` current. Scenario 2's restore had
round-tripped the timestamp through `Date`, which holds milliseconds. **The
ledger was right; the harness was not.** This is the precise hazard `time` is a
frozen string for. Restores now use the same `to_char` expression the ledger
uses, and each destructive scenario prints a `[restored byte-exactly]`
confirmation so a damaged fixture cannot masquerade as a finding.

---

## 5 · FIXED FACTS ABOUT THIS DEPLOYMENT

**`realTimeFrom = 58`.**

Links 1–57 are backfilled: content integrity proven, ordering asserted after the
fact. From 58 forward, ordering was observed as it happened.

**Backfill ran before the first real-time append, deliberately.** The reverse
order would have put one real-time link at seq 1 and made `realTimeFrom` report
`1` — claiming real-time ordering from genesis while 57 of 58 links were
retrospective. `realTimeFrom` is `MIN(seq) WHERE backfilled = false`, a single
number, and only means what it says if the backfilled block sits at the bottom.

Frozen time expression, unchangeable without rewriting every hash:

```sql
to_char(time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
```

Vectors: `2026-08-25 14:03:07.123456+03` → `2026-08-25T11:03:07.123456Z` ·
`2026-01-02 03:04:05+00` → `2026-01-02T03:04:05.000000Z`.

Frozen wire names, differing from their source columns: `gh` ← `gh_id`,
`prev` ← `prev_hash`, `approval_id` ← `config_approvals.id`.

---

## 6 · THE HONEST BOUNDARY

### Scenario 6 — consistent rewrite from genesis

An administrator deletes a range of events and rebuilds every subsequent link
using **the same `buildLink()` the legitimate writer uses**. Verification reports
`ok`.

```
BEFORE  9 links, ok
        1:KEY_REGISTERED  2:KEY_REGISTERED  3:APPROVAL_POLICY_CHANGED
        4:CONFIG_CREATED  5:CONFIG_PROPOSED  6:CONFIG_APPROVED
        7,8,9:COMMAND_ISSUED

ATTACK  erase CONFIG_CREATED, CONFIG_PROPOSED, CONFIG_APPROVED
        rebuild every link from genesis

AFTER   6 links, verification ok, unchained 0
        3 links and 3 events are gone.

WHAT SURVIVED
  approval 1 by eng-omar (key eng-f7b45be3)
      re-verified : VALID
      recomputed  : sha256(cfg_canonical) = eeda43af408f01281455e59b341d9620…
      stored      : cfg_hash             = eeda43af408f01281455e59b341d9620…
```

Not a gap in the implementation. It is the boundary of what an **unanchored**
chain can prove: genesis anchors nothing outside the system, so a rewrite from
genesis is internally consistent by construction. External anchoring is named
future work and is not built.

Both halves of *"history can be destroyed, approvals cannot be invented"* are
**measured, not asserted** — the surviving signature is re-verified against its
registered public key by the script itself.

### `realTimeFrom` is attacker-controlled after a rewrite

An administrator rebuilding from genesis writes those rows and therefore chooses
the `backfilled` flag — and so the boundary. In the demonstration the rewritten
chain reported `realTimeFrom = 1`: the strongest possible claim, produced
entirely by the attacker.

This does not weaken the design. `backfilled` exists so verification does not
return uniform green across links proving genuinely different things — a
**disclosure**, never a tamper defence. But a reader who takes `realTimeFrom` as
a guarantee is misreading it.

**Write this beside scenario 6 in Chapter 12, not as a separate caveat.** It is
the same limitation reaching one layer further: not only can a rewrite go
undetected, the metadata describing how much of the chain is trustworthy is
itself rewritten.

---

## 7 · THE PANEL, AND WHAT NEARLY UNDID THE PHASE

The brief's step 7 said *"a dashboard panel showing chain head, verify result and
realTimeFrom."* Built literally, that is a green checkmark reading "Chain OK" —
asserting exactly what scenario 6 disproves.

Four requirements, supplied mid-phase rather than by the brief:

1. never display the result alone
2. always show `realTimeFrom` with its meaning in words
3. state the scope of the claim in the panel, not a tooltip
4. no green-checkmark iconography — full-saturation green stays reserved for
   reading quality

**Even then it landed at half strength.** The caveat rendered in `--muted`
against a bold `--text` result. On review the code shows a caveat block present
and correctly worded; only the rendered page shows the eye landing on "No
alteration detected" and leaving. **The requirement was satisfied at half
strength, which is worse than not at all, because it looks addressed and a
checklist passes.** Cause: inherited styling from surrounding panels rather than
a decision. Fixed in `8f101f3`, now deployed and photographed.

**Lesson for future briefs:** a brief that carefully bounds a claim for eight
sections and then specifies the UI in one line will have that care undone by the
interface. This applies immediately to Phase 05c, where an LLM will phrase claims
about system state in natural language — the least constrained surface in the
project.

---

## 8 · CLOSURE VERIFICATION

Four items were run against the live system rather than reported from memory.

| # | Item | Result |
|---|---|---|
| 1 | Local `git status` | clean, HEAD = `origin/main` at `1418eb6` |
| 2 | Three schema queries against **live** `sdigf_backend` | all three pass — no manual `ALTER TABLE` undid them |
| 3 | Live chain + endpoint | `59 / 1 / 59 / 57`, full JSON body captured |
| 4 | Redeploy + panel capture | `index-JPbHynHa.js`, figure captured |

**The verification caught a sixth stale claim.** The phase record listed the
endpoint and panel as VERIFIED LIVE, but that row was written before `8f101f3` —
the deployed panel at the time was still the half-strength version. Corrected to
*"panel rendering live as of `1d22417`; caveat-prominence fix `8f101f3`
committed, deployment unconfirmed."* That fix is now deployed, so the row can be
promoted to fully verified when the record is next touched.

Three of the seven verification checks depended on the live system and were
marked **NOT VERIFIED** rather than softened. Reporting them as passed on the
strength of an earlier session would have been precisely the failure the
verification instruction guards against.

---

## 9 · WHAT IS BLOCKING ME

**One decision.**

`tamper-demo.mjs` does **not** run from a fresh clone. Tested on a clean clone of
`1418eb6`:

| Condition | Result |
|---|---|
| No Postgres running | `Error: connect ECONNREFUSED 127.0.0.1:5432` + raw stack trace |
| Postgres up, no `PG_PASS` | `SASL: client password must be a string` + raw stack trace |
| `PG_PASS` set | runs correctly, all six scenarios |

`node_modules` is committed, so `pg` imports fine — the blocker is purely the
database connection.

This matters because the demo is intended to be **run live in front of an
examiner**. A red stack trace reads as broken software rather than a missing
prerequisite.

**Two options:**

- **Preflight check** — ~15 lines. Attempt the admin connection first; on failure
  print a plain-language message naming exactly what to do, then exit cleanly.
  No stack trace. Safe to run cold.
- **README only** — no code change; the ugly failure mode remains if the step is
  missed.

**My recommendation: preflight.** The script's entire purpose is to be run in
front of someone judging the work by what appears on screen. It is also
consistent with the phase: `config.js` fails at startup rather than on first
request, `assertTimeVector` refuses to boot rather than warn.

**Awaiting: preflight, or README only?**

---

## 10 · QUEUED BEHIND THAT DECISION

**A — Non-technical README** in `Phase_07_Ledger/`, answering the examiner's
three questions in plain language:

- *"What is the source code of the blockchain you performed?"* — names the four
  source files and what each does
- *"How did you perform it?"* — the mechanism in plain terms
- *"Do you store any data on it?"* — the data/evidence split: config values stay
  in `config_profiles`; only the hash and signature cross into the chain, which
  is why editing the database breaks the match

Plus a plain statement that this is a hash-chained log and **not** a blockchain,
with the reason.

**B — The fresh-clone fix or documented step**, per the decision above.

**C — My view on whether scenario 6's console output is print-ready** as a thesis
figure verbatim, or needs reformatting.

---

## 11 · OPEN ITEMS, NOT BLOCKING

| Item | State |
|---|---|
| Live e-stop through the deployed stack | deferred to Phase 02 bring-up |
| Chapter 12 (the ledger) | unwritten; the phase record is structured to become it |
| Chapter 10 §10.13 | **stale** — still claims Phase 05a/05b is unpushed; it has been public throughout |
| Phase record's panel row | can be promoted to fully verified now that `8f101f3` is deployed |
| `Phase_07_Ledger/` orientation note | folder holds documentation pointing at code under `Phase_05_Backend_Dashboard/5a_web/` |

---

## 12 · WHAT PHASE 07 DID NOT MOVE

**Phase 02/03 firmware remains unwritten and blocked on ESP32 wiring.** It is the
project's critical path. Phase 07 was server-tier work done alongside that
blocker, not against it. Worth stating plainly in the next plan.

---

## 13 · METHODOLOGY NOTES

**Two UI defects found by looking at the rendered page, not by review.** The grid
mismatch that made an active emergency stop render as nothing, and the audit
caveat rendered dim against a bold result. Both invisible in code review.

**A React crash from an unread module contract.** `api.js` states in its header
that every call returns `{ data, error }` and never throws. The panel stored the
envelope as the payload; every field read `undefined`, the render threw, and
React unmounted the whole tree — a blank page. The `.catch()` written alongside
was dead code that could never fire. Exports were checked; the contract was not.

**Both `git add .` incidents were caught after the fact, not prevented.** Each
commit was clean, verified by a delete-filter check across the range. The rule
exists because that check is what gets skipped on a tired day, and the failure is
silent.

**One planning error, caught before execution.** Backfill ordering: the operator
was initially told to issue a command before running `backfillLedger()`, which
would have produced `realTimeFrom = 1` on the live chain. Corrected before it
ran. This is recorded here because §5 states the ordering as settled without
noting it was nearly wrong.
