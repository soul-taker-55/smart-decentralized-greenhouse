# SDIGF — MQTT Contract v1

**Project:** Smart Decentralized Greenhouse (SDIGF)
**Status:** COMPLETE — Parts 1–4 signed off
**Last updated:** 2026-08-24
**Location:** `Phase_04_Logging/4b_contracts/mqtt_contract_v1.md`

> **This document is the interface between the edge tier and the server tier.**
> Once frozen it changes only by introducing a `v2` topic namespace — never by editing `v1`
> in place.
>
> | Implementation | Role |
> |---|---|
> | ESP32 firmware (Phase 02–03) | publishes telemetry, consumes config, enforces the safety envelope |
> | MQTT→DB bridge (Phase 04d) | consumes everything, writes to Postgres |
> | REST backend (Phase 05a) | publishes config and commands, computes and verifies the canonical hash |
> | Browser (Phase 05b) | computes the canonical hash and signs it |
> | Mock edge simulator (Step 04c) | stands in for the ESP32 until firmware exists |

---

## 1. Topic tree

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

**`up` / `down` in the path.** Direction is visible in the topic itself, which makes Phase 05b
ACLs nearly trivial: `sdigf-edge` gets publish on `up/#` and subscribe on `down/#`, nothing else.

### QoS and retain

Governing rule: **retain state, do not retain events.**

| Topic | QoS | Retained | Reasoning |
|---|---|---|---|
| `up/telemetry` | 0 | no | A stream. Losing one reading is harmless — the next arrives shortly. QoS 1 would fill the ESP32 inflight buffer whenever the broker is slow. |
| `up/actuators` | 1 | **yes** | Current state. A freshly connected dashboard must see what is on right now. |
| `up/health` | 0 | **yes** | Current state, but not worth a retry. |
| `up/ack` | 1 | no | An event — and the one that proves what the hardware actually applied. Must not be lost. |
| `status` | 1 | **yes** | A last will must be retained, or a late subscriber never learns the edge is down. |
| `down/config` | 1 | **yes** | The reconnect design depends on this. Verified in Step 04a, including across a broker restart. |
| `down/cmd` | 1 | no | An event with a TTL. Retaining it would re-fire on every reconnect. |

### Batched telemetry

All sensor readings travel in **one message**, not one topic per sensor.

Rationale — nothing in the system ever wants a single sensor in isolation:

- The bridge writes every reading to one table with one timestamp.
- The dashboard renders all gauges together.
- The control loop reads temperature **and** humidity together to evaluate Conflict A. Split
  topics would require pairing messages that arrived at slightly different times — a bug
  waiting to happen.
- The ESP32 reads all sensors in one loop pass anyway; publishing separately would mean many
  packets each carrying a copy of the same timestamp.

**Revisit if:** a single greenhouse ever exceeds roughly 30–40 readings, at which point the
batch would strain the ESP32 MQTT buffer.

---

## 2. Shared envelope

Every edge→server message carries these, so the bridge can validate uniformly.

| Field | Type | Meaning |
|---|---|---|
| `v` | int | **Schema** version — not config version. Bump when payload shape changes. |
| `ts` | int | Unix epoch seconds, device clock |
| `tsq` | string | Timestamp quality: `ntp` (synced) or `boot` (seconds since boot; wall-clock meaningless) |
| `seq` | int | Monotonic counter, resets on reboot. Lets the server detect gaps. |

### Two implementation constraints

**Timestamp trust.** The ESP32 has no RTC. Before NTP syncs, `ts` is not wall-clock time —
hence `tsq`. **The bridge must record both the device timestamp and its own receive time**, and
prefer server time when `tsq` is `boot`. Without this, 1970-dated rows land in the thesis dataset.

**MQTT buffer size.** Arduino `PubSubClient` defaults to a **256-byte** buffer and fails
*silently* when exceeded — the publish simply does not happen. Telemetry is ~480 bytes.
**Phase 03 firmware must call `setBufferSize(1024)`.** Required, not advice.

