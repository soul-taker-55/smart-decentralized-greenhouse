# SDIGF Bridge — Phase 04d

Subscribes to the edge→server MQTT topics and writes what arrives into TimescaleDB.

Consumes the frozen contract at `Phase_04_Logging/4b_contracts/mqtt_contract_v3.md`.
Writes into the schema at `Phase_04_Logging/db/sdigf-db-schema-v2.sql`.

---

## What it is, and what it deliberately is not

The bridge is a **read-only observer of the edge**. It subscribes; it writes to Postgres;
it publishes nothing. It does not subscribe to `down/config` or `down/cmd`, and the
`sdigf-bridge` broker credential should not be granted publish rights on them.

Command publication belongs to the Phase 05a service layer. Keeping that line clean is
what makes it possible to say the logging tier has no path to an actuator — not as a
policy that could be relaxed, but as an absence of code.

The bridge is also **not in the control path**. If this process dies, the greenhouse keeps
running: the edge tier is autonomous by design and the only thing lost is the record. That
is the whole point of the tier split, and it is worth stating in the thesis in exactly
those terms.

---

## Topics

| Topic | QoS | Destination |
|---|---|---|
| `sdigf/v1/gh1/up/telemetry` | 0 | `telemetry` — 11 rows per message |
| `sdigf/v1/gh1/up/actuators` | 1 | `actuator_state` — 8 rows per message |
| `sdigf/v1/gh1/up/health` | 0 | `edge_events` — `HEALTH`, plus `REBOOT` when inferred |
| `sdigf/v1/gh1/up/ack` | 1 | `edge_events` — `ACK`, plus `CONFIG_APPLIED` when accepted |
| `sdigf/v1/gh1/status` | 1 | `edge_events` — `ONLINE` / `OFFLINE` |

Note that `status` sits at the root of the greenhouse tree, not under `up/`.

---

## Design decisions

### Time

`time` is **always the bridge's receipt time**. The device's own clock is preserved in
`device_ts`, and `ts_quality` records whether that clock was NTP-synced or boot-relative —
but neither drives the time axis.

The alternative, using the device clock when it is trustworthy and receipt time otherwise,
is more faithful to when a reading was taken. It was rejected because it produces a time
column whose meaning changes depending on a flag in another column. Any aggregate spanning
a reboot would silently mix two different notions of "when", and nothing in the query would
reveal it. One axis, one meaning, with the raw device value retained for anyone who wants
to reconstruct the other view.

All rows produced by a single message share one receipt timestamp, taken once.

### Deduplication

The contract requires uniqueness on `(greenhouse_id, seq, sensor_name)`. The schema's
unique index is on `(time, greenhouse_id, sensor_name, seq)` — TimescaleDB requires the
partitioning column in any unique index, so `time` cannot be left out.

**Those two are not the same guarantee.** Because `time` is receipt time, a QoS 1
redelivery arrives at a different instant and produces a different index key. The database
constraint would not catch it.

So the bridge checks explicitly before writing: has this `(greenhouse_id, seq)` already
been recorded within `DEDUP_WINDOW_MIN` minutes? QoS 1 redelivery happens within seconds of
a reconnect, so a 60-minute window is generous by orders of magnitude. The check is
DB-backed rather than in-memory, so it survives a bridge restart — which matters, because a
crash mid-processing is exactly when redelivery happens.

`ON CONFLICT DO NOTHING` remains on the insert as a second line of defence for the
exact-collision case.

> If this check ever shows up as slow, add:
> `CREATE INDEX ON telemetry (greenhouse_id, seq, time DESC);`
> At 30-second telemetry it is not close to mattering.

### Buffering and the bounded queue

MQTT delivery and database availability fail independently. Writes go into an in-memory
queue that drains in order, retrying with exponential backoff (1s → 30s cap).

The queue is **bounded** at `MAX_QUEUE_DEPTH`. When it fills, the oldest entry is discarded
and a counter increments. This is a deliberate trade: telemetry is QoS 0 and already
best-effort, so losing the oldest rows during a long outage is survivable, whereas an
unbounded queue turns a database outage into an OOM kill that loses everything *including*
the ability to recover. Drops are counted and logged rather than hidden.

Draining is strictly sequential. An `ONLINE` event followed by telemetry should land in
that order, and parallel writes would not guarantee it. Throughput is irrelevant at one
message per thirty seconds.

Constraint violations (Postgres error classes 22 and 23) are dropped rather than retried —
retrying a malformed row forever would wedge the queue behind one bad message.

### Persistent MQTT session

`clean: false` with a stable client ID. QoS 1 traffic — actuator state, acks, status — is
queued by the broker while the bridge restarts and delivered on reconnect. Telemetry is
QoS 0 and is not queued, which is the correct asymmetry: a gap in a 30-second sensor series
is recoverable from context, a missing `CONFIG_APPLIED` event is not.

### Validation before the write

