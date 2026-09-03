# PHASE 07 — INDEPENDENT VERIFICATION REPORT

**For the project planner.** Run in response to the pre-closure verification
request. Every result below is actual command output, not recollection.

**Verified against:** `origin/main` at `e224456`, freshly fetched.
**Environment:** clean clone of the public remote + local Postgres 16.15,
migrations 001–006 applied from the committed files.

> **RECOMMENDATION: DO NOT CLOSE ON THIS REPORT ALONE.**
> Three of the seven checks depend on the live VPS. I ran none of them. See §4,
> §7, and the caveat in §3.

---

## SUMMARY

| # | Check | Result |
|---|---|---|
| 1 | Everything pushed | ✅ **12 commits on origin** — working tree not checkable by me |
| 2 | Files exist in repo | ✅ all six, both halves of the split |
| 3 | Three §7 spec points | ✅ intact in the committed migration — live schema unchecked |
| 4 | Live chain verification | ⚠️ **NOT VERIFIED — no route to the VPS** |
| 5 | Tamper demo runs | ✅ six scenarios, full output |
| 6 | Tests without infrastructure | ✅ **88 pass, 0 skipped**, `SDIGF_TEST_DB` unset |
| 7 | Panel fix deployed | ⚠️ **committed, not confirmed deployed. No screenshot exists.** |

**One disagreement with the phase record — see §8.**

---

## 1 · IS IT ALL PUSHED?

```
$ git log --oneline 55e2b9f..origin/main
e224456 Phase 07: phase record
8f101f3 Phase 07: caveat at full weight - the requirement was met at half strength
1d22417 Phase 07: fix ledger panel - api.js returns an envelope and never throws
a5d6ca7 Phase 07: ledger verify endpoint and Activity panel - result, boundary and scope
cd4384e Phase 07: Tamper Demonstration - six scenarios against a disposable database
cf062f3 Phase 07: e-stop ledger append - best-effort, awaited after publish, never throws
f21bea3 Phase 07- Preparation
2edffce Phase 07: warn that the ledger's hashes depend on the INT8 type parser
443b2cf Phase 07: ledger tests - frozen time vectors, wire names, INT8 pin
a79feb7 Phase 07: ledger service - append, backfill, verifyChain
f7a8b34 Phase 07: pure link core - frozen wire names and time expression
9066097 Phase 07: ledger schema - explicit seq, no FKs, stored canonical
count: 12

$ git log origin/main --oneline -3
e224456 Phase 07: phase record
8f101f3 Phase 07: caveat at full weight - the requirement was met at half strength
1d22417 Phase 07: fix ledger panel - api.js returns an envelope and never throws
```

Twelve commits, `9066097` → `e224456`, all on the remote. The prior-loss scenario
is ruled out **for the remote**.

### ⚠ What I cannot check

`git status` on the operator's machine. My clone is of the public remote. If work
sits uncommitted in the working copy, only the operator can see it.

**Action: run `git status` locally and confirm a clean tree.**

---

## 2 · DO THE FILES EXIST IN THE REPO?

```
11577  Phase_05_Backend_Dashboard/5a_web/db/006_ledger.sql
 8450  Phase_05_Backend_Dashboard/5a_web/backend/src/ledger-link.js
19745  Phase_05_Backend_Dashboard/5a_web/backend/src/services/ledger-service.js
28387  Phase_05_Backend_Dashboard/5a_web/backend/tools/tamper-demo.mjs
16380  Phase_05_Backend_Dashboard/5a_web/backend/test/ledger-link.test.js
12129  Phase_07_Ledger/PHASE_07_RECORD.md
```

`ledger-link.js` (pure) and `services/ledger-service.js` (I/O shell) are **both
present** — the split forced by the import-time constraint.

---

## 3 · THE THREE §7 SPECIFICATION POINTS

Committed `006_ledger.sql` applied to a fresh database.

### Bugs 1 and 2 — no foreign keys

```sql
SELECT conname, contype FROM pg_constraint
 WHERE conrelid='ledger'::regclass AND contype='f';

 conname | contype
---------+---------
(0 rows)
```

Zero. `EVENT_MISSING` remains reachable; `prev_hash` can still store a broken chain
for the verifier to detect.

### Bug 2 — `seq` is not `BIGSERIAL`

