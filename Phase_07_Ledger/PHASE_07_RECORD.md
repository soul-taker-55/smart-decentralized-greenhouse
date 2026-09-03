# PHASE 07 — THE LEDGER. PHASE RECORD.

Hand this to the planner. Repo is canonical; everything below was checked against
it or against the live system, not against chat history.

---

## 1 · WHAT PHASE 07 CONTRIBUTES — STATED NARROWLY

Phase 07 adds **nothing** to the trust model. It is not a second trust mechanism.

> **The chain-integrity check turns "erasable" into "detectably erasable."**

An administrator can still delete or rewrite session-attributed history. What they
cannot do is leave the chain consistent afterwards without rebuilding every
subsequent link. The record does not become unfalsifiable; it becomes falsifiable
only in ways that announce themselves.

Not a blockchain, not consensus, not distributed trust. One operator, one
database, one root credential.

**The Oracle Problem, stated rather than omitted:** no ledger can verify that a
sensor reading was honest, only that what was written has not been altered since.
Some chained events — retrospective local emergency stops — describe things the
server did not witness. The chain proves such a record was not altered after the
fact. It does **not** prove the originally reported time was true. That is a
different claim from the chain's usual one.

---

## 2 · WHAT WAS BUILT

| Path | Purpose |
|---|---|
| `5a_web/db/006_ledger.sql` | schema — explicit `seq`, no FKs, stored `canonical` |
| `5a_web/backend/src/ledger-link.js` | **pure core** — `buildLink`, `timeSql`, `signedFields`, `diffCanonical` |
| `5a_web/backend/src/services/ledger-service.js` | I/O shell — append, backfill, `verifyChain`, `assertTimeVector` |
| `5a_web/backend/test/ledger-link.test.js` | 25 tests, **no database required** |
| `5a_web/backend/tools/tamper-demo.mjs` | six scenarios, disposable database |
| `5a_web/backend/src/routes.js` | `GET /api/ledger/verify` (`CAP.VIEW`) |
| `5a_web/frontend/src/components/ActivityPage.jsx` | the audit-chain panel |
| edits to `db.js`, `index.js`, and 5 services | INT8 pin warning, boot check, append wiring |

### The pure/shell split was forced, not chosen

`ledger-service.js` imports `db.js` → `config.js`, which throws on a missing
`PG_PASS` **at import time**. The existing suite works around this by skipping
whole files unless `SDIGF_TEST_DB=1`. Applying that here would have meant the
frozen-vector and wire-name assertions only ran on a machine with a database —
the assertions that matter most being the ones most often skipped. So the pure
core moved to `src/ledger-link.js` beside `canon.js`, and the tests import that.

---

## 3 · VERIFIED LIVE vs VERIFIED IN SANDBOX

Never blur these.

### VERIFIED LIVE — on the deployed VPS stack

| Claim | Evidence |
|---|---|
| Schema applied to `sdigf_backend` | `BEGIN … CREATE TABLE … COMMIT`, TimescaleDB 2.29.2-pg16 |
| Zero foreign keys on `ledger` | `count(*) = 0` from `pg_constraint` |
| No default on `seq` | `column_default` empty |
| **Frozen time vectors** | `time_format_frozen = t` against the real database |
| `assertTimeVector()` gates startup | log line 2, after canonicalization, before MQTT |
| Backfill of pre-ledger history | `{ chained: 57, fromSeq: 1, toSeq: 57 }` |
| **Strict append through real services** | seq 58, 59 `COMMAND_ISSUED`, `backfilled = false` |
| `verifyChain` on the live chain | `ok true · length 59 · realTimeFrom 58 · unchained 0` |
| Endpoint + panel | ✅ rendering live; caveat-prominence fix `8f101f3` deployed as bundle `index-JPbHynHa.js` and captured as the Chapter 12 figure |

### VERIFIED IN SANDBOX — local Postgres 16.15, migrations 001–006

| Claim | Evidence |
|---|---|
| All five strict services chain | 7 links incl. a signature-bearing one at seq 6 |
| Cross-table reach | editing `config_approvals.signature` → `CONTENT_CHANGED`, diff names `signature.signature` |
| **E-stop publishes with the ledger broken** | `ledger` table renamed away → `published=true`, `chained=false`, MQTT fired, no throw |
| Gap is flagged, not silent | `UNCHAINED_EVENT` on restore, then reconciled `backfilled=true` |
| Six tamper scenarios | `tools/tamper-demo.mjs`, full output |
| Concurrent genesis appends | no fork; PK rejects the second |

**NOT verified live:** the e-stop path. Deferred — see §7.

---

## 4 · THE THREE SPECIFICATION POINTS THAT CAME FROM TESTING