### Bridge obligations

**Deduplication is mandatory.** The Phase 04d bridge must enforce uniqueness on
`(greenhouse_id, seq, sensor_name)`. Two mechanisms produce duplicates in normal operation:
QoS 1 redelivery when an acknowledgement is lost, and republication after an edge reconnect.
Duplicate rows skew every aggregate silently — a conflict-frequency count computed over
duplicated data is simply wrong, with nothing to indicate it. A unique constraint costs almost
nothing and makes the failure impossible rather than merely unlikely.

`seq` resets to zero on reboot, so the constraint alone is not sufficient across restarts. The
bridge should treat a `seq` lower than the last one seen as a reboot and record it as such,
rather than rejecting the row.

**Retention must not silently delete evidence.** The database schema currently retains
telemetry for 90 days. If data collection begins well before the thesis is written, that policy
will remove early observations without any warning. Either extend retention to cover the full
project timeline, or — better — export a frozen dataset table that no retention policy touches.
A thesis dataset should not be something a background job can quietly alter.

**Telemetry interval: 30 seconds.** Fixed. `sys.telemetry_interval_s` defaults to `30`, and the
mock must be updated to match.

The reasoning matters, because both obvious answers are wrong. At 10 s most of what is stored is
sensor noise around an unchanged value — air temperature in a small sealed enclosure has a time
constant measured in minutes, and humidity is slower still. But 60 s would alias the very thing
Phase 04 exists to measure: the conflict-frequency question is about **actuator oscillation**, a
fan cycling against a humidifier, which happens considerably faster than the underlying physics.
Sampling at 60 s could show a steady state that never existed.

30 s is three times less storage than 10 s while still resolving oscillation. The edge control
loop is unaffected — only the publish rate changes.

---

## 3. Payload schemas

### 3.1 `up/telemetry` — QoS 0, not retained

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

> **Note.** Telemetry values are *not* hashed or signed, so floats are acceptable here. The
> integer-only rule in Part 4 applies to the **config payload** only.

#### Quality values

| `q` | Meaning | `val` | Control loop should |
|---|---|---|---|
| `ok` | Fresh and within plausible range | number | use it |
| `stale` | Last good value, older than `sys.stale_after_s` | last known number | use with caution, or fall back |
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
does not exist. Store raw, interpret during analysis — the defensible choice academically.

---

