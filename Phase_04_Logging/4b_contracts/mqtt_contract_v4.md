# SDIGF — MQTT Contract v4

**Project:** Smart Decentralized Greenhouse (SDIGF)
**Status:** COMPLETE — Parts 1–4 signed off, edge verification amendment applied
**Last updated:** 2026-08-25
**Supersedes:** `mqtt_contract_v3.md` (superseded copies live in `old/`)
**Location:** `Phase_04_Logging/4b_contracts/mqtt_contract_v4.md`

> **This document is the interface between the edge tier and the server tier.**
>
> **Document version vs. topic version.** This is document revision **v4**. The topic namespace
> remains **`sdigf/v1/...`** and the envelope field `v` remains **`1`**. The two are deliberately
> independent: the topic version changes only on a breaking wire change, whereas the document
> revises whenever the specification is clarified or extended. v4 extends `down/config` and
> `up/ack` with fields that were absent in v3; an edge running v3 firmware still parses a v4
> `down/config` correctly, because the added fields are additive and the removed one
> (`cfg`) is replaced by a string carrying identical content — see §3.6.
>
> | Implementation | Role |
> |---|---|
> | ESP32 firmware (Phase 02–03) | publishes telemetry, consumes config, enforces the safety envelope, **verifies approval signatures** |
> | MQTT→DB bridge (Phase 04d) | consumes everything, writes to Postgres. Read-only: never publishes |
> | REST backend (Phase 05a) | publishes config and commands, computes and verifies the canonical hash |
> | Browser (Phase 05b) | computes the canonical hash and signs it |
> | Mock edge simulator (Step 04c) | stands in for the ESP32 until firmware exists |

> **What changed in v4, in one paragraph.** The ESP32 can now verify the threshold approval
> signatures on a configuration before applying it. In v3 it could not, which meant the
> cryptographic chain of custody ended at the backend service: anyone holding the
> `sdigf-backend` broker credential could publish an arbitrary config and the edge would apply it
> if the values were physically safe. v4 closes that gap by publishing the exact canonical string
> alongside its hash and signatures, so the edge verifies over bytes it was handed and needs no
> canonicalization logic of its own. Firmware implementation is a Phase 03 deliverable and may or
> may not ship; the fields are reserved now because 05b's key storage depends on them and
> retrofitting a frozen contract afterwards is far more expensive than reserving space today.

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
sdigf/v1/gh1/down/keys         server → ESP32  (RESERVED — see §3.8)
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
| `down/config` | 1 | **yes** | The reconnect design depends on this. See the retention caveat below. |
| `down/cmd` | 1 | no | An event with a TTL. Retaining it would re-fire on every reconnect. |
| `down/keys` | 1 | **yes** | Reserved. Current state — a device must receive the trusted key list on connect without the server detecting the reconnection. |

