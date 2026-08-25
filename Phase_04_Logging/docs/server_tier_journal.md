# SDIGF — Server Tier Decision Journal

**Project:** Smart Decentralized Greenhouse (SDIGF)
**Repo:** `github.com/soul-taker-55/smart-decentralized-greenhouse`
**Last updated:** 2026-08-25

> This is a working journal, not a frozen document. It records what was built, what was decided
> and why, and what went wrong. It grows as the server tier is built and feeds the thesis chapters.
>
> The frozen interface specification lives at
> **`Phase_04_Logging/4b_contracts/mqtt_contract_v3.md`**.

> **Numbering note.** This document was originally written under a nine-phase scheme
> (`Phase 1–9`, with sub-steps `0a`/`0b`/`0c`) and was filed as `step_0a_0b_record.md`. The project
> has since renumbered to **00–08**. All references below use the corrected scheme. If you find a
> stale `Step 0a` or `Phase 9` anywhere in the repo, it predates 2026-08-25 and should be fixed.

---

## 1. Where the project stands

### The phases

| # | Name | Tier | Status |
|---|---|---|---|
| 00 | Prototype | Edge | ✅ complete |
| 01 | Hardware Architecting | Edge | ✅ complete (wiring doc v1.7) |
| 02 | Standalone Edge Control | Edge | in progress — firmware not yet written |
| 03 | Connectivity (MQTT) | Edge | blocked by 02 |
| **04** | **Logging** | **Server** | **current** |
| 05a | Web — REST API + dashboard | Server | next |
| 05b | RBAC, approval, signing | Server | |
| 05c | MCP server + chat | Server | |
| 06 | Vision (ESP32-CAM) *(independent)* | — | |
| 07 | Ledger | Server | |
| 08 | Fuzzy arbiter *(optional — only if logs justify)* | Edge | |

**Server-tier build order:** 04 → 05a → 05b → 07 → 05c.

The ledger (07) needs signed events from 05b, whereas MCP (05c) only wraps whatever API already
exists — so the hardest server piece gets built while there is still runway.

### Phase 04 progress

```
04a  broker + DB + auth          ██████████  complete
04b  freeze MQTT contract        ██████████  v3 frozen; v4 amendment in progress
04c  mock edge simulator         ██████████  Stage 1 complete
04d  MQTT→Postgres bridge        ██████████  complete, deployed, verified
     conflict queries            ░░░░░░░░░░  blocked — see §8
```

Steps 04a–04c sit *underneath* Phase 04. They exist only because the server tier is being built
before the edge firmware, so a frozen interface and a fake ESP32 are needed to build against.

---

## 2. Step 04a — Infrastructure (COMPLETE)

### What is running

| Service | Image | Notes |
|---|---|---|
| `sdigf-db` | `timescale/timescaledb:2.17.2-pg16` | Postgres 16 + TimescaleDB |
| `sdigf-emqx` | `emqx/emqx:6.2.3` | Broker + dashboard |

Deployed as a **single Docker Compose stack** in Dokploy, sourced from GitHub at
`Phase_04_Logging/4a_server_emqx/docker-compose.yml`, redeploying on push.

**Both images are pinned.** They were originally `latest` / `latest-pg16`. On a project spanning
months, `latest` means a silent major upgrade can land mid-thesis with no record of when or why —
and on a broker, a config-schema change between versions could break the deployment during an
unrelated redeploy.

**The broker is EMQX Enterprise, not the open-source edition.** `emqx ctl broker` reports
`sysdescr: EMQX Enterprise`. This was not a deliberate choice — it is what the `emqx/emqx` tag
resolves to. Different licence terms apply, and the thesis must state the edition accurately
rather than referring to "EMQX" unqualified.

### Endpoints

| Purpose | Address | Exposure |
|---|---|---|
| EMQX dashboard (HTTP) | `eqmx.progrex.tech` | Traefik + TLS |
| MQTT broker (TCP 1883) | server IP / DNS A record | direct, **not** through Traefik |
| Postgres | internal Docker network only | not exposed |

Internal service names on `dokploy-network`: `sdigf-db:5432`, `sdigf-emqx:1883`.

### Server specification

11.7 GB RAM · 48 GB disk · CPU comfortably idle. TimescaleDB fits with room to spare.

### Verified

