# SDIGF — Server Tier Decision Journal

**Project:** Smart Decentralized Greenhouse (SDIGF)
**Repo:** `github.com/soul-taker-55/smart-decentralized-greenhouse`
**Last updated:** 2026-08-24

> This is a working journal, not a frozen document. It records what was built, what was decided
> and why, and what went wrong. It grows as the server tier is built and feeds the thesis chapters.
>
> The frozen interface specification lives separately at **`Contracts/mqtt_contract_v1.md`**.

---

## 1. Where the project stands

### The nine phases

| # | Name | Tier | Status |
|---|---|---|---|
| 1 | Wiring & bring-up | Edge | ✅ complete (wiring doc v1.7) |
| 2 | Standalone edge control | Edge | not started |
| 3 | Connectivity (MQTT) | Edge | not started |
| **4** | **Data & logging** | **Server** | **current** |
| 5a | Backend & dashboard | Server | |
| 5b | MCP server & chat | Server | |
| 6 | Access control, approval & signing | Server | |
| 7 | Fuzzy arbiter *(optional — only if logs justify)* | Edge | |
| 8 | Vision *(independent, any time after Phase 3)* | Server | |
| 9 | Ledger *(last)* | Server | |

Original dependency order: 1 → 2 → 3 → 4 → 5a → 5b → 6 → 7 → 9.

**Revised server-tier order:** 4 → 5a → 6 → 9 → 5b. The ledger needs signed events from Phase 6,
whereas MCP only wraps whatever API already exists — so the hardest server piece gets built
while there is still runway.

### Server-tier prep progress

```
0a  broker + DB + auth          ██████████  complete
0b  freeze MQTT contract        █████░░░░░  Parts 1–2 done
0c  mock edge simulator         ░░░░░░░░░░
4   DB + bridge + queries       ░░░░░░░░░░
```

Steps 0a–0c sit *underneath* Phase 4. They exist only because the server tier is being built
before the edge firmware, so a frozen interface and a fake ESP32 are needed to build against.

---

## 2. Step 0a — Infrastructure (COMPLETE)

### What is running

| Service | Image | Notes |
|---|---|---|
| `sdigf-db` | `timescale/timescaledb:latest-pg16` | Postgres 16 + TimescaleDB |
| `sdigf-emqx` | `emqx/emqx:latest` | v6.2.3, broker + dashboard |

Deployed as a **single Docker Compose stack** in Dokploy, sourced from GitHub at
`Phase_04_Logging/server/docker-compose.yml`, redeploying on push.

### Endpoints

| Purpose | Address | Exposure |
|---|---|---|
| EMQX dashboard (HTTP) | `eqmx.progrex.tech` | Traefik + TLS |
| MQTT broker (TCP 1883) | server IP / DNS A record | direct, **not** through Traefik |
| Postgres | internal Docker network only | not exposed |

### Server specification

11.7 GB RAM · 48 GB disk · CPU comfortably idle. TimescaleDB fits with room to spare.

### Verified

- ✅ Schema applied automatically on first boot — 10 tables
- ✅ TimescaleDB extension loaded
- ✅ Broker reachable from MQTTX
- ✅ **Retained message survives client disconnect/reconnect** (confirmed by the `Retained`
  badge in MQTTX). This is the behaviour the entire edge-reconnect design rests on.
- ✅ Authentication enabled — Built-in Database, password-based, SHA-256

### Broker accounts

| Username | Used by | Superuser |
|---|---|---|
| `sdigf-edge` | ESP32 firmware, and the Step 0c mock | No |
| `sdigf-bridge` | Phase 4 MQTT→DB bridge | No |
| `sdigf-backend` | Phase 5a REST backend | No |
| `sdigf-admin` | MQTTX / manual inspection | No |

Separate accounts are deliberate: Phase 6 ACLs attach to usernames. A single shared account
would have to be unpicked later. None are superusers — least privilege from the start.

---

## 3. Decisions and rationale

**EMQX instead of Mosquitto.** Mosquitto is lighter (~10 MB image / ~50 MB RAM vs ~200 MB /
~300 MB) and technically sufficient for one greenhouse. EMQX was chosen for its **built-in
management dashboard**, a stated project requirement. With 11.7 GB RAM available the overhead is
not material.

**TimescaleDB over InfluxDB.** One Postgres instance holds telemetry (hypertable), config
history, users, and the ledger. That means one backup, one connection string, and the ability to
JOIN telemetry against config events — which the Phase 4 conflict-frequency queries need.
InfluxDB would add a second stateful service and a second query language for no gain at this scale.

**MQTT is not routed through Traefik.** MQTT is raw TCP; Traefik here routes HTTP/HTTPS only.
The dashboard gets a Dokploy domain; the broker gets a plain DNS A record to the server IP.
*(This was attempted incorrectly twice before being resolved — worth remembering.)*

