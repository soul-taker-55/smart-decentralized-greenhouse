# The Configuration Path, End to End

**Phase 05a · verified on live infrastructure, 2026-08-26**

This section documents what happens when an operator changes a setting in the
greenhouse — from the moment a value is typed into a browser to the moment the
controller confirms it is running that value. It is written from an execution
that actually took place, not from design intent; the log excerpts are verbatim.

The path crosses four independent components — browser, backend service, message
broker, controller — and two databases. At each boundary something can be lost,
altered, or silently dropped. What follows is as much an account of how each of
those failures is detected as of how the happy path works.

---

## 1 · The shape of the problem

A configuration change in this system is not a write to a database. It is a
proposal that must survive being carried across an unreliable network to a
device that may be offline, may have rebooted, and must be able to refuse it.

Three constraints shape the whole design.

**The controller is authoritative about what it is running.** The server records
what it *sent*. Only the device knows what it *applied*, and the two can differ —
after a rejection, after a reboot, after a message that never arrived. Any claim
that "the hardware is running the approved configuration" is worthless unless the
hardware itself says so.

**The server is never in the life-critical path.** If the server disappears, the
controller keeps running the last configuration it accepted. Nothing in this
path may introduce a dependency that breaks that property.

**Approval is not the same as safety.** A configuration approved by the correct
people can still specify values that damage equipment. These are separate
questions, answered by separate components, and neither substitutes for the
other.

---

## 2 · Walking the path

### 2.1 Composition, and the first gate

The operator opens the configuration editor and fills in the values an
agriculture engineer supplies: temperature and humidity bands, watering
thresholds, the lighting schedule, and the two conflict-arbitration policies.

The editor works in human units. Temperature is typed as `26.0 °C`; lighting
times are chosen on a clock control. On the wire, neither of those
representations survives — temperature becomes the integer `260` in
deci-Celsius, and `06:00` becomes the integer `360`, minutes from midnight. The
translation happens at the edge of the interface and nowhere else.

This is not cosmetic. Floating-point numbers have no single textual form across
languages: JavaScript renders `1.0` as `1`, C renders it as `1.000000`. Since
the configuration is later hashed and that hash must be recomputed identically on
an ESP32, a float anywhere in the payload would produce a different hash on each
side of the link, and every configuration would be rejected as corrupt. Integers
are used throughout for that reason alone.

The backend validates every field on receipt. It does not trust the browser,
because the browser is not the only possible client — the same endpoint is
reached by the automation interface in a later phase.

The validator enforces structure and physics only. It rejects a float where an
integer is required, a percentage above 100, a ventilation stage above 3 (there
are three fans), and a temperature outside the range the BMP280 sensor can
report. It also rejects incoherent combinations: a watering *start* threshold at
or above the *stop* threshold, which describes a pump that can never reach its
stop condition.

It does **not** reject a configuration for being agronomically unusual. A 45 °C
ceiling with a 5 % humidity floor is accepted, and the test suite asserts that it
is. Deciding what a crop needs is the agriculture engineer's role; the system's
stated scope is to *accept expert-supplied configuration rather than determine
optimal growing conditions*, and a validator quietly overruling the expert would
contradict that at the first opportunity.

Errors return with a dotted field path — `pump.soil_start_pct` — matching the
path the controller uses in its own rejection messages. One renderer handles
both, and an operator sees the same identifier whether the server or the hardware
refused the value.

### 2.2 Canonicalisation, and why the exact bytes matter

A validated configuration is serialised into a **canonical form**: object keys
sorted recursively, no whitespace, arrays left in their original order, nulls
retained.

Array order is preserved deliberately. `vent.stage_offsets_dc` is `[0, 20, 40]` —
the temperature offsets at which the first, second and third fan engage. Sorting
that array would silently reassign which fan runs when.

The canonical string is hashed with SHA-256. Both the string and its hash are
stored alongside the configuration, and **the stored string is what gets
published** — not a re-serialisation of the parsed object.