### 3.2 `up/actuators` — QoS 1, **retained**

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
    "lights":       {"on": true,  "src": "manual", "for_s": 120, "ovr_s": 180},
    "grow_light":   {"on": true,  "src": "auto",   "for_s": 7200}
  },
  "canopy": {"pos": 40, "target": 40, "moving": false, "src": "auto"},
  "vent": 2
}
```

| Field | Type | Meaning |
|---|---|---|
| `on` | bool | Logical state. **Logical, not electrical** — the relay module is active-LOW, so `on: true` means the GPIO is driven LOW. |
| `src` | string | `auto` (control loop), `manual` (server command), `safety` (envelope override) |
| `for_s` | int | Seconds in the current state. Feeds the pump max-runtime guard, relay minimum-off-time, and stuck-actuator detection. |
| `ovr_s` | int | Seconds of manual override **remaining**. Present only when `src` is `manual`; omitted otherwise. Lets the dashboard and chat interface show when autonomous control resumes, rather than leaving an operator guessing. |
| `canopy.pos` | int 0–100 | Believed current position, % closed |
| `canopy.target` | int 0–100 | Commanded position |
| `canopy.moving` | bool | True during travel |
| `vent` | int 0–3 | Derived ventilation stage (count of fans running) |

**Why `src` exists.** The Phase 04 event log and the Phase 07 ledger both need to distinguish
autonomous action from human action. Recording it at the point of state change is far more
reliable than inferring it later by correlating timestamps.

**Why `vent` is published even though it is derivable.** It is the value the control policy is
written against (staged 0–3). Publishing it explicitly means the server never reimplements the
fan→stage mapping, so the two cannot drift apart.

**Why `canopy` sits outside the `a` block.** It is positional, not binary. Keeping it separate
prevents the server from special-casing one key inside an otherwise uniform map.

**Position is *believed*, not measured.** The MG996R has no feedback. `pos` is what the firmware
commanded, and may not reflect physical reality if the canopy jams. Per the hardware
constraints: command the move, wait the travel time, then **detach the signal** — never hold
position indefinitely, because a stalled MG996R draws ~2.5 A and will brown out the 5 V rail.

---

### 3.3 `up/health` — QoS 0, **retained**

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
| `cfg.hash` | string | Hash **as received** from the server. The edge stores and echoes it; it does not recompute it (see §5). |
| `cfg.src` | string | `mqtt` (received from server) or `nvs` (last-known-good after restart with no broker) |
| `mqtt_reconnects` | int | Reconnect count since boot — a rising number indicates link instability |
| `boot_reason` | string | `power_on`, `watchdog`, `panic`, `brownout`, `sw_reset` |

**`cfg.src` is load-bearing for the thesis.** It is the field that makes edge autonomy visible
and provable: when the broker is unreachable and the ESP32 restarts, this reads `nvs`, showing
the greenhouse ran correctly on last-known-good config with no server involvement.

**`boot_reason` = `brownout`** is the specific signature of a stalled canopy servo or an
ESP32-CAM inrush on the shared 5 V rail. Worth capturing rather than diagnosing blind.

---

### 3.4 `up/ack` — QoS 1, not retained

**The most important payload in the contract.** It is what proves the hardware is running
exactly what was approved — the last link in the evidence chain.

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
| `ENVELOPE` | Violates a hardcoded equipment limit. **Non-negotiable regardless of provenance.** |
| `NOT_NEWER` | `ver` ≤ currently running version |
| `PARSE` | Malformed JSON, or missing required field |
| `SCHEMA` | Unsupported `v` (schema version) |

> `HASH_MISMATCH` was removed. The edge no longer recomputes the hash — see §5.

**Why `ref` and `applied` are separate.** They are the same on success and deliberately
different on rejection. This lets the server state, from the record alone, both *what was sent*
and *what is actually running* — without which "the hardware is running exactly what was
approved" is an unverifiable claim.

**Why rejection reasons are structured, not free text.** The dashboard renders them, the ledger
records them, and the thesis counts them by category. Free-form strings cannot be aggregated.

**`ENVELOPE` is the demo's centrepiece.** It demonstrates the second enforcement gate: the edge
rejects an unsafe config *even when correctly signed by a valid quorum*. Server RBAC and edge
safety are independent gates, and this code is where that independence becomes visible.

---

### 3.5 `status` — QoS 1, **retained** (last will)

Published by the device on connect:

```json
{"v": 1, "state": "online", "ts": 1756036800}
```

Set as the Last Will at connection time:

```json
{"v": 1, "state": "offline"}
```

**A last-will payload is fixed when the client connects and cannot contain a current
timestamp** — the broker publishes bytes chosen minutes or hours earlier. So the offline message
carries no `ts`. **The server must timestamp offline events on receipt.** Putting a device
timestamp in a last will produces a message claiming the device went offline at the moment it
came *online*.

Both are retained so any subscriber connecting later immediately learns the current state.

---

### 3.6 `down/config` — QoS 1, **retained**

```json
{
  "v": 1,
  "ts": 1756036800,
  "ver": 8,
  "hash": "3d81…c4",
  "cfg": { "…": "see §4" }
}
```

| Field | Meaning |
|---|---|
| `ver` | Monotonically increasing config version. The edge applies only if strictly greater than what it is running. |
| `hash` | Canonical hash of `cfg` — see §5 |
| `cfg` | The control parameters — see §4 |

**`hash` covers `cfg` only**, not the envelope. `ts` and `v` are transport metadata and must not
affect the signed value — otherwise re-publishing an unchanged config would produce a different
hash and break signature verification.

**Retained is essential.** A reconnecting ESP32 receives the current config immediately without
the server having to detect the reconnection and re-push. Verified in Step 04a, including across
a broker container restart.

---

### 3.7 `down/cmd` — QoS 1, not retained

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
| `by` | Actor and role. Populated in Phase 05b; present in the schema from day one. |

**Manual override reconciliation** — who wins, for how long, how it expires:

1. A manual command overrides autonomous control for its `target` only.
2. It holds for `ttl_s` seconds, then **automatically expires** and control returns to `auto`.
3. `release` ends the override early.
4. **The safety envelope always wins.** A manual command that would exceed pump max-runtime is
   cut short by the envelope, and `src` becomes `safety`.
5. Overrides do **not** survive reboot. After a restart the edge resumes autonomous control on
   last-known-good config — an operator override must never silently persist across a power cut.
6. **Expiry is edge-local.** The countdown runs on the ESP32 and the revert restores control from
   the config already in NVS. It does **not** re-fetch from the server, does **not** wait for a
   release command, and is unaffected by MQTT dropping mid-override. An unreachable server must
   never mean a stuck actuator — this is the same principle that governs the rest of the edge
   tier, applied to overrides.
7. **A newly APPROVED config cancels all active overrides immediately.** An approved recipe
   outranks a transient command. Without this rule an operator could hold an actuator against a
   configuration the quorum has just approved, for as long as they kept issuing commands.
8. Remaining override time is published in `up/actuators` as `ovr_s`, so override state is
   observable rather than inferred.

**What this buys architecturally.** Because every command carries an edge-enforced TTL and
auto-reverts to the approved configuration without server involvement, the blast radius of any
command — human or AI-issued — is bounded by design rather than by trust. Nothing has to behave
correctly for the override to end; the timer simply expires.

**Why not retained.** A retained command would re-fire on every reconnect, meaning a pump
switched on manually last week would restart itself after a power cut. Commands are events with
an expiry; state belongs on the config topic.

---

## 4. Config payload structure

This is the `cfg` object inside `down/config`. It is what the engineer edits, the browser signs,
and the ESP32 validates against its safety envelope.

```json
{
  "sys": {
    "telemetry_interval_s": 30,
    "stale_after_s": 60
  },
  "temp": {
    "min_dc": null,
    "max_dc": null,
    "hyst_dc": null
  },
  "hum": {
    "min_pct": null,
    "max_pct": null,
    "hyst_pct": null
  },
  "vent": {
    "stage_offsets_dc": [0, 20, 40],
    "min_off_s": 60
  },
  "pump": {
    "soil_start_pct": null,
    "soil_stop_pct": null,
    "max_runtime_s": null,
    "cooldown_s": null,
    "water_min_pct": null
  },
  "photo": {
    "on_min": null,
    "off_min": null,
    "tz_offset_min": 0
  },
  "canopy": {
    "enabled_for_cooling": true,
    "only_above_dc": null,
    "max_pct": 100,
    "step_pct": 10,
    "min_dwell_s": 30,
    "max_shade_min_day": null
  },
  "arb_a": {
    "priority": "temperature",
    "fan_cap_stage": 1,
    "max_suppress_s": 900
  },
  "arb_b": {
    "priority": "light",
    "max_pct_in_photo": 30
  }
}
```

`null` marks values the **agriculture engineer supplies**. They are structurally required but
deliberately unset — inventing agronomic numbers is out of scope for this project.

### Grouped, not flat

Chosen over a flat namespace for three reasons that all bite later:

- The safety envelope checks limits per subsystem. `pump.max_runtime_s` says what it guards;
  `pump_max_runtime_s` in a flat list of thirty keys does not.
- Rejection reasons in `up/ack` carry a `field` path, so `"field": "pump.max_runtime_s"` is
  directly renderable in the dashboard.
- Canonical hashing sorts keys recursively — no extra complexity — whereas a flat namespace
  invites inconsistent prefixing, exactly the kind of drift that breaks signatures.

### Units: the `_dc` suffix

Temperatures are stored as **deci-Celsius integers**: `hyst_dc: 10` means 1.0 °C.

Floats are the single most common source of cross-language hash mismatches — JavaScript writes
`1.0` as `1`, C prints it as `1.000000`. Integers serialize identically in every language.
The sensors do not resolve better than 0.1 °C, so nothing is lost.

The suffix is in the key name so a value cannot be misread. `hyst_c: 10` looks like a plausible
10 °C hysteresis; `hyst_dc: 10` does not. Documentation only helps whoever reads it — a suffix
helps everyone.

Only scaled units get a suffix. Percentages and seconds are naturally integers and keep plain
names.

### Block-by-block

**`sys`** — `telemetry_interval_s` sets publish rate. `stale_after_s` is the source of the
`q: "stale"` flag in telemetry: a reading older than this is marked stale rather than silently
reused.

**`temp`** — `max_dc` is the actionable bound: above it, cool. **`min_dc` is advisory only.**
Nothing in this system adds heat on demand (the grow light is committed to the photoperiod), so
a low reading can be alarmed but not acted on. Keeping the field makes that asymmetry visible
rather than an unexplained gap.

**`vent`** — stages are **offsets above `temp.max_dc`**, not absolute thresholds. With
`[0, 20, 40]` and `max_dc = 260`, one fan runs at 26.0 °C, two at 28.0, three at 30.0. Absolute
per-stage thresholds would duplicate the band in four places, and the day someone edits one and
not the others you get silently incoherent control. One source of truth. `min_off_s` protects
the relays from short-cycling.

**`pump`** — `soil_start_pct` / `soil_stop_pct` form the hysteresis pair directly, clearer than
a threshold plus a separate deadband. `water_min_pct` is dry-run protection: below it the pump
does not start regardless of soil.

**`photo`** — times are **minutes from midnight** (`360` = 06:00), not `"06:00"` strings.
Integers have exactly one representation; strings invite `"6:00"` vs `"06:00"`, which would
change the hash. `tz_offset_min` is explicit because the ESP32 gets UTC from NTP and has no
timezone database.

**`canopy`** — `only_above_dc` stops the canopy reacting to trivial warmth. `step_pct` and
`min_dwell_s` exist for the servo's sake: the MG996R must be commanded, allowed to travel, then
detached. Small frequent moves would mean near-continuous holding, and a stalled MG996R at
~2.5 A browns out the 5 V rail. `max_shade_min_day` caps total daily light sacrificed.

### The conflict arbiters

Both conflicts resolve through fields the engineer sets and a signed config carries. The
firmware holds no opinion about whether temperature or humidity matters more — it executes the
policy deterministically. That is what makes Phase 08 a real comparison later: fuzzy inference
evaluated against a baseline that was genuinely *configured*, not hardcoded.

**`arb_a` — fans vs. humidifier** (hot AND dry simultaneously)

| Field | Effect |
|---|---|
| `priority` | `"temperature"` → fans run, humidifier suppressed. `"humidity"` → humidifier runs, fans capped. |
| `fan_cap_stage` | Maximum ventilation stage allowed while humidity holds priority |
| `max_suppress_s` | How long the losing side may stay suppressed before it gets a turn |

`max_suppress_s` is what makes this defensible. A pure priority rule can starve one variable
indefinitely — hold `"temperature"` through a long hot dry spell and humidity never recovers.
Forced alternation bounds the damage, and it is a policy the engineer sets rather than firmware
behaviour they cannot see.

**`arb_b` — canopy vs. photoperiod**

| Field | Effect |
|---|---|
| `priority` | `"light"` → canopy stays open during the photoperiod. `"temperature"` → shading permitted, bounded. |
| `max_pct_in_photo` | Ceiling on shading during the photoperiod when temperature has priority |

`max_pct_in_photo` turns this from a binary into a dial: partial shade trades some light for
some cooling instead of losing one outright.

The canopy stays out of Conflict A entirely — the box is sealed, so shading does not exchange
air and cannot fight the humidifier.

### Deliberately *not* in config

**Safety envelope limits.** Hardcoded in firmware, derived from equipment datasheets,
non-negotiable. If they were configurable they would not be a second gate.

**Pin assignments.** Fixed in Phase 01 and locked at wiring doc v1.7.

---

## 5. Canonical serialization and the trust boundary

### Who computes the hash

| Component | Role |
|---|---|
| Browser (WebCrypto) | canonicalizes `cfg`, hashes it, signs the hash |
| Server (Node.js) | recomputes independently, verifies signatures, stores the hash |
| Ledger | records the hash and signatures |
| **ESP32** | **does not compute it** — stores the received hash and echoes it in `up/ack` |

**Why the edge is excluded.** Recomputing the hash on the ESP32 would catch corruption in
transit but nothing else: the config and its hash arrive from the same party, so anyone able to
alter one can alter the other. It is an integrity check, not an authenticity check. Removing it
takes the count from four implementations to three — and eliminates the one that would have been
hardest to debug. The ack still carries `applied.hash`, so the server-side evidence chain is
unchanged.

### The edge's actual gate

**The safety envelope** — hardcoded equipment limits that reject unsafe configurations
regardless of provenance. This is the control that matters, and it was doing the load-bearing
work regardless of whether a hash was verified.

Its purpose is not to defend against a hostile server. It defends against a server that is
**wrong**: a backend regression publishes `max_runtime_s: 18000`, every server-side control
works exactly as designed, the config is correctly signed and correctly chained, and the
enclosure floods. Only a limit living in firmware stops that.

It also keeps the project's central claim coherent. *Decentralized* here means the edge keeps
operating when the server is gone. An edge that depends on the server to tell it what is safe is
not autonomous — it is running on cached permission. The envelope is where the Zero Trust claim
actually lives: the edge does not assume the server validated correctly, and rejects physically
unsafe values regardless of provenance or how well signed they are. Trust is not granted by
network position.

**What excluding verification costs, stated plainly.** Skipping signature verification is a
scoping concession, not a security property — Zero Trust means *verify explicitly*, and this
does the opposite. The consequence is concrete: because the ESP32 does not verify signatures,
authenticity in transit rests on broker authentication rather than end-to-end cryptography, and
**the M-of-N approval guarantee therefore terminates at the backend service rather than at the
actuator.** Anyone holding the `sdigf-backend` credential, or anyone who compromises that
service, can publish an arbitrary configuration and the edge will apply it provided it clears
the safety envelope. The chain of custody breaks at the broker. That is acceptable for a
proof-of-concept and it is driven by the real cost of asymmetric cryptography and key
distribution on an ESP32 — but it is a limitation to disclose, not a design virtue to claim.
Extending verification to the edge would close the chain end-to-end and is identified as future
work.

### Statement for the thesis

> The edge does not verify signatures or hashes. Cryptographic verification occurs server-side,
> where the keys and the approval quorum live; the approval guarantee consequently terminates at
> the backend rather than at the actuator, and authenticity in transit rests on broker
> authentication. This is a deliberate proof-of-concept scoping decision reflecting the cost of
> asymmetric cryptography on the ESP32, and end-to-end verification is identified as future work.
> Independently of that, the edge enforces a safety envelope derived from equipment limits, which
> rejects unsafe configurations regardless of provenance. These are complementary gates: the
> server controls *who may change things*; the firmware controls *what values are physically
> permissible* — and the firmware gate holds even when the server gets it wrong.

Stating the boundary openly is stronger than claiming edge-side cryptography that then has to be
qualified.

### Canonicalization rules

Applied to the `cfg` object only — never the transport envelope.

| Rule | Specification |
|---|---|
| Key order | Object **keys** sorted lexicographically by UTF-8 code point, **applied recursively** to nested objects. Values are never reordered. |
| Whitespace | None. No spaces after `:` or `,`, no newlines, no trailing newline |
| Encoding | UTF-8, no BOM |
| Numbers | **Integers only.** No decimal point, no exponent, no leading zeros, no `+`. Negative numbers use a single leading `-`. This rule constrains numeric values only; booleans and null are governed by their own rows below. |
| Booleans | `true` / `false`, lowercase |
| Null | Literal `null`. A key set to `null` is **included**, not omitted — an unset value is part of the signed content. |
| Arrays | Order preserved exactly as authored. **Never sorted** — `stage_offsets_dc` is meaningful in sequence. |
| Strings | JSON escaping only where required (`"`, `\`, control characters). No `\uXXXX` escaping of characters that do not need it. |
| Hash | SHA-256 over the UTF-8 bytes, output as **lowercase hex** |