**Ledger as tables, not a service.** An append-only table with a `prev_hash` column and a trigger
rejecting UPDATE/DELETE is the entire mechanism. A separate service adds nothing until Phase 9
proves otherwise.

**Schema mounted from the repo, not downloaded at runtime.** Dokploy already clones the
repository on every deploy, so the schema file is on disk. Mounting `../db` into
`/docker-entrypoint-initdb.d` means Postgres applies it on first boot with no init script, no
network dependency, and no extra moving parts. An earlier design that fetched the schema from
GitHub at container start was unnecessary indirection.

**Contract documentation lives outside the phase tree.** The MQTT contract is built against by
Phase 3 firmware, Phase 4 bridge, Phase 5a backend, and the Step 0c mock. Filing it under
`Phase_04_Logging/` would force the firmware work to reach into a server phase for its own
interface spec. It sits in `Contracts/` instead, alongside the existing cross-cutting folders.

---

## 4. ⚠ Correction: the provisional database schema

A 10-table schema was written and applied to `sdigf_db` during Step 0a. **This was premature.**

Phase 4's schema should be *derived from* the frozen MQTT contract — field names, types, and
quality semantics all come from Step 0b. The applied tables are a reasonable skeleton but are
**provisional**. Expect column renames and type changes once contract Parts 3 and 4 are settled.

Ground-truth rule for this project: **the GitHub repository is canonical.** Uploaded files and
prior conversation content must never override it.

---

## 5. Deployment problems encountered

Recorded so they are not repeated, and because several are non-obvious.

| Symptom | Cause | Fix |
|---|---|---|
| `Compose file not found` | Path case/spelling mismatch against the real repo folder | Use the exact folder name: `Phase_04_Logging/server/docker-compose.yml` |
| `invalid interpolation format ... ${{project.VAR}}` | Dokploy UI syntax is invalid inside a git-stored compose file | Use standard `${VAR}` and set the value in Dokploy's Environment tab |
| `not a directory: mounting mosquitto.conf` | File absent from the repo, so Docker created an empty **directory** at that path | Ensure the file exists in git; delete the stray directory on the server before redeploying |
| `Unable to open pwfile` | Config referenced a `password_file` that was never created | Remove the reference, or create the file |
| `No such container: sdigf-db-1` | Dokploy prefixes container names | Get the real name from `docker ps` |
| `container is restarting, wait until running` | Crash loop — read the logs rather than trying to exec in | `docker logs <id> \| tail -50` |

**Operational note:** Dokploy's *Open Terminal* attaches to a **container**, not the host.
Host-level commands (`docker ps`, `docker volume rm`, pruning) require SSH.

**Postgres init only runs on an empty data volume.** This is correct behaviour — a redeploy must
not wipe live data — but it means that if a first attempt half-fails, the volume must be deleted
before retrying, or the second run silently skips initialization.

---

## 6. Server cleanup performed

Disk went from **29 GB → 19 GB used** (64% → 40%):

- 2.7 GB of archived systemd journals vacuumed
- ~7.2 GB of unused Docker images removed (old Dokploy version, EMQX leftover, dangling layers)
- Retired projects removed: exam-generator, hospital-management, osticket

Docker log rotation applied (`max-size 10m`, `max-file 3`) to prevent recurrence.

---

## 7. Open items

### Carried over from Step 0a

- [ ] **Broker-restart retention test.** What was verified is *client* reconnect. Restarting the
      broker container and confirming a retained message survives is a different guarantee — and
      it is the one the edge design actually depends on. **Do this before Phase 3.**
- [ ] **Backups.** Neither `sdigf_db_data` nor `sdigf_emqx_data` is backed up yet. Dokploy
      supports scheduled dumps and volume backups to S3-compatible storage.
- [ ] **`.gitignore` check.** Confirm `.env` and `*.env` are ignored. The compose file references
      `${POSTGRES_PASSWORD}`; one accidental commit puts the database password in permanent git
      history.

### Step 0b remaining

- [ ] **Part 3** — config payload structure (control parameters, arbiter policies)
- [ ] **Part 4** — canonical serialization spec + fixed test vector
- [ ] MQTTX test payloads for every topic, so the contract can be exercised by hand before either
      tier is written

### Backup recovery test worth doing early

Restore a dump to a scratch database and run the ledger chain-verification query — walk the
ledger, recompute each hash, confirm `prev_hash` links. If the chain validates after restore, the
backup is proven. The ledger's own integrity check doubles as backup verification, which is a
nice thing to be able to write up.

---

## 8. Working agreements

- **Ground truth:** the GitHub repository. Uploaded files and prior conversation never override it.
- Step-by-step with sign-off before code.
- Simple, direct language.
- Arabic documentation is maintained alongside English. The canonical Arabic term is
  **البيوت الزراعية الذكية**; **دفيئة** is never used.
- Thesis chapter structure maps to phases, which map to repository folders.
