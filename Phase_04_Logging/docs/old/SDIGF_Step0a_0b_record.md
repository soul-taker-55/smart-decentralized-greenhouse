# SDIGF — Server Tier: Step 0a & 0b Record

**Project:** Smart Decentralized Greenhouse (SDIGF)
**Repo:** `github.com/soul-taker-55/smart-decentralized-greenhouse`
**Document date:** 2026-08-24
**Covers:** Step 0a (infrastructure) — COMPLETE · Step 0b (MQTT contract) — Parts 1–2 of 4

> **Purpose of this document.** It is both a decision record and the draft frozen contract.
> Where a choice was made, the reasoning is recorded alongside it, because the reasoning is
> what makes the choice reviewable later. Sections marked **OPEN** are not yet decided.

---

## 0. Where the project stands

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
**Revised server-tier order:** 4 → 5a → 6 → 9 → 5b. The ledger needs signed events from
Phase 6, whereas MCP only wraps whatever API already exists — so the hardest server piece
gets built while there is still runway.

### Server-tier prep progress

```
0a  broker + DB + auth          ██████████  complete
0b  freeze MQTT contract        █████░░░░░  Parts 1–2 of 4 done
0c  mock edge simulator         ░░░░░░░░░░
4   DB + bridge + queries       ░░░░░░░░░░
```

Steps 0a–0c sit *underneath* Phase 4. They exist only because the server tier is being built
before the edge firmware, so a frozen interface and a fake ESP32 are needed to build against.

---

## 1. Step 0a — Infrastructure (COMPLETE)

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

### Verified

- ✅ Schema applied automatically on first boot — 10 tables
- ✅ TimescaleDB extension loaded
- ✅ Broker reachable from MQTTX
- ✅ **Retained message survives client disconnect/reconnect** (confirmed by the `Retained`
  badge in MQTTX). This is the single behaviour the entire edge-reconnect design rests on.
- ✅ Authentication enabled — Built-in Database, password-based, SHA-256

### Broker accounts

| Username | Used by | Superuser |
|---|---|---|
| `sdigf-edge` | ESP32 firmware, and the Step 0c mock | No |
| `sdigf-bridge` | Phase 4 MQTT→DB bridge | No |
| `sdigf-backend` | Phase 5a REST backend | No |
| `sdigf-admin` | MQTTX / manual inspection | No |

Separate accounts are deliberate: Phase 6 ACLs attach to usernames. A single shared account
would have to be unpicked later.

### Decisions made, and why

**EMQX instead of Mosquitto.** Mosquitto is lighter (~10 MB / ~50 MB RAM vs ~200 MB / ~300 MB)
and technically sufficient for one greenhouse. EMQX was chosen for its **built-in management
dashboard** — a requirement stated by the project owner. The server has 11.7 GB RAM, so the
overhead is not material.

**TimescaleDB over InfluxDB.** One Postgres instance holds telemetry (hypertable), config
history, users, and the ledger. That means one backup, one connection string, and the ability
to JOIN telemetry against config events — which the Phase 4 conflict-frequency queries need.
InfluxDB would add a second stateful service and a second query language for no gain at this
scale.

**MQTT is not routed through Traefik.** MQTT is raw TCP; Traefik in this setup routes
HTTP/HTTPS. The dashboard gets a Dokploy domain; the broker gets a plain DNS A record to the
server IP. *(This was attempted incorrectly twice before being resolved.)*

**Ledger as tables, not a service.** An append-only table with a `prev_hash` column and a
trigger rejecting UPDATE/DELETE is the entire mechanism. A separate service adds nothing until
Phase 9 proves otherwise.

### Deployment problems encountered (recorded so they are not repeated)

| Symptom | Cause | Fix |
|---|---|---|
| `Compose file not found` | Path case/spelling mismatch against the real repo folder | Use the exact folder name: `Phase_04_Logging/server/docker-compose.yml` |
| `invalid interpolation format ... ${{project.VAR}}` | Dokploy UI syntax is invalid inside a git-stored compose file | Use standard `${VAR}` and set the value in Dokploy's Environment tab |
| `not a directory: mounting mosquitto.conf` | File absent from the repo, so Docker created an empty **directory** at that path | Ensure the file exists in git; delete the stray directory on the server before redeploying |
| `Unable to open pwfile` | Config referenced a `password_file` that was never created | Remove the reference, or create the file |
| `No such container: sdigf-db-1` | Dokploy prefixes container names | Get the real name from `docker ps` |