This is the single most consequential decision in the path. Because the exact
byte sequence travels on the wire, the controller can verify integrity by hashing
what it received, and needs no canonicalisation logic of its own. A second
implementation of that logic on an 8-bit-friendly microcontroller, in a different
language, would be a permanent source of subtle divergence. There is exactly one
canonicaliser in the system, and it is checked against a frozen test vector at
service startup:

```
{"a":[3,1,2],"b":{"x":1,"y":2},"c":null,"d":true}
→ 911a7250d4853dec84df401015ab201c6241ee1c87fb6e70862afd13e087a908
```

If that vector fails to reproduce, the service refuses to start. A drifted
canonicaliser produces hashes that look perfectly valid and that no device will
ever accept; failing loudly at boot is preferable to discovering it in the field.

### 2.3 The version lives inside the signed content

The hashed object is not the configuration alone. It is:

```json
{"cfg": { … }, "gh": "gh1", "ver": 2}
```

The greenhouse identifier and the version number are **inside** the hashed
content, not merely alongside it in the message envelope.

An earlier revision of the message contract hashed the configuration values
only. That left a hole: an administrator could take any legitimately approved
configuration, republish it unchanged with the version number raised to an
arbitrarily high value, and permanently pin a device against every future
update — using genuine approvals, with no forgery required. Moving the version
inside the hashed content closes it. Change the version, and the hash changes;
the old approval no longer covers it.

The message envelope still carries `ver` and `gh` as convenience copies, and the
controller compares them against the hashed originals. **A disagreement between
the two is itself the attack signature**, and is rejected.

### 2.4 Approval, and what it currently is not

The configuration moves through an explicit lifecycle:

```
DRAFT → PROPOSED → PARTIALLY_APPROVED → APPROVED → ACTIVE
        (+ REJECTED, EXPIRED, SUPERSEDED)
```

Nothing is published to the message broker before `APPROVED`. Exactly one
configuration may be `ACTIVE` per greenhouse, and that constraint is enforced by
a partial unique database index rather than by application logic — a service bug
that attempted to activate two configurations simultaneously would fail at the
database, not succeed silently.

**In this phase, approval is a placeholder.** It performs no signature
verification and no threshold counting. This is recorded rather than glossed:
the interface labels it as a placeholder, the API response returns
`"stub": true`, and every approval event written to the audit trail carries
`stub: true` in its detail. A later phase replaces the body of that function
without changing the endpoint, the lifecycle, or the event schema — and the audit
trail remains permanently able to distinguish a placeholder approval from a
cryptographically-backed one. That distinction matters for the tamper-evident log
in a subsequent phase, which must never be able to present the two as equivalent.

### 2.5 Publication, and why success is not believed

On activation the backend commits the state change to its database, then
publishes the configuration to the broker as a **retained** message.

The ordering is deliberate. The database transaction commits *before* the network
call. A broker timeout must not roll back an activation the operator has been
told succeeded; and because the server republishes from its own database on every
reconnection, a failed publication is recoverable rather than lost.

**The publish result is not trusted.** Under some broker access-control
configurations a *denied* publication is acknowledged and discarded — the client
sees success and the message never exists. That failure presents to an operator
as "the configuration was applied but the device never received it", and is
routinely misdiagnosed as a firmware fault.

The backend therefore subscribes to the topic it publishes to, and treats the
publication as complete only when the broker hands the message back. In the
execution documented here that read-back confirmed a 908-byte payload.

The payload size is checked before sending. The controller's MQTT library uses a
256-byte receive buffer by default and **discards oversized messages with no
error, no callback and no disconnection**. The backend refuses to send anything
above 2048 bytes rather than hand the device something it will silently drop.

### 2.6 The retained message is a cache, never the source of truth

The configuration is published *retained*, meaning the broker holds a copy and
delivers it immediately to any client that subscribes. This is how a controller
recovers its configuration after a power cut without the server needing to detect
the reconnection.