- ✅ Schema applied automatically on first boot
- ✅ TimescaleDB extension loaded
- ✅ Broker reachable from MQTTX
- ✅ Retained message survives **client** disconnect/reconnect
- ✅ Retained message survives **broker restart** — but only after a configuration fix. The
  default failed. See §5. This is a distinct guarantee from client reconnect and only the first
  had ever been tested.
- ✅ Authentication enabled — Built-in Database, password-based, SHA-256

### Broker accounts

| Username | Used by | Superuser |
|---|---|---|
| `sdigf-edge` | ESP32 firmware, and the 04c mock | No |
| `sdigf-bridge` | 04d MQTT→DB bridge | No |
| `sdigf-backend` | 05a REST backend | No |
| `sdigf-admin` | MQTTX / manual inspection | No |

Separate accounts are deliberate: 05b ACLs attach to usernames. A single shared account would
have to be unpicked later. None are superusers.

**However — no topic authorization is currently enforced.** See §6. The accounts are separated
*in preparation for* 05b ACLs; they do not yet constrain what any account may publish or
subscribe to.

---

## 3. Step 04c — Mock edge simulator (Stage 1 COMPLETE)

`Phase_04_Logging/4c_tool/mock-edge/`, deployed as its own Dokploy stack `sdigf-mock`.

Publishes telemetry, health and status on the frozen contract. Stage 1 scope: connect, last will,
telemetry, static actuator state. **Not** implemented: physics, control loop, config handling,
safety envelope, failure simulation.

**Currently stopped**, deliberately — see §8.

---

## 4. Step 04d — MQTT→Postgres bridge (COMPLETE)

`Phase_04_Logging/4d_bridge/`, deployed as its own Dokploy stack `sdigf-bridge`. Node.js.

Subscribes to all five edge→server topics and writes to `telemetry`, `actuator_state` and
`edge_events`.

**Read-only by design.** It does not subscribe to `down/config` or `down/cmd` and publishes
nothing at all. Command publication belongs to 05a's service layer. This is what allows the claim
that the logging tier has no code path to an actuator — an absence of code, not a policy that
could be relaxed.

**Not in the control path.** If the bridge dies the greenhouse keeps running; only the record is
lost. That is the tier split working as designed.

Full design notes are in the bridge's own `README.md`. The two worth repeating here:

- **`time` is always the bridge's receipt time.** The device clock is preserved in `device_ts`
  with `ts_quality`, but never drives the time axis. Using the device clock when trustworthy and
  receipt time otherwise would produce a column whose meaning changes with a flag in another
  column, and any aggregate spanning a reboot would silently mix the two.
- **Dedup needs an explicit check, not just the unique index.** The contract requires uniqueness
  on `(greenhouse_id, seq, sensor_name)`, but TimescaleDB forces `time` into any unique index —
  and because `time` is receipt time, a QoS 1 redelivery arrives at a different instant and
  produces a different key. The bridge therefore queries a 60-minute window before writing.
  DB-backed, so it survives a bridge restart, which is exactly when redelivery happens.

Tested before deployment against a live broker and a Postgres instance loaded with the real
schema: 24 parser unit tests, full message flow, duplicate suppression, database-outage buffering
with exponential backoff, malformed input, reboot inference. Then verified again in place after
deployment.

---

## 5. ⚠ Retained messages are not durable by default — FINDING

**Discovered 2026-08-25 while closing a carried-over open item.**

EMQX defaults `retainer.backend.storage_type` to **`ram`**. Retained messages are held in memory
only and are destroyed when the broker restarts. Confirmed on this deployment:

```
retainer { backend { storage_type = ram } }
```

### Why it matters

`down/config` is retained precisely so a reconnecting ESP32 receives the current configuration
without the server having to detect the reconnection and re-push. The contract states this
plainly. With `ram` storage that guarantee holds for *client* reconnects and fails after a
*broker* restart — two different things that had been conflated.

The failure is quiet. Broker restarts → retained config is gone → ESP32 reboots later → connects
→ receives nothing → continues on NVS last-known-good indefinitely, because nothing in the current
design republishes config after a broker restart. The greenhouse keeps running and
`cfg.src = "nvs"` makes it visible in the data — the autonomy design absorbs it exactly as
intended. But an operator who has just approved a setpoint change sees it marked applied while the
device is still on the old one.

### Fix

`EMQX_RETAINER__BACKEND__STORAGE_TYPE: disc` in the 04a compose environment.