**Operational note:** Dokploy's *Open Terminal* attaches to a **container**, not the host.
Host-level commands (`docker ps`, `docker volume rm`, pruning) require SSH.

### Server cleanup performed

Disk went from **29 GB → 19 GB used** (64% → 40%):
- 2.7 GB of archived systemd journals vacuumed
- ~7.2 GB of unused Docker images removed (old Dokploy version, EMQX leftover, dangling layers)
- Retired projects removed: exam-generator, hospital-management, osticket

Docker log rotation was applied (`max-size 10m`, `max-file 3`) to prevent recurrence.

### ⚠ Outstanding from Step 0a

- **Broker-restart retention was never tested.** What was verified is *client* reconnect.
  Restarting the broker container and confirming a retained message survives is a different
  guarantee, and it is the one the edge design actually depends on. **Do this before Phase 3.**
- **Volume and database backups are not yet configured** (`sdigf_db_data`, `sdigf_emqx_data`).

---

## 2. ⚠ Correction: the provisional database schema

A 10-table schema was written and applied to `sdigf_db` during Step 0a. **This was premature.**

Phase 4's schema is supposed to be *derived from* the frozen MQTT contract — the field names,
types, and quality semantics all come from Step 0b. The applied tables are a reasonable
skeleton but should be treated as **provisional**. Expect column renames and type changes once
Parts 3 and 4 below are settled.

Ground-truth rule for this project: **the GitHub repository is canonical.** Uploaded files or
earlier conversation content must never override it.

---

## 3. Step 0b Part 1 — Topic tree (SIGNED OFF)

```
sdigf/v1/gh1/up/telemetry      ESP32 → server
sdigf/v1/gh1/up/actuators      ESP32 → server
sdigf/v1/gh1/up/health         ESP32 → server
sdigf/v1/gh1/up/ack            ESP32 → server
sdigf/v1/gh1/status            ESP32 → server  (last will)

sdigf/v1/gh1/down/config       server → ESP32
sdigf/v1/gh1/down/cmd          server → ESP32
```

**`v1` in the path.** When the contract changes, `v2` topics can run alongside `v1` during
migration rather than breaking every client simultaneously. Costs nothing now.

**`gh1` as a device slot.** A second greenhouse becomes `gh2` with no redesign. The bridge
subscribes with a wildcard: `sdigf/v1/+/up/telemetry`.

**`up` / `down` in the path.** Direction is visible in the topic itself, which makes Phase 6
ACLs nearly trivial: `sdigf-edge` gets publish on `up/#` and subscribe on `down/#`, nothing
else.

### QoS and retain

Governing rule: **retain state, do not retain events.**

| Topic | QoS | Retained | Reasoning |
|---|---|---|---|
| `up/telemetry` | 0 | no | A stream. Losing one reading is harmless — the next arrives shortly. QoS 1 would fill the ESP32 inflight buffer whenever the broker is slow. |
| `up/actuators` | 1 | **yes** | Current state. A freshly connected dashboard must see what is on right now. |
| `up/health` | 0 | **yes** | Current state, but not worth a retry. |
| `up/ack` | 1 | no | An event — and the one that proves what the hardware actually applied. Must not be lost. |
| `status` | 1 | **yes** | A last will must be retained, or a late subscriber never learns the edge is down. |
| `down/config` | 1 | **yes** | The reconnect design depends on this. Verified working in Step 0a. |
| `down/cmd` | 1 | no | An event with a TTL. Retaining it would re-fire on every reconnect. |

### Batched telemetry (signed off)

All sensor readings travel in **one message**, not one topic per sensor.

Rationale — nothing in the system ever wants a single sensor in isolation:
- The bridge writes every reading to one table with one timestamp.
- The dashboard renders all gauges together.
- The control loop reads temperature **and** humidity together to evaluate Conflict A. Split
  topics would require pairing messages that arrived at slightly different times — a bug
  waiting to happen.