The schema enforces the null rule with a CHECK constraint, so an invalid payload would be
rejected regardless. But it would be rejected as an opaque constraint violation at write
time, long after the context that would explain it is gone. Validating in the handler means
the log line names the sensor and the reason:

```
[error] [telemetry] rejected message: temp_in: q='fail' must carry val=null, got 0
```

A **missing** sensor is not treated as fatal — it is recorded as `init`, which is precisely
what "never successfully read" means, and the other ten readings are still evidence. An
**unrecognised** sensor is logged and ignored, so a firmware version that adds a sensor does
not stop the bridge writing the ones it understands.

### Reboot detection

The ESP32 cannot announce a reboot it has not yet booted from. The only available signal is
uptime going backwards between two health messages. When that happens the bridge writes a
distinct `REBOOT` row.

This matters because `boot_reason = brownout` is the documented signature of a stalled
canopy servo or an ESP32-CAM inrush on the shared 5 V rail, and `cfg_src = nvs` on the same
row is direct evidence of edge autonomy — the device restarted with no broker and resumed
from last-known-good config. Both would otherwise be buried inside a routine `HEALTH` row
among hundreds.

### Known omissions

`canopy.target` and `canopy.moving` are **not stored** — the schema has no column for them.
Both are transient: `moving` is true for under a second per adjustment, and `target` equals
`pos` except during that window. Neither answers a Phase 04 conflict question. Recorded here
so the omission is a decision on the record rather than something to rediscover later.

`vent` is stamped onto every row of a message rather than stored once. This is
denormalisation, and it is intentional: `vent` is derivable from the fan states, but the
contract publishes it because it is the value the control policy actually acted on. A
conflict query asking *what stage were we at when the humidifier was suppressed* should not
have to re-derive the policy's reasoning from its own outputs.

---

## Deployment

Separate Dokploy stack, same pattern as `sdigf-mock`.

Environment variables — set in Dokploy's environment tab, never committed:

```
MQTT_HOST=<broker host on dokploy-network>
MQTT_PORT=1883
MQTT_USER=sdigf-bridge
MQTT_PASS=<secret>

PG_HOST=<db service name on dokploy-network>
PG_PORT=5432
PG_USER=postgres
PG_PASS=<secret>
PG_DB=sdigf_db

GH_ID=gh1
LOG_LEVEL=info
MAX_QUEUE_DEPTH=5000
DEDUP_WINDOW_MIN=60
```

Use the **`sdigf-bridge`** credential, not `sdigf-edge` or `sdigf-admin`.

The bridge verifies the database is reachable and the schema is present *before* connecting
to the broker. Connecting to MQTT first would mean buffering messages it may have no ability
to store, and a wrong password would surface minutes later as a queue-depth warning rather
than immediately as what it is.

---

## Verifying it works

```sql
-- Is anything arriving?
SELECT count(*), max(time) FROM telemetry;

-- All eleven sensors, most recent message
SELECT sensor_name, value, unit, quality_flag
FROM telemetry
WHERE seq = (SELECT max(seq) FROM telemetry)
ORDER BY sensor_name;

-- Any duplicates? Should return zero rows.
SELECT greenhouse_id, seq, sensor_name, count(*)
FROM telemetry
GROUP BY 1,2,3 HAVING count(*) > 1;

-- Sensor health over the last day
SELECT sensor_name, quality_flag, count(*)
FROM telemetry
WHERE time > now() - interval '1 day'
GROUP BY 1,2 ORDER BY 1,2;

-- Connection and config history
SELECT time, event_type, boot_reason, cfg_src, cfg_ver
FROM edge_events
WHERE event_type IN ('ONLINE','OFFLINE','REBOOT','CONFIG_APPLIED')
ORDER BY time DESC LIMIT 20;
```

The bridge also logs a status line every five minutes:

```
[info] [bridge] status {"written":412,"duplicatesSkipped":3,"rejected":0,"dropped":0,"queueDepth":0}
```

---

## Testing performed

Verified against a live Mosquitto broker and a Postgres instance loaded with the real
schema, driven by the actual `4c_tool/mock-edge` simulator:

- 24 parser unit tests covering contract edge cases — null rule both directions, sentinel
  rejection, invalid quality flags, missing and unexpected sensors, out-of-range `vent` and
  `canopy.pos`, non-boolean `on`, invalid `src`, `ovr_s` present only when manual
- End-to-end: mock → broker → bridge → Postgres, 11 rows per telemetry message, 8 per
  actuator message, correct units and quality flags
- Retained `status` and `actuators` messages consumed on subscribe
- Duplicate suppression confirmed on a republished retained actuator message
- `ACK` accepted → `ACK` + `CONFIG_APPLIED` rows; rejected → `ACK` row and a warning
- Reboot inference from decreasing uptime, with `boot_reason=brownout` and `cfg_src=nvs`
  landing correctly
- Malformed JSON discarded without crashing
- Database stopped mid-run: 5 messages buffered, backoff 1s→2s→4s, all 55 rows recovered on
  restart, zero dropped