> **⚠ Retention caveat — corrected 2026-08-25.** An earlier revision of this table claimed
> retention was verified across a broker restart. **It was not.** Only *client* reconnect had been
> tested. When the broker restart was finally tested on 2026-08-25 it **failed**: EMQX defaults
> `retainer.backend.storage_type` to `ram`, so retained messages were held in memory only and
> destroyed on restart. Fixed by setting `disc`, and re-verified by publishing a retained message,
> restarting the broker, and confirming survival.
>
> The deeper point outlives the setting: **retained messages are broker-held state, and broker
> state is not durable by default.** The server must therefore be able to reconstruct every
> retained topic from its own database. Phase 05a republishes the current approved config on
> startup and on broker reconnect, treating the retained message as a cache rather than a source
> of truth. This is the same reasoning as the edge safety envelope — do not assume infrastructure
> you do not control got it right.

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
  "cfg": {"ver": 7, "hash": "9f2c…a1", "src": "mqtt", "verify": "enforced"},
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
| `cfg.verify` | string | `enforced` \| `unsupported`. **Declared by the device, never supplied by the server** — see §3.4. |
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
  "ref": {"ver": 8, "hash": "d5ae…fbf0"},
  "result": "accepted",
  "applied": {"ver": 8, "hash": "d5ae…fbf0"},
  "verify": "enforced",
  "verified_by": ["eng-a1b2c3d4", "eng-e5f6a7b8"],
  "reason": null
}
```

Rejected:

```json
{
  "v": 1,
  "ts": 1756036800,
  "tsq": "ntp",
  "seq": 144,
  "ref": {"ver": 9, "hash": "aaaa…"},
  "result": "rejected",
  "applied": {"ver": 8, "hash": "d5ae…fbf0"},
  "verify": "enforced",
  "verified_by": [],
  "reason": {
    "code": "SIG_THRESHOLD_NOT_MET",
    "field": null,
    "detail": "1 valid signature of 2 required"
  }
}
```

| Field | Meaning |
|---|---|
| `ref` | Version and hash of the config **received** |
| `result` | `accepted` \| `rejected` |
| `applied` | Version and hash **now running**. On rejection this is the *previous* config — the edge never ends up running nothing. |
| `verify` | `enforced` \| `unsupported`. What the device actually did. See below. |
| `verified_by` | `key_id`s whose signatures verified. Empty on rejection, and empty when `verify` is `unsupported`. |
| `reason` | `null` when accepted; otherwise a structured object |

#### Rejection codes

| Code | Meaning |
|---|---|
| `ENVELOPE` | Violates a hardcoded equipment limit. **Non-negotiable regardless of provenance.** |
| `NOT_NEWER` | `ver` ≤ currently running version |
| `PARSE` | Malformed JSON, or missing required field |
| `SCHEMA` | Unsupported `v` (schema version) |
| `HASH_MISMATCH` | `cfg_hash` does not match SHA-256 of the `cfg_canonical` bytes |
| `SIG_INVALID` | A signature failed verification |
| `SIG_THRESHOLD_NOT_MET` | Fewer valid signatures than the device requires |
| `KEY_UNKNOWN` | A `key_id` is absent from the device's trusted key set |
| `VER_STALE` | `ver` ≤ applied, **or** the envelope `ver`/`gh` disagree with the signed copies |

> `HASH_MISMATCH` was removed in v3 because the edge did not recompute the hash. **It returns in
> v4**, along with the four signature-related codes, because the edge now verifies — see §5.

#### `verify` — declared by the device, never by the server

Firmware signature verification is a Phase 03 deliverable and may not ship. The contract must
therefore specify what a device does when it can parse a config but cannot verify it, and both
the firmware and the mock must behave identically.

The dangerous answer would be a server-supplied flag saying whether to verify. A server that can
switch verification off defeats the entire amendment, because the server is precisely the party
this is defending against.

**So the device declares its own capability.** `verify` appears in every `up/ack` and in
`up/health` under `cfg`:

| Value | Meaning |
|---|---|
| `enforced` | Signatures were verified and the threshold was met. This config is cryptographically bound to its approvers. |
| `unsupported` | Firmware has no verification. The config was applied on safety-envelope grounds alone — exactly the v3 behaviour. |

A device reporting `unsupported` still applies configs that clear the envelope. It does not fail
closed, because failing closed would mean an unverifying device ignores every configuration ever
sent to it.

**Why this matters beyond the mechanism.** The ledger and the event log now distinguish *approved
and verified at the actuator* from *approved, applied unverified* — as recorded fact, per config,
rather than as a claim in the thesis text. If Phase 03 verification ships late, the dataset itself
shows the exact configuration at which the guarantee began to hold. If it never ships, the record
says so plainly instead of implying a property the hardware never had.

Phase 05a surfaces this on the dashboard, so an operator can see whether verification is active on
the device rather than assuming it.

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
  "gh": "gh1",
  "ver": 8,
  "alg": "es256",
  "keys_ver": 3,
  "cfg_hash": "d5aebb09ecf07ad61c7accb9eb78d160d65e5ffd1c118d893fb300f140e1fbf0",
  "cfg_canonical": "{\"cfg\":{\"arb_a\":{…}},\"gh\":\"gh1\",\"ver\":8}",
  "sigs": [
    {"key_id": "eng-a1b2c3d4", "sig": "8106949b…54adb64d"},
    {"key_id": "eng-e5f6a7b8", "sig": "2f71c0ad…9b3e1102"}
  ]
}
```