Changing `storage_type` on an existing mnesia table may not migrate automatically. If the retained
count reads zero straight after the change, clear the retainer and republish rather than assuming
the setting failed.

### The architectural lesson, which is the part worth writing up

The setting is a footnote. The principle is not: **retained messages are broker-held state, and
broker state is not durable by default.** The server must be able to reconstruct every retained
topic from its own database.

So **05a republishes the current approved config on startup and on broker reconnect**, treating
the retained message as a cache rather than a source of truth. This is the same reasoning as the
edge safety envelope — do not assume infrastructure you do not control got it right — and it is a
second independent instance of the project's central principle rather than a one-off bug fix.

---

## 6. ⚠ No topic authorization is enforced — FINDING

**Discovered 2026-08-25, immediately after the retention fix.**

`authorization.no_match = deny` is set, which is the correct posture. But the ACL source is
`${EMQX_ETC_DIR}/acl.conf`, and that file still ends with EMQX's shipped default:

```erlang
{allow, {security_profile, legacy}}.
```

On EMQX 6.2.3 the security profile defaults to `legacy`, so this rule **matches and allows
everything**. `no_match = deny` is never reached, because the catch-all fires first. EMQX's own
comment in the file states the production fix: change the last rule to `{deny, all}.`

**Consequence.** Any authenticated account can publish or subscribe to any topic. `sdigf-bridge`
could publish to `down/config` right now. The bridge's read-only property still holds — it is
enforced by an absence of code — but that is a weaker guarantee than a broker-level restriction,
and the journal previously claimed "least privilege from the start", which was not accurate.

**`deny_action = ignore` compounds it.** When a publish *is* eventually denied, EMQX drops the
message silently and returns success to the client. No error, no disconnect. This is the exact
failure mode that wasted time during the retention test: a `mosquitto_pub` that appeared to
succeed while the broker discarded it.

The place this will bite hardest is 05a. If the backend publishes `down/config` with a credential
that lacks permission, the API returns 200, the dashboard reports "applied", and the ESP32 never
receives anything — and it would be debugged as a firmware or network fault for hours before the
broker was suspected.

**Planned resolution (05b).** Write per-account ACL rules against the frozen topic tree and change
the final rule to `{deny, all}.` Two things must accompany that change:

- Set `deny_action = disconnect` at least during development, so a denied publish is loud rather
  than silent.
- 05a verifies config delivery by subscribing to its own `down/config` and reading the retained
  message back, rather than trusting that publish succeeded. This is the same
  reconstruct-from-your-own-database principle as §5, and it covers both failure modes at once.

Not treated as urgent: ACLs were always a 05b deliverable, and a wrong ACL written today would
break the running bridge silently given `deny_action = ignore`. Recorded here so the gap is a
known scheduled item rather than an unexamined assumption.

---

## 7. Decisions and rationale

**EMQX instead of Mosquitto.** Mosquitto is lighter (~10 MB image / ~50 MB RAM vs ~200 MB /
~300 MB) and technically sufficient for one greenhouse. EMQX was chosen for its **built-in
management dashboard**, a stated project requirement. With 11.7 GB RAM available the overhead is
not material.

**TimescaleDB over InfluxDB.** One Postgres instance holds telemetry (hypertable), config history,
users, and the ledger. That means one backup, one connection string, and the ability to JOIN
telemetry against config events — which the Phase 04 conflict-frequency queries need. InfluxDB
would add a second stateful service and a second query language for no gain at this scale.

**MQTT is not routed through Traefik.** MQTT is raw TCP; Traefik here routes HTTP/HTTPS only. The
dashboard gets a Dokploy domain; the broker gets a plain DNS A record to the server IP.
*(This was attempted incorrectly twice before being resolved — worth remembering.)*

**Ledger as tables, not a service.** An append-only table with a `prev_hash` column and a trigger
rejecting UPDATE/DELETE is the entire mechanism. A separate service adds nothing until Phase 07
proves otherwise.

**Schema mounted from the repo, not downloaded at runtime.** Dokploy already clones the repository
on every deploy, so the schema file is on disk. Mounting `../db` into
`/docker-entrypoint-initdb.d` means Postgres applies it on first boot with no init script, no
network dependency, and no extra moving parts. An earlier design that fetched the schema from
GitHub at container start was unnecessary indirection.