- The ESP32 reads all sensors in one loop pass anyway; publishing separately would mean many
  packets each carrying a copy of the same timestamp.

Per-sensor topics earn their keep when different consumers care about different sensors
independently (e.g. a 400-room building). That is not this system.

**Revisit if:** a single greenhouse ever exceeds roughly 30–40 readings, at which point the
batch would strain the ESP32 MQTT buffer.

---

## 4. Step 0b Part 2 — Payload schemas (DRAFT — awaiting sign-off)

### Shared envelope

Every edge→server message carries these, so the bridge can validate uniformly.

| Field | Type | Meaning |
|---|---|---|
| `v` | int | **Schema** version — not config version. Bump when payload shape changes. |
| `ts` | int | Unix epoch seconds, device clock |
| `tsq` | string | Timestamp quality: `ntp` (synced) or `boot` (seconds since boot; wall-clock meaningless) |
| `seq` | int | Monotonic counter, resets on reboot. Lets the server detect gaps. |

**Timestamp trust.** The ESP32 has no RTC. Before NTP syncs, `ts` is not wall-clock time —
hence `tsq`. **The bridge must record both the device timestamp and its own receive time**, and
prefer server time when `tsq` is `boot`. Without this, 1970-dated rows land in the thesis
dataset.

**MQTT buffer size.** Arduino `PubSubClient` defaults to a **256-byte** buffer and fails
*silently* when exceeded — the publish simply does not happen. Telemetry below is ~480 bytes.
**Phase 3 firmware must call `setBufferSize(1024)`.** This is a required item, not advice.

---

### 4.1 `up/telemetry` — QoS 0, not retained

```json
{
  "v": 1,
  "ts": 1756036800,
  "tsq": "ntp",
  "seq": 142,
  "r": {
    "temp_in":   {"val": 24.3,   "q": "ok"},
    "temp_out":  {"val": 19.8,   "q": "ok"},
    "press_in":  {"val": 1012.4, "q": "ok"},
    "press_out": {"val": 1012.1, "q": "ok"},
    "hum_in":    {"val": 58,     "q": "ok"},
    "hum_out":   {"val": null,   "q": "fail"},
    "aq":        {"val": 142,    "q": "ok"},
    "light_in":  {"val": 812,    "q": "ok"},
    "light_out": {"val": 2140,   "q": "ok"},
    "soil":      {"val": 41,     "q": "stale"},
    "water":     {"val": 78,     "q": "ok"}
  }
}
```

| Key | Source | Type | Unit | Notes |
|---|---|---|---|---|
| `temp_in` | BMP280 @0x76 | float | °C | 1 decimal |
| `temp_out` | BMP280 @0x77 | float | °C | 1 decimal |
| `press_in` | BMP280 @0x76 | float | hPa | 1 decimal |
| `press_out` | BMP280 @0x77 | float | hPa | 1 decimal |
| `hum_in` | DHT11 GPIO26 | int | %RH | integer only — sensor limitation |
| `hum_out` | DHT11 GPIO27 | int | %RH | integer only |
| `aq` | MQ135 GPIO32 | int | raw ADC | **relative trend, not ppm** |
| `light_in` | LDR GPIO36 | int | raw ADC | 0–4095 |
| `light_out` | LDR GPIO39 | int | raw ADC | 0–4095 |
| `soil` | FC-28 GPIO34 | int | % | mapped from ADC |
| `water` | GPIO35 | int | % | mapped from ADC |

#### Quality values

| `q` | Meaning | `val` | Control loop should |
|---|---|---|---|
| `ok` | Fresh and within plausible range | number | use it |
| `stale` | Last good value, older than that sensor's max age | last known number | use with caution, or fall back |
| `fail` | Read error, or outside physical bounds | `null` | **not** use it — fail safe |
| `init` | Never successfully read since boot | `null` | not use it |

`init` is distinct from `fail` on purpose: a DHT11 needs a couple of seconds before its first
reading, and without a separate state it is impossible to distinguish "broken" from "not asked
yet." That distinction appears in the logs after every reboot.