```sql
SELECT column_name, column_default FROM information_schema.columns
 WHERE table_name='ledger' AND column_name='seq';

 column_name | column_default
-------------+----------------
 seq         |
(1 row)
```

Empty default. No sequence behind it. The hashed value cannot diverge from the
column value.

### UNIQUE constraints retained

```sql
        conname        | contype | pg_get_constraintdef
-----------------------+---------+----------------------
 ledger_entry_hash_key | u       | UNIQUE (entry_hash)
 ledger_event_id_key   | u       | UNIQUE (event_id)
```

`UNIQUE (event_id)` kept — it prevents two links claiming one event, a writer bug
rather than an attack. Only the `REFERENCES` was dropped.

### Bug 3 — check 5 and realTimeFrom precede the walk

From `services/ledger-service.js`:

```js
export async function verifyChain({ unchainedLimit = 100 } = {}) {
  const checkedAt = new Date().toISOString();
  const run = (t, p) => query(t, p);

  // ── Computed independently of the walk. See the warning above. ──
  const unchainedEvents = await findUnchainedEvents(unchainedLimit);

  const boundary = await query(
    `SELECT min(seq) AS real_time_from FROM ledger WHERE backfilled = false`
  );
  const realTimeFrom = boundary.rows[0].real_time_from ?? null;

  // ── The walk ──
  const links = await query(
    `SELECT seq, event_id, prev_hash, entry_hash, canonical, backfilled
       FROM ledger ORDER BY seq ASC`
  );
```

Two separate queries, both executed before `const links`. The walk's early return
cannot skip them.

**Demonstrated, not just inspected:** scenario 4 reports `PREV_MISMATCH` at seq 5
**and** `unchained events 4` from a single call — the walk broke and check 5 still
ran.

### ⚠ Caveat

This is the **committed migration**, not the live schema. A manual `ALTER TABLE`
on the VPS would not appear here.

**Action: run 3a–3c against `sdigf_backend` in the container.**

---

## 4 · DOES VERIFICATION PASS ON THE LIVE CHAIN?

### ⚠ NOT VERIFIED. I have no route to the VPS.

The endpoint requires an authenticated session cookie; my sandbox cannot reach
`greenhouse.progrex.tech`.

**The record's `ok true · length 59 · head 59 · realTimeFrom 58 · unchained 0` is
carried from an earlier run in the build session. It is NOT re-verified by this
report.**

**Action — run both:**

```bash
docker exec -i smart-greenhouse-project-sdigfserver-wyl2we-sdigf-db-1 \
  psql -U postgres -d sdigf_backend -c \
  "SELECT count(*), min(seq), max(seq), count(*) FILTER (WHERE backfilled) FROM ledger;"
```

Expect `59 | 1 | 59 | 57`.

Then `GET /api/ledger/verify` from a logged-in browser, or `curl` with the session
cookie. Paste the full body.

---

## 5 · DOES THE TAMPER DEMO RUN?

**Yes. All six scenarios, against a disposable database that the script creates
and drops itself.**

### The guard is stronger than requested

```js
const DB_NAME = 'sdigf_tamperdemo';
if (!DB_NAME.endsWith('_tamperdemo')) {
  console.error('refusing to run: target database name must end with _tamperdemo');
```

A hardcoded constant, not an environment variable. **There is no way to point it
at another database without editing the source** — stronger than "refuses one it
did not create."

### Results

| Scenario | Reported |
|---|---|
| 1 edit event field | `CONTENT_CHANGED` @seq 4, diff names `actor_id` (`eng-hala` → `eng-omar`) |
| 2 delete event | `EVENT_MISSING` @seq 4; restored byte-exactly, ok |
| 3 edit approval signature | `CONTENT_CHANGED` @seq 6, diff names `signature.signature` |
| 4 delete ledger link | `PREV_MISMATCH` @seq 5, **plus `unchained events 4`** |
| 5 delete link + event | `UNCHAINED_EVENT`, `unchained events 9` |
| 6 rewrite from genesis | **`ok`** — and that is the point |

### Scenario 6 closing evidence — both halves