| Field | Meaning |
|---|---|
| `gh` | Greenhouse ID. **Envelope copy for server convenience.** The authoritative value is inside `cfg_canonical`. |
| `ver` | Monotonic config version. **Envelope copy** — authoritative value is inside `cfg_canonical`. Also serves as replay protection: see below. |
| `alg` | Signature algorithm. `es256` (ECDSA P-256 + SHA-256). Present so a future algorithm change is a contract-visible event rather than a silent reinterpretation of 64 bytes. |
| `keys_ver` | Version of the trusted key list these signatures were made under. Turns a bare verification failure into a diagnosable `KEY_UNKNOWN`. |
| `cfg_hash` | SHA-256 of the **UTF-8 bytes of `cfg_canonical`**, lowercase hex. Not of a re-serialization. |
| `cfg_canonical` | The exact canonical string that was signed, JSON-escaped as a string value. **Replaces `cfg`.** |
| `sigs` | Threshold approval signatures over `cfg_hash`. See §5 for the wire format. |

#### The signed content, and why `ver` moved inside it

The signed string is the canonical serialization of:

```json
{"cfg": { … see §4 … }, "gh": "gh1", "ver": 8}
```

In v3 the hash covered `cfg` alone, with `ver` sitting unsigned in the envelope. **That was
exploitable.** An administrator could take any legitimately signed config, republish it with
`ver` set to `99`, and the edge would accept it — the signatures are genuine and the version is
strictly greater. The device is then pinned: every subsequent legitimate config at version 9, 10,
11 is rejected as stale. A downgrade-and-lock attack requiring no forged signature at all.

Binding `gh` closes the matching cross-device replay: a config approved for one greenhouse cannot
be replayed onto another once a `gh2` exists.

**The envelope copies are convenience, not authority.** The server reads `ver` and `gh` from the
envelope without parsing the canonical string. **The edge MUST compare envelope against signed and
reject on any disagreement** with `VER_STALE`. Without that comparison the envelope copies would
reintroduce exactly the hole they were moved to close.

#### Why `cfg_canonical` replaces `cfg`

v3 carried the config as a JSON object. v4 carries the canonical string instead, and does **not**
carry both.

**The edge needs no canonicalization logic.** It hashes the bytes it was handed and verifies
signatures over that hash. It never re-serializes. This is the specific reason edge verification
became affordable: the v3 exclusion rested partly on avoiding a fourth byte-identical canonical
serializer, this time in C, which is exactly where drift bugs breed. Publishing the string removes
that requirement entirely. The edge parses the same string separately for the values it needs, but
the hash is always over bytes it received.

**Carrying both would be worse, not friendlier.** Measured on a fully-populated config, shipping
`cfg` alongside `cfg_canonical` costs 1,698 bytes against 1,230 — 38% larger — and creates a
failure class the contract would then have to adjudicate: if the two disagree, which is
authoritative? One representation has no such question. The canonical string is itself valid JSON,
so nothing is lost.

#### Payload size and the ESP32 receive buffer

| Signatures | `down/config` size |
|---|---|
| 1 | 1,067 B |
| 2 | 1,230 B |
| 3 | 1,393 B |
| 4 | 1,556 B |

**PubSubClient's default `MQTT_MAX_PACKET_SIZE` is 256 bytes.** A payload above it is dropped with
no error, no callback and no disconnect — the config simply never arrives, and the device looks
like it is ignoring the server. Firmware **must** call `setBufferSize(2048)` before `connect()`.

Maximum expected payload: **1,600 bytes at four signatures.** EMQX's `max_payload_size` for
retained messages is 1 MB, so the broker side needs no change.

**Retained is essential**, subject to the durability caveat in §1: a reconnecting ESP32 receives
the current config immediately without the server having to detect the reconnection and re-push.

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

### 3.8 `down/keys` — QoS 1, **retained** — RESERVED, NOT YET SPECIFIED