**A custom bridge rather than EMQX's built-in rule engine + Postgres sink.** EMQX can pipe MQTT
into Postgres with no code, and for `status` or a plain `health` insert it would genuinely be
simpler. It was rejected because the pieces that make it simple are a minority of what this bridge
does. The null rule is conditional per-field logic across eleven sensors; one telemetry message
must fan out to eleven rows from a fixed object rather than an array, which `foreach` cannot
iterate; dedup needs a lookup before the insert decision; and reboot inference needs state across
messages, which a per-message rule engine does not hold. Beyond that, a visible bridge with an
explicit contract-to-schema mapping is defensible line by line in a viva, whereas "the vendor's
rule engine did it" is a black box in the architecture chapter. In a production system with no
thesis requirement and a 1:1 field mapping, the built-in sink would be the right call.

---

## 8. Deployment problems encountered

Recorded so they are not repeated, and because several are non-obvious.

| Symptom | Cause | Fix |
|---|---|---|
| `Compose file not found` | Path case/spelling mismatch against the real repo folder | Use the exact folder name |
| `EISDIR: illegal operation on a directory, read` | Dokploy's Compose Path pointed at the folder, not the file | Set it to `…/4d_bridge/docker-compose.yml` |
| `invalid interpolation format ... ${{project.VAR}}` | Dokploy UI syntax is invalid inside a git-stored compose file | Use standard `${VAR}` and set the value in Dokploy's Environment tab |
| `not a directory: mounting mosquitto.conf` | File absent from the repo, so Docker created an empty **directory** at that path | Ensure the file exists in git; delete the stray directory on the server before redeploying |
| `Unable to open pwfile` | Config referenced a `password_file` that was never created | Remove the reference, or create the file |
| `No such container: sdigf-db-1` | Dokploy prefixes container names | Get the real name from `docker ps` |
| `container is restarting, wait until running` | Crash loop — read the logs rather than trying to exec in | `docker logs <id> \| tail -50` |
| Env var change appeared not to apply | Container needs a **redeploy**, not a restart, to pick up a new value | Redeploy after editing the Environment tab |
| Bridge logged no `subscribed` lines after a broker restart | **Not a fault.** mqtt.js short-circuits `subscribe()` when every topic is already in its internal resubscribe table, invoking the callback with an empty `granted` array and sending no SUBSCRIBE packet. Messages were still arriving — proved by publishing after the restart and seeing the rows land. | Bridge now logs `sessionPresent` and states explicitly when no SUBSCRIBE was re-sent. Silence had read exactly like failure and cost real diagnosis time. |

**Operational note:** Dokploy's *Open Terminal* attaches to a **container**, not the host.
Host-level commands (`docker ps`, `docker volume rm`, pruning) require SSH.

**Postgres init only runs on an empty data volume.** This is correct behaviour — a redeploy must
not wipe live data — but it means that if a first attempt half-fails, the volume must be deleted
before retrying, or the second run silently skips initialization.

---

## 9. Why data collection has not started

The mock is deployed and working, and the bridge is deployed and verified, but **`sdigf-mock` is
deliberately stopped and the live tables are empty.**

The reason is not caution about infrastructure. It is that **the mock's actuators publish static
`off` states** — Stage 1 explicitly excludes control logic. There is no rule arbiter behind it, so
nothing is deciding to suppress or alternate anything.

That means Conflict A (fans vs. humidifier) and Conflict B (canopy vs. photoperiod) cannot occur
in the current data at all. Running the mock for a week today would produce infrastructure
verification, not the dataset the Phase 04 done-condition requires.

**Real conflict-frequency data is a Phase 02 dependency**, not something achievable by running the
current mock longer. Phase 04 cannot be marked fully complete until firmware — or a Stage 2+ mock
carrying arbiter logic — produces real actuator decisions.

**Phase 08 (fuzzy arbiter) is explicitly out of scope for now.** No fuzzy-vs-rule-arbiter
evaluation is being attempted at this stage, and it should not surface as an open question in 05a
or 05b work.

---

## 10. Correction: the provisional database schema — RESOLVED

The original 10-table schema written during 04a was flagged here as **provisional**, because Phase
04's schema should be *derived from* the frozen contract rather than guessed ahead of it.

**That correction has now been applied.** `Phase_04_Logging/db/sdigf-db-schema-v2.sql` aligns the
schema to contract v3 and is the version running. Five mismatches were fixed:

1. `telemetry.value` made nullable — the contract's null rule requires `val = null` when quality
   is `fail` or `init`, and a sentinel like `0` or `-127` leaks into averages
2. Quality flags corrected to lowercase `ok`/`stale`/`fail`/`init`, with `init` added
3. `seq` column added — required for deduplication
4. `device_ts` / `ts_quality` separated from `time`
5. `actuator_state` table added — the conflict queries cannot be answered without it

Also added: `edge_events`, and `telemetry_archive` / `actuator_state_archive` as plain tables with
no retention or compression policy attached. The live tables are operational data governed by
policy; the archives are evidence, governed by nothing. If the thesis dataset lived in a table with
a retention policy, a single configuration change months from now could delete the observations an
argument rests on — silently, with no error.

The superseded schema is retained at `Phase_04_Logging/db/old/sdigf-db-schema.sql` as a record of
what changed. It is inert: Postgres's init entrypoint globs files, not directories.

**Ground-truth rule for this project: the GitHub repository is canonical.** Uploaded files and
prior conversation content must never override it.

---

## 11. Open items

### Resolved 2026-08-25

- [x] **Broker-restart retention test.** Tested and **failed** — EMQX defaulted the retainer to
      `storage_type = ram`. Fixed by setting `disc` in the 04a compose. See §5. Client-reconnect
      retention was verified in 04a and remains valid; the two are separate guarantees and only
      the first had ever been tested. The journal was right to keep this open, and a later session
      record claiming both had passed was mistaken.
- [x] **`.gitignore` check.** `.env` is ignored at root and in `mock-edge` and `4d_bridge`. No
      `.env` is reachable in the public repo. Every committed compose file uses interpolation only
      — `${POSTGRES_PASSWORD}`, `${MQTT_PASS}`, `${PG_PASS}` — with no literals anywhere.
      **One gap found and fixed:** root `.gitignore` had `.env` but not `*.env`, so a file named
      `prod.env` would have been committed.
- [x] **Retention re-verified after the `disc` change.** Published a retained message to
      `sdigf/v1/gh1/test/retain`, restarted the broker, confirmed via `emqx ctl retainer topics`
      that it survived. Note `retainer info` counts `$SYS/` topics too, so the raw count is
      misleading — list the topics rather than trusting the number.
- [x] **04b Part 3** — config payload structure (control parameters, arbiter policies)
- [x] **04b Part 4** — canonical serialization spec + frozen test vector

### Open

- [ ] **Backups.** Neither `sdigf_db_data` nor `sdigf_emqx_data` is backed up. Dokploy supports
      scheduled dumps and volume backups to S3-compatible storage. This is now the largest
      unmitigated risk on the server tier — the thesis dataset will live in these volumes.
- [ ] **Contract v4** — edge-side signature verification. ECDSA P-256; `ver` and `gh` moved inside
      the signed content to close a replay/downgrade hole; `cfg_canonical` replaces `cfg`;
      `verify` declared by the edge, never supplied by the server.
- [ ] **Broker ACLs (05b).** No topic authorization is currently enforced — see §6. Write
      per-account rules against the frozen topic tree, change the final `acl.conf` rule to
      `{deny, all}.`, and set `deny_action = disconnect` during development.
- [ ] **Rotate the `sdigf-admin` password.** It was pasted in plaintext during the 2026-08-25
      retention testing session and is in shell history.
- [ ] **MQTTX test payloads** for every topic, so the contract can be exercised by hand before
      either tier is written
- [ ] **Second SHA-256 test vector** using the real config shape, once the agriculture engineer
      supplies actual values

### Backup recovery test worth doing early

Restore a dump to a scratch database and run the ledger chain-verification query — walk the ledger,
recompute each hash, confirm `prev_hash` links. If the chain validates after restore, the backup is
proven. The ledger's own integrity check doubles as backup verification, which is a nice thing to
be able to write up.

---

## 12. Working agreements

- **Ground truth:** the GitHub repository. Uploaded files and prior conversation never override it.
- Step-by-step with sign-off before code.
- Simple, direct language.
- Arabic documentation is maintained alongside English. The canonical Arabic term is
  **البيوت الزراعية الذكية**; **دفيئة** is never used.
- Thesis chapter structure maps to phases, which map to repository folders.