**The null rule.** When `q` is `fail` or `init`, `val` is always `null` — never `0` or `-127`.
Sentinel values leak into averages and quietly corrupt the dataset. `null` maps directly to
SQL `NULL` and is excluded from aggregates automatically.

**Why raw ADC for light and air quality.** Neither is calibrated. `aq` is explicitly a relative
trend per the project's stated caveats; calibrating an LDR to lux would invent precision that
does not exist. Store raw, interpret during analysis — this is the defensible choice
academically.

**Design change recorded:** an earlier draft used a single `"bad": [...]` exception list to
keep payloads small. Rejected in favour of explicit per-reading quality. It costs ~260 bytes
but lets the bridge write `quality_flag` per row with no inference, and lets the Phase 4
conflict queries filter `WHERE quality_flag = 'ok'` directly. Given DHT11 is the only humidity
source and its weakness is already a stated caveat, being able to say *"N excludes intervals
where humidity was unreliable"* is worth the bytes.

---

### 4.2 `up/actuators` — QoS 1, **retained**

```json
{
  "v": 1,
  "ts": 1756036800,
  "tsq": "ntp",
  "seq": 142,
  "a": {
    "pump":         {"on": false, "src": "auto",   "for_s": 0},
    "s_fan":        {"on": true,  "src": "auto",   "for_s": 340},
    "internal_fan": {"on": true,  "src": "auto",   "for_s": 340},
    "n_fan":        {"on": false, "src": "auto",   "for_s": 0},
    "humidifier":   {"on": false, "src": "auto",   "for_s": 0},
    "lights":       {"on": true,  "src": "manual", "for_s": 120},
    "grow_light":   {"on": true,  "src": "auto",   "for_s": 7200}
  },
  "canopy": {"pos": 40, "target": 40, "moving": false, "src": "auto"},
  "vent": 2
}
```

| Field | Type | Meaning |
|---|---|---|
| `on` | bool | Logical state. **Note: this is logical, not electrical** — the relay module is active-LOW, so `on: true` means the GPIO is driven LOW. |
| `src` | string | `auto` (control loop), `manual` (server command), `safety` (envelope override) |
| `for_s` | int | Seconds in the current state. Feeds the pump max-runtime guard, relay minimum-off-time, and stuck-actuator detection. |
| `canopy.pos` | int 0–100 | Believed current position, % closed |
| `canopy.target` | int 0–100 | Commanded position |
| `canopy.moving` | bool | True during travel |
| `vent` | int 0–3 | Derived ventilation stage (count of fans running) |

**Why `src` exists.** The Phase 4 event log and the Phase 9 ledger both need to distinguish
autonomous action from human action. Recording it at the point of state change is far more
reliable than inferring it later by correlating timestamps.

**Why `vent` is published even though it is derivable.** It is the value the control policy is
written against (staged 0–3). Publishing it explicitly means the server never has to reimplement
the fan→stage mapping, so the two cannot drift apart.

**Why `canopy` sits outside the `a` block.** It is positional, not binary. Keeping it separate
prevents the server from having to special-case one key inside an otherwise uniform map.

**Position is *believed*, not measured.** The MG996R has no feedback. `pos` is what the firmware
commanded, and it may not reflect physical reality if the canopy jams. Per the hardware
constraints: command the move, wait the travel time, then **detach the signal** — never hold
position indefinitely, because a stalled MG996R draws ~2.5 A and will brown out the 5 V rail.

---

### 4.3 `up/health` — QoS 0, **retained**

```json
{
  "v": 1,
  "ts": 1756036800,
  "tsq": "ntp",
  "seq": 142,
  "up_s": 84213,
  "rssi": -67,
  "heap": 142880,
  "heap_min": 118004,
  "fw": "0.3.1",
  "cfg": {"ver": 7, "hash": "9f2c…a1", "src": "mqtt"},
  "mqtt_reconnects": 3,
  "boot_reason": "power_on"
}
```

