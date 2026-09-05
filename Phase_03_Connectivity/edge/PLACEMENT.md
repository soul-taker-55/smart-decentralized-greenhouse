# Stage A — edge firmware, connectivity on bare silicon

Compiled clean: esp32 core 3.3.11, board `esp32:esp32:esp32` (ESP32 Dev
Module), ArduinoJson 7.4.3, PubSubClient 2.8. 925 KB / 70% of default app
partition. Same core version as your IDE.

## Where it goes

```
Phase_03_Connectivity/
└── edge/                        ← NEW folder (all 12 files inside)
    ├── .gitignore               ← commit FIRST, before secrets.h exists
    ├── secrets.h.example        ← template; commit this
    ├── secrets.h                ← you create from the example; NEVER commit
    ├── edge.ino                 ← folder name must match: edge/edge.ino
    ├── pins.h
    ├── actuators.h / .cpp
    ├── sensors.h / .cpp
    ├── estop.h / .cpp
    └── mqtt_link.h / .cpp
```

The folder is `edge/` and the sketch is `edge.ino` — Arduino IDE requires
the names to match.

## Before anything: gitignore first, then secrets

Same discipline as Phase 06. The ignore rule must exist before the file it
protects.

```powershell
cd "C:\Users\medoo\Desktop\College\5th Year\CEA\Simulation\github\smart-decentralized-greenhouse"
mkdir Phase_03_Connectivity\edge
# copy the 11 delivered files (NOT secrets.h — you make that) into it

git add "Phase_03_Connectivity/edge/.gitignore"
git commit -m "Phase 03: gitignore for edge firmware - protect secrets.h before it exists"
git push
```

Then create `secrets.h` by copying `secrets.h.example` and filling in:
- `WIFI_SSID` / `WIFI_PASS` — SOULTAKER_B
- `MQTT_HOST` — `emqx.progrex.tech`
- `MQTT_PORT` — 1883 or 8883, whichever is open publicly
- `MQTT_USE_TLS` — 0 for 1883, 1 for 8883
- `MQTT_USER` / `MQTT_PASS` — the sdigf-edge account

Verify it is ignored before flashing:
```powershell
git check-ignore -v "Phase_03_Connectivity/edge/secrets.h"
git status --short
```
`check-ignore` must print the rule; `status` must NOT list secrets.h.

## IDE setup

- Tools → Board → esp32 → **ESP32 Dev Module**
- Tools → Partition Scheme → **Default 4MB with spiffs** is fine for now
  (stage C will need "Huge APP" once mbedTLS verification is added)
- Library Manager: install **PubSubClient** (Nick O'Leary) and
  **ArduinoJson** (Benoit Blanchon, 7.x)
- Port → the WROOM's COM port. It has native USB; no IO0 jumper needed.

## What to expect on serial

```
=== SDIGF edge 0.1.0-A — stage A ===
[SYS] boot: relays safe, e-stop clear (origin remote, NVS absent → fail-closed remote)
[SYS] heap ... min ...
[NET] joining SOULTAKER_B
....
[NET] IP ...  RSSI ...
=== setup complete ===

[MQTT] connected to emqx.progrex.tech:1883 as sdigf-edge
[MQTT] tx sdigf/v1/gh1/status (39 B) retained
[MQTT] tx sdigf/v1/gh1/up/actuators (~330 B) retained
[MQTT] tx sdigf/v1/gh1/up/health (~200 B) retained
[MQTT] tx sdigf/v1/gh1/up/telemetry (~480 B)          ← every 30 s
```

"NVS absent → fail-closed remote" on the first line is CORRECT for a fresh
device: no e-stop record exists, so origin defaults to remote per the
planner's rule. It is not an error.

## Verify on the server

Three things, none of which the device can fake:

1. **Dashboard header** should flip from "Never connected" to Online with
   the `sdigf-edge` device, and "Last reading" should start counting.

2. **Bridge wrote rows.** On the VPS:
   ```bash
   docker exec -i smart-greenhouse-project-sdigfserver-wyl2we-sdigf-db-1 \
     psql -U postgres -d sdigf_db -c \
     "SELECT time, sensor_name, value, quality FROM sensor_readings ORDER BY time DESC LIMIT 12;"
   ```
   Expect 11 rows per 30 s with `value` NULL and `quality` = `init`. NULL is
   the correct answer — it is what the contract says an unread sensor reports.

3. **Last will works.** Pull the USB cable. Within ~45 s (keepalive 30 +
   grace) the dashboard should show the device offline. That proves the
   broker published the retained `{"state":"offline"}` on the device's behalf.

## Known gaps carried forward

- `MQTT_USE_TLS=1` uses `setInsecure()` — certificate not verified. Same
  status as the CAM. If 1883 is what's open publicly, that is a plaintext
  password on the internet and belongs on the security-hardening list.
- `cfg.verify` is declared `enforced` before stage C makes it true. It states
  what the firmware is built to; stage C is what proves it.
- PubSubClient has no client-side QoS 1 publish. `up/ack` and `up/actuators`
  are contract QoS 1; the retain flag is honoured, the redelivery guarantee is
  not. Revisit if a lost ack is ever observed.