Each looks like an oversight. Each was established by building and testing, not
by reasoning, and a build from the design alone would reproduce all three.

**1 — No foreign key on `ledger.event_id`.** A `REFERENCES` constraint makes
deleting a `server_events` row impossible, so the `EVENT_MISSING` check becomes
unreachable dead code — the database refusing the very tamper the check exists to
detect. `UNIQUE` is kept; it prevents two links claiming one event, a writer bug
rather than an attack. **Demonstrated by scenario 2**, which is only reachable
because the constraint is absent.

**2 — `seq` inserted explicitly, never `BIGSERIAL`.** `seq` is part of the hashed
content. A sequence does not reset when rows are deleted, so the column value can
silently diverge from the hashed value, and every later verification then fails
with a mismatch indistinguishable from tampering.

**3 — Check 5 and `realTimeFrom` computed outside the chain walk.** The walk
returns at its first failure. If they ran after it, an unchained event alongside
any other break would be invisible — the two things added specifically to close
gaps being exactly what does not run when verification actually fails.
**Demonstrated live in scenario 4**, where `PREV_MISMATCH` at seq 5 and
`unchained: 1` were both reported from one call.

### A fourth, found during this phase

**`time` must be a frozen string, and restoring a row through a JS `Date` breaks
it.** The tamper demo's first run reported the wrong failure at the wrong link,
with a diff naming `time`: `…331412Z` stored vs `…331000Z` current. Scenario 2's
restore had round-tripped the timestamp through `Date`, which holds milliseconds.
The ledger was right; the harness was not. Restores now use the same `to_char`
expression the ledger uses. The hazard is the precise one `time` is a string for.

### A fifth, found by testing COLD

**Preflight validated one connection target while the work used another.** The
tamper demo's preflight connects via its own `ADMIN` object, which defaults
`PG_HOST` to `127.0.0.1`. The script then set only `PG_DB` and let `config.js`
supply the rest — and `config.js` defaults `PG_HOST` to `sdigf-db`, the Docker
service name, correct inside the compose network and unresolvable outside it.
Preflight passed; the run then died on `getaddrinfo ENOTFOUND sdigf-db`.

**A preflight that validates a different target from the one the work uses is not
a preflight.** Fixed by propagating host, port and user, not just the database
name.

This would never have surfaced with `PG_HOST` set in the environment, which is
how every earlier run had been made. It appeared only on a genuinely cold run
from a fresh clone with nothing configured — the condition the fix was written
for in the first place.

---

## 5 · FIXED FACTS ABOUT THIS DEPLOYMENT

**`realTimeFrom = 58`.**

Links 1–57 are backfilled: they prove content integrity, but their ordering is
asserted after the fact. From link 58 forward, ordering was observed as it
happened. 58 and 59 are `COMMAND_ISSUED` events written through the real strict
path after the wiring deployed.

Backfill was run **before** the first real-time append, deliberately. The reverse
order would have put one real-time link at seq 1 and made `realTimeFrom` report
`1` — claiming real-time ordering from genesis while 57 of 58 links were
retrospective. `realTimeFrom` is a single number and can only mean "everything
from here forward was chained as it happened", which is true only if the
backfilled block sits at the bottom.

Frozen time expression, unchangeable without rewriting every hash:

```sql
to_char(time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
```

Vectors: `2026-08-25 14:03:07.123456+03` → `2026-08-25T11:03:07.123456Z`;
`2026-01-02 03:04:05+00` → `2026-01-02T03:04:05.000000Z`.

Frozen wire names in the hashed object, differing from their source columns:
`gh` ← `gh_id`, `prev` ← `prev_hash`, `approval_id` ← `config_approvals.id`.

---

## 6 · THE HONEST BOUNDARY — AND A NEW FINDING BESIDE IT

### Scenario 6: consistent rewrite from genesis

An administrator deletes a range of events and rebuilds every subsequent link
using **the same `buildLink()` the legitimate writer uses**. Verification reports
`ok`. Measured:

```
BEFORE  9 links, ok
        1:KEY_REGISTERED  2:KEY_REGISTERED  3:APPROVAL_POLICY_CHANGED
        4:CONFIG_CREATED  5:CONFIG_PROPOSED  6:CONFIG_APPROVED
        7,8,9:COMMAND_ISSUED

ATTACK  erase CONFIG_CREATED, CONFIG_PROPOSED, CONFIG_APPROVED
        rebuild every link from genesis

AFTER   6 links, verification ok, unchained 0
```

Not a gap in the implementation. It is the boundary of what an **unanchored**
chain can prove: genesis anchors nothing outside the system, so a rewrite from
genesis is internally consistent by construction. External anchoring is named
future work and is not built.

