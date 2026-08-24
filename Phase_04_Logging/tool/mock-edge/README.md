# SDIGF Mock Edge Node

A stand-in for the ESP32. Publishes on the frozen MQTT contract
(`Contracts/mqtt_contract_v1.md`) so the entire server tier can be built,
tested, and demonstrated before firmware exists.

This is **not throwaway code**. It becomes the permanent test harness, the
regression suite, and the rehearsal target for the committee demonstration.
The control loop written here (Stage 2) is the reference implementation later
ported to firmware.

---

## Build stages

| Stage | Scope | Status |
|---|---|---|
| **1** | Connect, last will, telemetry, health, static actuator state | ✅ this release |
| 2 | Physics + control loop — actuators respond causally | planned |
| 3 | Config handling, safety envelope, acks | planned |
| 4 | Failure simulation, time acceleration, forced conditions | planned |

### What Stage 1 does

- Connects to EMQX with credentials and a **last will** on `status`
- Publishes `up/telemetry` every 10 s with all 11 readings, each carrying a
  quality flag, matching the contract exactly
- Publishes `up/health` every 60 s
- Publishes `up/actuators` once at connect (everything off — Stage 2 makes it real)
- Publishes retained `online` / `offline` on `status`
- Simulates ambient drift with bounded mean-reverting random walks, so charts
  and downsampling behave as they will in production

### What Stage 1 does *not* do

No physics linking actuators to conditions. No control loop. It does not
subscribe to `down/config` or `down/cmd`, and never sends an `up/ack`.
Soil moisture falls slowly and never recovers, because there is no pump yet.

---

## Deployment

Deployed as its **own Dokploy compose stack**, separate from `sdigf-server`, so
it can be stopped and started without touching the broker or database.

### 1. Create the stack

Dokploy → project `sdigf` → **Docker Compose** → Create

| Field | Value |
|---|---|
| Name | `sdigf-mock` |
| Provider | GitHub |
| Repository | `smart-decentralized-greenhouse` |
| Branch | `main` |
| Compose Path | `Tools/mock-edge/docker-compose.yml` |
| Watch Paths | `Tools/mock-edge/**` |

### 2. Environment variables

| Name | Value |
|---|---|
| `MQTT_HOST` | `sdigf-emqx` — the container name on `dokploy-network`, not the public domain |
| `MQTT_PORT` | `1883` |
| `MQTT_USER` | `sdigf-edge` |
| `MQTT_PASS` | the password set for `sdigf-edge` in EMQX |

Using the internal container name keeps mock traffic off the public interface
entirely. If the container name differs, take it from `docker ps`.

### 3. Deploy

Dokploy builds the image and starts the container. Logs should show:

```
[mqtt] connected to sdigf-emqx:1883 as sdigf-mock-edge
[mock] publishing telemetry every 10s, health every 60s
```

---

## Verification

**In MQTTX**, connect as `sdigf-admin` and subscribe to `sdigf/v1/gh1/#`.

| Check | Expected |
|---|---|
| Telemetry arrives | a message every 10 s on `up/telemetry` |
| Values drift | consecutive readings differ slightly, not identical |
| `seq` increments | 1, 2, 3 … with no gaps |
| Health arrives | every 60 s on `up/health`, retained |
| Status is online | `up/status` shows `{"state":"online"}` with the **Retained** badge |

**In the EMQX dashboard**, Clients should list `sdigf-mock-edge` as connected,
and Messages In Rate should be non-zero.

**Last-will test.** Stop the stack in Dokploy — that is a graceful stop, so the
mock publishes `offline` itself. To test the *will* specifically (ungraceful
disconnect), kill the container:

```bash
docker kill <mock-container-name>
```

The broker then publishes the retained `offline` message on its behalf. Stage 4
adds a cleaner way to trigger this for demo purposes.

---

## Configuration

All via environment variables; nothing is hardcoded.

| Variable | Default | Meaning |
|---|---|---|
| `MQTT_HOST` | *required* | Broker hostname |
| `MQTT_PORT` | `1883` | Broker port |
| `MQTT_USER` | *required* | Broker username |
| `MQTT_PASS` | *required* | Broker password |
| `MQTT_CLIENT_ID` | `sdigf-mock-edge` | Fixed, matching the real ESP32 pattern |
| `GH_ID` | `gh1` | Greenhouse slot in the topic tree |
| `FW_VERSION` | `mock-0.1.0` | Reported in `up/health` |
| `TELEMETRY_INTERVAL_S` | `10` | Telemetry publish interval |
| `HEALTH_INTERVAL_S` | `60` | Health publish interval |

---

## Swapping to the real ESP32

The intended endpoint is that swapping in real hardware is a **connection
change and nothing else**. Same topics, same payloads, same client ID pattern.
Stop this stack, power on the ESP32, and the server tier should not notice.

Note the one honest difference: this mock reports `tsq: "ntp"` because it runs
on a server with a real clock. The ESP32 reports `tsq: "boot"` until NTP syncs,
and the bridge must handle that case — see contract §2.

---

## Files

```
Tools/mock-edge/
├── docker-compose.yml     Dokploy stack definition
├── Dockerfile             node:20-alpine, runs as non-root
├── package.json
├── README.md
└── src/
    ├── config.js          Environment config and topic construction
    ├── environment.js     Simulated conditions (Stage 2 adds actuator physics)
    └── index.js           MQTT connection and publish loops
```

Topics are constructed in exactly one place (`config.js`) so a typo cannot
diverge between publishers.