| Field | Type | Meaning |
|---|---|---|
| `up_s` | int | Seconds since boot |
| `rssi` | int | WiFi signal, dBm |
| `heap` | int | Free heap, bytes |
| `heap_min` | int | Lowest free heap since boot — catches slow leaks a spot reading misses |
| `fw` | string | Firmware version |
| `cfg.ver` | int | Config version **currently running** |
| `cfg.hash` | string | Canonical hash currently running |
| `cfg.src` | string | `mqtt` (received from server) or `nvs` (last-known-good after a restart with no broker) |
| `mqtt_reconnects` | int | Reconnect count since boot — a rising number indicates link instability |
| `boot_reason` | string | `power_on`, `watchdog`, `panic`, `brownout`, `sw_reset` |

**`cfg.src` is load-bearing for the thesis.** It is the field that makes edge autonomy visible
and provable: when the broker is unreachable and the ESP32 restarts, this reads `nvs`, showing
the greenhouse ran correctly on last-known-good config with no server involvement.

**`boot_reason` = `brownout`** is the specific signature of a stalled canopy servo or an
ESP32-CAM inrush on the shared 5 V rail. Worth capturing rather than diagnosing blind.

---

### 4.4 `up/ack` — QoS 1, not retained

**The most important payload in the contract.** This is what proves the hardware is running
exactly what was approved — the last link in the chain of evidence.

Accepted:
```json
{
  "v": 1,
  "ts": 1756036800,
  "tsq": "ntp",
  "seq": 143,
  "ref": {"ver": 8, "hash": "3d81…c4"},
  "result": "accepted",
  "applied": {"ver": 8, "hash": "3d81…c4"},
  "reason": null
}
```

Rejected:
```json
{
  "v": 1,
  "ts": 1756036800,
  "tsq": "ntp",
  "seq": 143,
  "ref": {"ver": 8, "hash": "3d81…c4"},
  "result": "rejected",
  "applied": {"ver": 7, "hash": "9f2c…a1"},
  "reason": {
    "code": "ENVELOPE",
    "field": "pump.max_runtime_s",
    "detail": "1800 exceeds hard limit 600"
  }
}
```

| Field | Meaning |
|---|---|
| `ref` | Version and hash of the config **received** |
| `result` | `accepted` \| `rejected` |
| `applied` | Version and hash **now running**. On rejection this is the *previous* config — the edge never ends up running nothing. |
| `reason` | `null` when accepted; otherwise a structured object |

#### Rejection codes

| Code | Meaning |
|---|---|
| `ENVELOPE` | Violates a hardcoded equipment limit. **Non-negotiable regardless of how well signed.** |
| `HASH_MISMATCH` | Recomputed canonical hash ≠ the hash in the payload |
| `NOT_NEWER` | `ver` ≤ currently running version |
| `PARSE` | Malformed JSON, or missing required field |
| `SCHEMA` | Unsupported `v` (schema version) |

**Why `ref` and `applied` are separate.** They are the same on success and deliberately
different on rejection. This lets the server state, from the record alone, both *what was sent*
and *what is actually running* — without which "the hardware is running exactly what was
approved" is an unverifiable claim.

**Why rejection reasons are structured, not free text.** The dashboard needs to render them,
the ledger needs to record them, and the thesis needs to count them by category. Free-form
strings cannot be aggregated.

**`ENVELOPE` is the demo's centrepiece.** It demonstrates the second enforcement gate: the edge
rejects an unsafe config *even when correctly signed by a valid quorum*. Server RBAC and edge
safety are independent gates, and this code is where that independence becomes visible.

---

### 4.5 `status` — QoS 1, **retained** (last will)

Published by the device on connect:
```json
{"v": 1, "state": "online", "ts": 1756036800}
```

Set as the Last Will at connection time:
```json
{"v": 1, "state": "offline"}
```

**A last-will payload is fixed when the client connects and cannot contain a current
timestamp** — the broker publishes bytes chosen minutes or hours earlier. So the offline
message carries no `ts`. **The server must timestamp offline events on receipt.** Attempting to
put a device timestamp in a last will produces a message claiming the device went offline at
the moment it came *online*.

Both are retained so that any subscriber connecting later immediately learns the current state.

---

### 4.6 `down/config` — QoS 1, **retained**

```json
{
  "v": 1,
  "ts": 1756036800,
  "ver": 8,
  "hash": "3d81…c4",
  "cfg": { "…": "see Part 3 (OPEN)" }
}
```