The topic is reserved in v4. Its payload is deliberately **not** fully specified: full key
management is Phase 03 work, and over-specifying it now would freeze decisions that depend on
firmware constraints not yet known.

What *is* fixed is the requirement, because it determines whether any of §5 means anything.

#### The problem this topic exists to solve

Signature verification is the easy half. The hard half is getting *trusted public keys* onto the
device in the first place.

If the engineers' public keys arrive over MQTT from the server, then an administrator who can
publish config can also publish a key list containing their own key — and the gap this entire
amendment closes simply moves one step upstream. Verification against attacker-supplied keys is
theatre.

#### The requirement

`down/keys` carries a list of trusted engineer public keys, **signed by a device-held root key
burned in at flash time**. The device trusts the root key because it was physically present at
manufacture, not because anything told it to over the network.

This gives the two properties that matter:

- **Rotation and revocation are possible.** A new key list is accepted only if signed by something
  the device already trusts — in the simplest form, the root key itself.
- **The server cannot mint approvers.** Publishing a key list is not sufficient; signing it is,
  and the server does not hold the root key.

#### Bootstrap

First boot, before any engineer key exists, requires a **factory-default configuration profile
signed by the root key** — otherwise a device with an empty trusted set can accept nothing and is
inert on arrival. The factory profile is deliberately conservative: it must clear the safety
envelope by construction, since there is no operator present to correct it.

#### What is deliberately left open

Root key custody and escrow. Recovery when the root key is lost. Whether revocation is a full list
replacement or an incremental delta. Whether `keys_ver` is monotonic per device or global. All are
Phase 03 decisions requiring firmware and hardware context that does not exist yet.

**Recorded now so the requirement is not discovered late.** A device that ships without a root key
cannot be retrofitted with one over the air — that is the entire point of a root of trust — so the
decision to reserve this topic has to precede firmware flashing, not follow it.

---

## 4. Config payload structure

This is the `cfg` object. It is what the engineer edits, and it sits nested inside the signed
object `{"cfg": {…}, "gh": …, "ver": …}` whose canonical serialization is published as
`cfg_canonical` in `down/config` — see §3.6. The browser signs that canonical string; the ESP32
parses it and validates these values against its safety envelope.

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
| Browser (WebCrypto) | canonicalizes the signed object, hashes it, signs the hash |
| Server (Node.js) | recomputes independently, verifies signatures, stores hash and canonical string |
| Ledger | records the hash and signatures |
| **ESP32** | **hashes the received `cfg_canonical` bytes and verifies signatures over that hash** |

**This reverses v3.** The v3 contract excluded the edge from hashing, and the reasoning was sound
on its own terms: recomputing a hash over a *re-serialized* config catches transit corruption and
nothing else, because config and hash arrive from the same party — anyone able to alter one can
alter the other. It was an integrity check dressed as an authenticity check. Worse, it would have
required a fourth byte-identical canonical serializer, in C, which is where drift bugs breed.

**What changed is not the risk assessment but the mechanism.** Publishing `cfg_canonical` means
the edge hashes bytes it was handed rather than bytes it reconstructed. No canonicalization logic
ships to the device. And because signatures are verified against *device-held* public keys rather
than anything in the message, the check becomes genuinely authenticating: altering the config
requires forging a signature, not merely recomputing a hash.

The cost that remains is real but bounded — one ECDSA verification per signature per config
change, on a device that changes config rarely.

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

**Two gates, and they are not interchangeable.** Signature verification proves *who approved
this*. The safety envelope proves *this is physically sensible*. A correctly signed configuration
from a valid quorum that would flood the enclosure is still rejected, and an envelope-clearing
configuration from an unknown key is still rejected. Neither substitutes for the other, and v4
does not weaken the envelope in any respect.

**What the amendment closes.** In v3 the M-of-N approval guarantee terminated at the backend
service rather than at the actuator: anyone holding the `sdigf-backend` credential, or anyone who
compromised that service, could publish an arbitrary configuration and the edge would apply it
provided it cleared the safety envelope. The chain of custody broke at the broker.