```
BEFORE  9 links, ok
        1:KEY_REGISTERED  2:KEY_REGISTERED  3:APPROVAL_POLICY_CHANGED
        4:CONFIG_CREATED  5:CONFIG_PROPOSED  6:CONFIG_APPROVED
        7,8,9:COMMAND_ISSUED

ATTACK  erase CONFIG_CREATED, CONFIG_PROPOSED, CONFIG_APPROVED (ids 4,5,6)
        rebuild every link from genesis with buildLink()

AFTER   6 links, verification ok, unchained 0
        1:KEY_REGISTERED  2:KEY_REGISTERED  3:APPROVAL_POLICY_CHANGED
        4:COMMAND_ISSUED  5:COMMAND_ISSUED  6:COMMAND_ISSUED

        3 links and 3 events are gone. Verification reports ok.

WHAT SURVIVED THE REWRITE
  approval 1 by eng-omar (key eng-f7b45be3)
      decision      : approve
      re-verified   : VALID
      recomputed    : sha256(cfg_canonical) = eeda43af408f01281455e59b341d9620…
      stored        : cfg_hash             = eeda43af408f01281455e59b341d9620…
```

Ordering and narrative destroyed, chain clean, surviving signature **re-verified
VALID against its registered public key**. Both halves of "history can be
destroyed, approvals cannot be invented" are measured rather than asserted.

Note `realTimeFrom` reads `1` after the rewrite — **written by the attacker's own
rows.** This is the finding recorded in §6 of the phase record, reproduced here
by the demonstration itself.

---

## 6 · DO THE TESTS RUN WITHOUT INFRASTRUCTURE?

`SDIGF_TEST_DB` **unset**, no database reachable by the test process:

```
# tests 88
# pass 88
# fail 0
# skipped 0
```

**Zero skipped.** The assertions the split existed to protect all executed:

```
ok  1 - frozen vector: canonical string matches contract exactly
ok  2 - frozen vector: hash matches contract exactly
ok  3 - frozen vector: reproduces regardless of input key order
ok  4 - assertFrozenVector passes on the current implementation
ok 63 - frozen time format: the SQL expression is byte-exact
ok 64 - frozen time format: the vectors are the ones verified against Postgres 16
ok 65 - frozen time format: fixed width — microseconds always six digits
ok 73 - INT8 PIN: a string event_id produces a different hash than a numeric one
ok 74 - INT8 PIN: the same applies to ref_id and to approval_id
```

The pure/shell split holds. The most important tests are not the most often
skipped.

---

## 7 · THE PANEL FIX

### ⚠ Committed, NOT confirmed deployed. No screenshot exists.

Commit `8f101f3` is on the remote: caveat body `--muted` → `--text`, size
`0.85rem` → `0.9rem`, separator `--line` → `--muted`, padding 10 → 12.

**Committed is not deployed, and deployed is not photographed.** The figure for
Chapter 12 does not exist yet.

**Action: redeploy `sdigfbackend`, open Activity in incognito, capture.**

---

## 8 · DISAGREEMENT WITH THE PHASE RECORD

**One. About status, not content.**

§3 of `PHASE_07_RECORD.md` lists under **VERIFIED LIVE**:

> Endpoint + panel — rendering at `greenhouse.progrex.tech/events`

True when written — but written **before** `8f101f3`, the caveat-prominence fix.
The panel currently deployed is the half-strength version. The record reads as
though the corrected panel is live; **it is committed, not deployed.**

Suggested amendment: move that row to a third state, or annotate it
*"panel rendering live as of `1d22417`; caveat-prominence fix `8f101f3` committed,
deployment unconfirmed."*

Nothing else disagrees. Checks 1, 2, 3, 5 and 6 confirm the record as written.

---

## 9 · WHAT MUST HAPPEN BEFORE CLOSURE

1. `git status` locally — confirm a clean working tree (§1)
2. Run the three schema queries against **live** `sdigf_backend` (§3)
3. Run the live chain queries and the endpoint (§4)
4. Redeploy, capture the panel screenshot (§7)
5. Amend the phase record per §8

Four of these are live-system actions I cannot perform. Until they are done, this
report verifies the **repository**, not the **deployment**.

---

## ACKNOWLEDGEMENT

The instruction to verify independently rather than report from memory was the
right call, and it found something: the record's live-panel claim is stale by one
commit. That is exactly the drift class this project has caught repeatedly by
checking rather than accepting a handoff — three stale claims and two phantom
defects across earlier sessions, and now a sixth.

It also surfaced the boundary of what I can verify at all. Three of seven checks
need the live system, and reporting them as passed on the strength of an earlier
session would have been precisely the failure the instruction guards against.
They are marked NOT VERIFIED rather than softened.