During Phase 04 the broker's retained-message store was found to be configured
for memory-only storage, so every retained message was destroyed on broker
restart. The setting was corrected — but the architectural conclusion outlives
the fix: **broker-held state is a convenience, and the database is authoritative.**

The backend republishes the active configuration on startup and on every
reconnection, reconstructing the broker's state from its own records. This was
verified by deleting the broker's entire retained store, confirming the
configuration was gone, restarting the backend, and observing it restored
unprompted. The system now survives that class of failure rather than depending
on a configuration flag to prevent it.

### 2.7 The controller decides

The controller receives the message and runs a fixed sequence. The order is not
arbitrary, and reordering it produces subtly wrong behaviour rather than obvious
failure.

| Step | Check | Why it is here and not later |
|---|---|---|
| 1 | Parse | Nothing can be checked on bytes that are not valid JSON |
| 2 | Schema version | An unsupported envelope means the fields below may not mean what this firmware assumes |
| 3 | **Integrity** | If the hash does not match the received bytes, *every* value is untrustworthy — including the version, so freshness cannot be assessed yet |
| 4 | Freshness | Reject a replay before spending effort validating values that may be an old configuration resent |
| 5 | **Safety envelope** | Only now, on a payload known intact and current, is it worth asking whether the values are survivable |
| 6 | Apply, then acknowledge | Acknowledge after applying, so an acknowledgement never claims something the device has not done |

Checking the safety envelope before the hash, for instance, would mean rejecting
a corrupted payload with a field-specific error — sending an operator hunting for
a configuration mistake that does not exist.

The integrity check hashes **the bytes as received**. It never re-serialises. The
canonical string is on the wire precisely so the device does not have to.

### 2.8 The safety envelope is an independent gate

The envelope enforces limits derived from the equipment, and it is the reason
approval and safety are separate questions.

Every bound traces to a component or to arithmetic: the sensor's datasheet range,
three fans giving four ventilation levels, the servo's stall current, the pump's
lack of a thermal cutout. No bound encodes a crop preference — that would place
agronomy inside firmware, where it cannot be changed without a reflash, and would
overrule the expert the system exists to serve.

A configuration that clears every server-side check can still be refused here.
The following were produced against the running controller:

```
[config] REJECTED ENVELOPE at pump.soil_start_pct — must be below
         pump.soil_stop_pct (60); the pump would never reach its stop
         condition (still running ver 1)

[config] REJECTED ENVELOPE at temp.max_dc — outside equipment limits
         -400..850, got 2000 (still running ver 1)

[config] REJECTED HASH_MISMATCH at cfg_hash — computed 78f18b9166ae632f…
         over the received bytes, envelope claims 0000000000000000…
         (still running ver 1)
```

Note the trailing clause on every line. **A rejected configuration leaves the
previous one in force.** The device never falls back to running nothing; a single
malformed message must not produce an unmanaged enclosure. The acknowledgement
schema encodes this by reporting the received version and the running version as
separate fields, which together let the server state both what was sent and what
is actually in force.

### 2.9 Acknowledgement closes the loop

On acceptance the controller adopts the configuration, stores it as its
last-known-good, and publishes an acknowledgement.

```
[config] ACCEPTED ver=1 hash=eeda43af408f…
[config] ACCEPTED ver=2 hash=32b295da93bf…
```

The dashboard's status bar then reports **Device running: v2** beside **Server
active: v2**. Those two figures come from different sources — one from the
server's own database, the other from what the hardware last reported — and their
agreement is the only evidence that the loop closed.

The acknowledgement also carries the device's **declared verification status**.
Cryptographic signature verification is firmware work in a later phase and the
simulator does not perform it, so the field reads `unsupported`. The dashboard
renders that as an outlined shield labelled *"Signature verification: not
active"* — never a green tick, never an alarm.