With edge verification the chain reaches the actuator. The claim moves from *"we keep an
unforgeable record of who approved what"* to *"the device will not act on a configuration lacking
threshold approval."* That is a materially stronger statement, and it is the one the Zero Trust
pillar actually requires — Zero Trust means verify explicitly, and v3 explicitly did not.

**What it does not close, stated plainly.** Three gaps remain, and none should be glossed:

1. **The key distribution problem is deferred, not solved.** Verification is only as good as the
   trusted key set, and §3.8 reserves the mechanism without specifying it. Until `down/keys` and a
   device-held root key ship, the device's trusted set is provisioned by whatever process Phase 03
   adopts — and if that process is "the server sends them," the gap has moved rather than closed.
2. **Firmware may not ship.** The fields are reserved; the implementation is Phase 03 work. A
   device reporting `verify: "unsupported"` behaves exactly as v3 did. The contract makes this
   visible in the record rather than assumed.
3. **Ledger history remains deletable by a database administrator.** Signature verification says
   nothing about what happens to the record afterwards. An administrator with full database access
   can delete ledger rows and re-chain the remainder consistently — the chain will verify, because
   it was rebuilt by someone who could compute hashes. External anchoring of the chain head is the
   only defence and remains future work.

And the Oracle Problem is untouched by any of this: no signature, ledger or verification scheme
can establish that a sensor reported honestly. They establish only the integrity of what was
written.

### Signature wire format

**This subsection exists because getting it wrong produces a failure that looks like a firmware
bug and is not.**

WebCrypto's ECDSA implementation emits raw `r‖s` — 64 bytes, IEEE P1363, fixed length. mbedTLS's
`mbedtls_ecdsa_read_signature` expects ASN.1 DER. **These are not interchangeable.** A signature
that verifies in Node and in the browser will fail silently on the ESP32 if handed over unchanged.

**The wire format is raw `r‖s`, 64 bytes, lowercase hex, 128 characters.** It is what the browser
produces natively, it is fixed length, and it needs no parser. **Firmware converts to DER
immediately before calling mbedTLS** — the conversion belongs on the device, not on the wire.

DER encodes `r` and `s` as signed integers. When the leading byte of either is ≥ `0x80` it must be
prefixed with `0x00`, or mbedTLS reads it as negative and verification fails. Total DER length is
therefore 70–72 bytes depending on how many components need padding, and can be shorter still if
either has leading zero bytes, which DER strips. **Firmware must not assume a fixed DER length.**

**ECDSA P-256 signatures are non-deterministic.** The same configuration signed twice by the same
key produces different bytes, because a fresh random nonce is used each time. Therefore:

> **Deduplication and signer identity key on `key_id` only, never on signature equality.**

Two different signatures from the same `key_id` over the same `cfg_hash` are one approval, not
two. Counting them as two would inflate an M-of-N quorum — a re-signature by a single engineer
could satisfy a two-of-three threshold alone.

### Why ECDSA P-256 rather than Ed25519

Ed25519 is the better primitive in isolation: deterministic, one signature format, no malleability
footgun. It was not chosen, for one decisive reason and one supporting one.

**mbedTLS does not implement Ed25519.** The PSA crypto API defines `PSA_ALG_PURE_EDDSA`
constants, but Mbed TLS documentation states plainly that Edwards curves are not supported, and
the implementation issue has been open since 2020. Ed25519 on an ESP32 therefore means adding
libsodium — a first-class component under ESP-IDF, but not bundled with the Arduino ESP32
framework this project uses. The ESP32 is both the constrained party and the one doing the
verifying, and P-256 is already in its toolchain with big-integer hardware acceleration behind it.

**Browser support for Ed25519 is recent.** It reached all major engines only with Chrome 137 in
May 2025, following Firefox 129 and Safari 17. P-256 has been in WebCrypto for a decade. For a
system whose signing surface is a browser, the older and more universally supported curve is the
safer end of the choice.