| Field | Meaning |
|---|---|
| `ver` | Monotonically increasing config version. The edge applies only if strictly greater than what it is running. |
| `hash` | Canonical hash of `cfg` — see Part 4 (OPEN) |
| `cfg` | The control parameters themselves — see Part 3 (OPEN) |

**`hash` covers `cfg` only**, not the envelope. `ts` and `v` are transport metadata and must not
affect the signed value — otherwise re-publishing an unchanged config would produce a different
hash and break signature verification.

**Retained is essential.** A reconnecting ESP32 receives the current config immediately without
the server having to detect the reconnection and re-push. Verified working in Step 0a.

---

### 4.7 `down/cmd` — QoS 1, not retained

```json
{
  "v": 1,
  "ts": 1756036800,
  "id": "c8f21e",
  "target": "humidifier",
  "action": "on",
  "ttl_s": 300,
  "by": {"user": "farmer-01", "role": "FARMER"}
}
```

| Field | Meaning |
|---|---|
| `id` | Unique command ID. Enables idempotency and correlation with the event log. |
| `target` | Actuator key, matching `up/actuators`, or `canopy` |
| `action` | `on` \| `off` \| `set` (with `value` for canopy position) \| `release` |
| `ttl_s` | Seconds this override remains in force. **Required — no unbounded manual overrides.** |
| `by` | Actor and role. Populated in Phase 6; present in the schema from day one. |

**Manual override reconciliation** (answering the Phase 3 requirement of *who wins, for how
long, how it expires*):

1. A manual command overrides autonomous control for its `target` only.
2. It holds for `ttl_s` seconds, then **automatically expires** and control returns to `auto`.
3. `release` ends the override early.
4. **The safety envelope always wins.** A manual command that would exceed pump max-runtime is
   cut short by the envelope, and `src` becomes `safety`.
5. Overrides do **not** survive reboot. After a restart the edge resumes autonomous control on
   last-known-good config — an operator override must never silently persist across a power cut.

**Why not retained.** A retained command would re-fire on every reconnect, meaning a pump
switched on manually last week would restart itself after a power cut. Commands are events with
an expiry; state belongs on the config topic.

---

## 5. OPEN — remaining work in Step 0b

### Part 3 — Config payload structure

The actual control parameters the agriculture engineer sets. **No agronomic values are to be
invented** — the engineer supplies them; the contribution is the mechanism.

Must cover:
- temperature band + hysteresis
- humidity band + hysteresis
- soil moisture threshold
- pump max runtime and cooldown
- photoperiod schedule
- ventilation staging thresholds (levels 0–3)
- canopy policy: allowed-for-cooling, max shade minutes/day, only-above-threshold
- **conflict arbiter policy for Conflict A** (fans vs. humidifier — hot AND dry together)
- **conflict arbiter policy for Conflict B** (canopy vs. photoperiod)

### Part 4 — Canonical serialization spec

The highest-risk item in the whole project. This hash is computed independently by **four**
implementations:

| Implementation | Purpose |
|---|---|
| Browser (WebCrypto) | signs it |
| Server (Node.js) | verifies and stores it |
| Ledger | records it |
| ESP32 | confirms what it received |

If any one drifts, signatures fail in ways that are very hard to diagnose.

Must define precisely: key ordering · whitespace · number formatting · float precision ·
encoding · null handling — **plus a fixed test vector** (a sample config and its expected hash)
that every implementation can be checked against.

### Also outstanding

- Broker-restart retention test (carried over from Step 0a)
- Backups for `sdigf_db_data` and `sdigf_emqx_data`
- MQTTX test payloads for every topic, so the contract can be exercised by hand before either
  tier is written

---

## 6. Working agreements

- **Ground truth:** the GitHub repository. Uploaded files and prior conversation never override it.
- Step-by-step with sign-off before code.
- Simple, direct language.
- Arabic documentation is maintained alongside English. The canonical Arabic term is
  **البيوت الزراعية الذكية**; **دفيئة** is never used.
- Thesis chapter structure maps to phases, which map to repository folders.

---

*End of record. Sections 4.2–4.7 await sign-off; Parts 3 and 4 are not yet started.*