**Integers only is a hard rule for config.** It is what removes the entire class of float
formatting mismatch. Any value needing sub-unit precision is scaled and carries a unit suffix,
as with `_dc`.

**Nulls are included, not stripped.** Omitting them would mean a config with `temp.max_dc` unset
hashes identically to one where the key does not exist — two different states collapsing to one
signature.

### Test vector

Every implementation must reproduce this exactly before being trusted.

Input:

```json
{"b":{"y":2,"x":1},"a":[3,1,2],"c":null,"d":true}
```

Canonical form (single line, no whitespace):

```
{"a":[3,1,2],"b":{"x":1,"y":2},"c":null,"d":true}
```

What it exercises: top-level key sorting (`b` before `a` in input, after canonicalization
reversed), recursive sorting inside `b`, array order **preserved** (`[3,1,2]` stays `[3,1,2]`
and is not sorted to `[1,2,3]`), null retained, boolean lowercase.

Expected SHA-256 of the canonical string, lowercase hex:

```
911a7250d4853dec84df401015ab201c6241ee1c87fb6e70862afd13e087a908
```

Any implementation producing a different digest is wrong. Check this before writing any
signing or verification code — a mismatch found here costs minutes, the same mismatch found
during signature verification costs days.

A second vector using the real `cfg` shape should be added once the agriculture engineer
supplies actual values.