**The costs accepted, in exchange:** the raw-vs-DER conversion above, mandating low-`s`
normalization to avoid malleability, and non-determinism. All three are specified rather than
discovered.

**Revisit if Phase 02/03 migrates to ESP-IDF**, where libsodium is available and both costs
disappear. The `alg` field in `down/config` exists so that migration is a contract-visible change
rather than a silent reinterpretation of 64 bytes.

### Statement for the thesis

> Configuration changes are approved by an M-of-N threshold of engineer signatures, computed in
> the browser over a canonical serialization that binds the configuration to its version and its
> target device. The server verifies independently and records hash and signatures in the ledger.
> The edge verifies the same signatures against public keys it holds locally, hashing the
> canonical string it received rather than re-serializing — which removes any need for
> canonicalization logic on the device and eliminates the drift risk that a fourth independent
> serializer would introduce. The approval guarantee therefore extends to the actuator rather than
> terminating at the backend service.
>
> Independently of provenance, the edge enforces a safety envelope derived from equipment limits.
> These are complementary and non-substitutable gates: signatures establish *who may change
> things*, the envelope establishes *what values are physically permissible*, and the envelope
> holds even when a correctly-approved configuration is wrong.
>
> Two limitations are stated rather than implied. Trusted key distribution to the device depends
> on a device-held root key provisioned at manufacture; the mechanism is reserved in the contract
> but its implementation is future work, and until it ships the trust anchor is provisional.
> Separately, an administrator with full database access can delete ledger history and re-chain
> the remainder consistently; external anchoring of the chain head is the only defence and is not
> implemented. Neither signature verification nor the ledger addresses the Oracle Problem: no
> scheme establishes that a sensor reported honestly, only that what was written was not
> subsequently altered.

### Canonicalization rules

**Applied to the signed object** — `{"cfg": {…}, "gh": …, "ver": …}` — never to the transport
envelope. `ts`, `v`, `alg`, `keys_ver` and `sigs` are transport metadata and must not affect the
signed value; otherwise re-publishing an unchanged configuration would produce a different hash
and invalidate every signature over it.

The rules themselves are **unchanged from v3**. Only the scope of what they are applied to has
widened, per §3.6.

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

### Test vector 2 — ECDSA P-256 wire format

**Frozen 2026-08-25.** This vector exists to catch the raw-vs-DER conversion error described
above, and is deliberately chosen so that `r` has its high bit set — the case that breaks naive
converters.

The keypair below is a **test fixture and must never be used in production.** The private scalar
is published here precisely so the vector is reproducible.

```
private scalar d (test fixture only)
  0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20

public key, uncompressed 65 bytes (0x04 ‖ X ‖ Y) — the form the ESP32 stores
  04515c3d6eb9e396b904d3feca7f54fdcd0cc1e997bf375dca515ad0a6c3b4035f
    4536be3a50f318fbf9a5475902a221502bef0d57e08c53b2cc0a56f17d9f9354

message signed — the cfg_hash, 32 bytes
  d5aebb09ecf07ad61c7accb9eb78d160d65e5ffd1c118d893fb300f140e1fbf0
```

**Wire format — raw `r‖s`, 64 bytes.** This is what appears in `sigs[].sig`:

```
8106949b3796d38f882a6ce174cc1f6d8ae2b2a27535bfa211e1b36c873be53b
757e61f5a1dd73e1589587ed7314cfffa623a901f85af1794d5e6a9654adb64d
```

**The same signature as ASN.1 DER, 71 bytes** — what mbedTLS must receive after conversion:

```
3045
  022100 8106949b…873be53b     ← 0x21 = 33 bytes: r is 32 bytes PLUS a leading
                                   0x00, because r[0] = 0x81 has the high bit set
  0220   757e61f5…54adb64d     ← 0x20 = 32 bytes: s[0] = 0x75, no padding needed
```

**What it exercises.** Byte-exact wire format; the DER zero-padding rule on `r`; the absence of
padding on `s`; and the resulting asymmetric 71-byte length that proves DER is not fixed-size.