This field is declared by the device and can never be set by the server. A
server-supplied flag indicating whether to verify would be settable by precisely
the party that edge verification defends against. The consequence is that the
event log distinguishes *approved and verified at the actuator* from *approved,
applied unverified*, as recorded fact per configuration. If verification ships
late, the dataset shows the exact configuration at which the guarantee began to
hold. If it never ships, the record says so plainly rather than implying a
property the hardware never had.

---

## 3 · Two behaviours worth reading carefully

### 3.1 Repeated delivery is refused, and that is the design working

The controller's log contains many entries of this form:

```
[config] REJECTED NOT_NEWER at ver — received ver 1, already running
         ver 1 (still running ver 1)
```

These are not failures. Each is the controller re-reading the *retained*
configuration — on reconnection, or after the backend republished on startup. The
broker replays it faithfully every time, and the controller declines it because a
configuration already applied has nothing to add, and re-applying it would cancel
active manual overrides for no reason.

This is replay protection operating on ordinary traffic. On real hardware after a
power cut, the same mechanism is how the controller recovers its configuration
without the server detecting that it reconnected.

### 3.2 An unchanged configuration is still a new configuration

During the documented run, a second version was created by saving the existing
values unchanged. The interface reported *"Identical to what is running now."*
The controller nonetheless accepted it:

```
ver 1 → hash eeda43af408f…
ver 2 → hash 32b295da93bf…
```

Same values, different version, different hash — because the version is inside
the hashed content. The consequence shapes how rollback works.

**There is no path to re-activate a previous configuration.** The controller
would reject it as not newer, and it is right to: at the device, a legitimate
rollback and an attacker replaying an old configuration are indistinguishable.
Rolling back is therefore performed by *cloning* the earlier values into a new
version at the next number, which requires fresh approval. Lineage is recorded,
so the history remains legible.

This is correct on its own terms rather than a workaround. A rollback is a
decision about the present, not a replay of the past, and requiring it to be
approved as such is the honest treatment.

---

## 4 · What this execution demonstrates, and what it does not

**Demonstrated on live infrastructure:**

- The complete path from browser input to device acknowledgement, twice, with
  version advancement between the two
- Server-side validation rejecting malformed values with field-level precision
- Integrity verification catching a deliberately corrupted hash
- Replay protection refusing both a repeated version and a retained redelivery
- The safety envelope refusing configurations that passed every server-side check
- Recovery of broker state from the database after total retained-message loss
- Manual per-actuator overrides expiring on the device's own timer with no server
  involvement, and being cancelled immediately by a newly approved configuration

**Not demonstrated, and not claimed:**

- **Cryptographic approval.** Approval in this phase performs no signature
  verification. Every such event is marked as a placeholder in the audit trail.
- **Edge signature verification.** The controller declares `unsupported`, which
  is the accurate reading of its capability.
- **Real hardware.** The controller in this execution is a simulator standing in
  for the ESP32. It implements the decision logic — the same validate, apply,
  acknowledge sequence — but no physical actuator was switched, and no sensor
  reading originated from a physical sensor.
- **Autonomous control.** No threshold loop or conflict arbiter runs yet. The
  configuration is delivered, verified and stored; acting on it is firmware work.

The distinction in that last group matters for what may be claimed. What has been
built and shown is a **configuration delivery and verification path** that is
correct end to end, with each failure mode detected at the point where it can
still be attributed. What has not been shown is a greenhouse regulating itself.
The first is a precondition for the second, and is where the architectural
argument of this work actually lives.

---

## 5 · Reference

| | |
|---|---|
| Message contract | `Phase_04_Logging/4b_contracts/mqtt_contract_v4.md` |
| Backend and dashboard | `Phase_05_Backend_Dashboard/5a_web/` |
| Simulated controller | `Phase_04_Logging/4c_tool/mock-edge/` |
| Safety envelope | `4c_tool/mock-edge/src/safety.js` |
| Decision sequence | `4c_tool/mock-edge/src/handlers.js` |

The simulated controller's handling logic is written to serve as the reference
implementation for the firmware port. Its decision points are commented as
specification rather than as code commentary, for that reason.