### What survived — measured, not asserted

```
approval 1 by eng-omar (key eng-dea3007e)
    decision    : approve
    re-verified : VALID
    recomputed  : sha256(cfg_canonical) = eeda43af408f0128…
    stored      : cfg_hash             = eeda43af408f0128…
```

Ordering and narrative were destroyed and the chain still reports ok. Approvals
were not and cannot be: a signature never produced cannot be fabricated by
anyone, including an administrator with full database access, because the server
never held the private key.

### NEW FINDING — `realTimeFrom` is attacker-controlled after a rewrite

**Write this up beside scenario 6, not as a separate caveat.**

`realTimeFrom` is `MIN(seq) WHERE backfilled = false`. An administrator rebuilding
from genesis writes those rows, so they choose the flag — and therefore the
boundary. In the demo the rewritten chain reported `realTimeFrom = 1`: the
strongest possible claim, produced entirely by the attacker.

This does not weaken the design. `backfilled` was introduced so that verification
would not return uniform green across links proving genuinely different things —
a **disclosure**, never a tamper defence. But a reader who takes `realTimeFrom`
as a guarantee is misreading it, and the panel currently displays the number
without saying so.

It is the same limitation as scenario 6 reaching one layer further than the
demonstration showed: not only can a rewrite go undetected, the metadata
describing how much of the chain is trustworthy is itself rewritten. Stating it
strengthens the honest boundary rather than weakening it.

---

## 7 · OPEN ITEMS

**Live e-stop through the deployed stack — DEFERRED to Phase 02 bring-up.**
The best-effort path's most important property (publish survives ledger failure)
cannot be shown live without deliberately breaking the deployed audit trail. What
a live run would add is that the wiring works end to end — the weaker half. Worth
more during firmware bring-up, with a real device on the other end.

**Chapter 12 (the ledger) — unwritten.** Should close on scenario 6 with the
`realTimeFrom` finding beside it. A reviewer will construct that attack; the work
is stronger for having constructed it first.

**Chapter 10 §10.13 — STALE AND MUST BE CORRECTED.** It states that Phase 05a/05b
is not yet pushed to the public repo. It is, and has been throughout Phase 07.
The paragraph currently disclaims work a reader can verify — worse than silence.

**`realTimeFrom` disclosure in the panel** — the finding above is documented here
but the UI still presents the number without qualification.

---

## 8 · METHODOLOGY NOTES

**Two UI defects were found by looking at the rendered page, not by review.**

1. The grid mismatch that made an active emergency stop render as nothing.
2. The audit-chain caveat rendered in `--muted` while the result was bold
   `--text`. Reviewing the code shows a caveat block present and correctly
   worded; only the rendered page shows the eye landing on "No alteration
   detected" and leaving. **The requirement was satisfied at half strength, which
   is worse than not at all, because it looks addressed and a checklist passes.**
   Cause: inherited styling from surrounding panels rather than a decision.

**Two overstatements caught by deliberate re-reading, not by failure.** Neither
broke anything; both would have shipped.

1. *The half-strength caveat in the panel.* The scope block was present and
   correctly worded, but rendered in `--muted` against a bold result. Code review
   shows a compliant panel; only the rendered page shows the eye landing on "No
   alteration detected" and leaving.
2. *The scenario 6 survival claim.* The line "APPROVALS were not, and cannot be
   — a signature that was never produced cannot be fabricated by anyone" sat
   directly beneath a demonstration in which **the approval row was never
   attacked**. The attack deleted `server_events` rows only; `config_approvals`
   and `config_profiles` survived untouched, which is precisely why the signature
   could be re-verified. True in a narrow sense, read broader: the signature
   survived *a* destruction that did not target it, not *the* destruction. The
   real claim is narrower — **a past approval cannot be FORGED, never that it
   cannot be ERASED** — and is now stated on screen.

**These are the same class of error, and both were found by being asked to check
rather than by anything failing.** Together they are the evidence that
overstatement in this project has been caught by deliberate re-reading rather
than by accident — which is an argument for keeping the re-reading step, not for
trusting that it will not be needed next time.

**A React crash from an unread module contract.** `api.js` states in its header
that every call returns `{ data, error }` and never throws. The panel stored the
envelope as the payload; every field read `undefined`, the render threw, and
React unmounted the whole tree — a blank page. The `.catch()` written alongside
was dead code that could never fire. Exports were checked; the contract was not.

**Both `git add .` incidents were caught after the fact, not prevented.** Each
commit was clean, verified by a delete-filter check across the range. The rule
exists because that check is what gets skipped on a tired day, and the failure is
silent.