A converter that omits the `0x00` produces a signature mbedTLS reads as a negative integer and
rejects — while the identical bytes verify correctly in Node and the browser. That divergence is
the single most expensive bug available in this design, and this vector is the cheapest way to
find it.

Because P-256 signing is non-deterministic, re-signing this message will *not* reproduce these
bytes. That is expected. Verification against the fixed public key is what must reproduce.

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
| **2026-08-25** | **v3 → v4: edge-side signature verification amendment. Entries below.** |
| 2026-08-25 | §3.6: `cfg_canonical` added and **replaces** `cfg` — the edge hashes received bytes and needs no canonicalization logic. Carrying both was measured 38% larger and would create an ambiguity over which representation is authoritative |
| 2026-08-25 | §3.6: signed content widened to `{cfg, gh, ver}`. **`ver` was unsigned in v3, which allowed a validly-signed old config to be replayed at a bumped version and pin the device against all future configs.** `gh` binds the target device against cross-device replay |
| 2026-08-25 | §3.6: `alg`, `keys_ver` added; envelope `ver`/`gh` documented as convenience copies the edge MUST check against the signed values |
| 2026-08-25 | §3.6: payload sizing measured (1,067–1,556 B for 1–4 signatures) and `setBufferSize(2048)` mandated — PubSubClient's 256-byte default drops the message silently |
| 2026-08-25 | §3.4: `HASH_MISMATCH` reinstated; `SIG_INVALID`, `SIG_THRESHOLD_NOT_MET`, `KEY_UNKNOWN`, `VER_STALE` added |
| 2026-08-25 | §3.4 / §3.3: `verify` and `verified_by` added, **declared by the device and never settable by the server** — a server-supplied flag could be switched off by the adversary it defends against |
| 2026-08-25 | §5: ECDSA P-256 selected. mbedTLS has no Ed25519 implementation, and browser Ed25519 support dates only to 2025 |
| 2026-08-25 | §5: signature wire format fixed at raw `r‖s` 64-byte hex, with DER conversion specified as a firmware-side step; non-determinism documented and dedup keyed on `key_id` |
| 2026-08-25 | §5: test vector 2 added — frozen P-256 vector exercising the DER zero-padding case |
| 2026-08-25 | §5: canonicalization scope widened from `cfg` to the signed object; the rules themselves unchanged |
| 2026-08-25 | §5: trust-model section rewritten. Residual gaps stated explicitly — deferred key distribution, firmware that may not ship, and administrator-deletable ledger history |
| 2026-08-25 | §3.8: `down/keys` reserved — signed key list under a device-held root key, with the bootstrap case noted. Deliberately not fully specified |
| 2026-08-25 | §1: **correction** — the claim that retention was verified across a broker restart was false. Tested 2026-08-25 and it failed; EMQX defaulted the retainer to `ram`. Fixed to `disc` and re-verified |

---

## 7. What v4 does not change

Stated explicitly, because an amendment touching the trust model invites the assumption that more
moved than did.

- **The safety envelope is untouched and remains mandatory.** Signature verification does not
  replace it, weaken it, or gate it. A correctly signed configuration that violates an equipment
  limit is still rejected with `ENVELOPE`.
- **The bridge stays read-only.** It never subscribes to `down/config`, `down/cmd` or `down/keys`,
  and publishes nothing.
- **`up/telemetry`, `up/actuators` and `status` payloads are unchanged.** `up/health` gains one
  field (`cfg.verify`); `up/ack` gains two.
- **Canonicalization rules are unchanged** — recursive key sorting, no whitespace, integers only,
  lowercase booleans, nulls included, array order preserved, SHA-256 lowercase hex. Only the scope
  of application widened.
- **Deci-Celsius integers and the `_dc` convention are unchanged.**
- **Test vector 1 and its digest `911a7250…a908` are unchanged and still binding.**
- **The topic namespace remains `sdigf/v1/`** and the envelope `v` remains `1`.

---

*Parts 1–4 complete, edge verification amendment applied. Frozen for Step 04c (mock simulator),
Phase 04d (bridge and schema), Phase 05a/05b (backend and signing) and Phase 03 (firmware).*