---

## 6. Change log

| Date | Change |
|---|---|
| 2026-08-24 | Parts 1–2 drafted: topic tree, QoS/retain, payload schemas |
| 2026-08-24 | Per-reading quality flags adopted, replacing a `bad: []` exception list |
| 2026-08-24 | Part 3: grouped config structure, deci-Celsius integers, arbiter policies with `max_suppress_s` |
| 2026-08-24 | Part 4: canonicalization rules and test vector |
| 2026-08-24 | ESP32 hash verification removed; `HASH_MISMATCH` dropped from ack codes |
| 2026-08-24 | Cross-references renumbered to the corrected phase scheme (00–08) |
| 2026-08-24 | Test vector digest computed and frozen |
| 2026-08-24 | §2: bridge obligations added — deduplication, retention, telemetry interval (open) |
| 2026-08-24 | §5: Zero Trust justification corrected — signature exclusion reframed as a scoping concession, not a security property; approval guarantee disclosed as terminating at the backend |
| 2026-08-24 | §3.2: `ovr_s` added to `up/actuators` — remaining manual-override seconds |
| 2026-08-24 | §3.7: reconciliation rules 6–8 added — edge-local expiry, approved config cancels overrides, override state observable |
| 2026-08-24 | §2: telemetry interval fixed at **30 s** (10 s stores noise; 60 s aliases actuator oscillation) |
| 2026-08-24 | §5: canonicalization wording clarified — keys sorted not values; integer rule scoped to numbers |

---

*Parts 1–4 complete. Frozen for Step 04c (mock simulator) and Phase 04d (bridge and schema).*
