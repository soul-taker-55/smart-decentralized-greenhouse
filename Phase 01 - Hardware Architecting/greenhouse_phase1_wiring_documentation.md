# Smart Decentralized Greenhouse — Hardware & Wiring Documentation

**Phase 1 — Wiring and Hardware Bring-up**
**Controller:** ESP32-WROOM-32E
**Document scope:** Complete electrical specification from the 220–230 V mains source through every ESP32 pin. Control logic, MQTT, and server layers are out of scope for this document.

| Field | Value |
|---|---|
| Document version | 1.0 |
| Date | 19 June 2026 |
| Phase | 1 of 9 (hardware bring-up) |
| Status | Wiring locked — ready to build |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Hardware Components & Specifications](#3-hardware-components--specifications)
4. [Electrical Wiring Color Convention](#4-electrical-wiring-color-convention)
5. [Power Supply Architecture](#5-power-supply-architecture)
6. [Grounding Topology](#6-grounding-topology)
7. [ESP32 Pin Architecture](#7-esp32-pin-architecture)
8. [Sensor & Peripheral Wiring Configuration](#8-sensor--peripheral-wiring-configuration)
   - 8.1 Analog Sensors
   - 8.2 Digital Sensors
   - 8.3 I2C Bus
   - 8.4 Actuators & Outputs (Relay)
   - 8.5 Servo Motors (not used)
   - 8.6 Human Interface (Rotary Encoder & LCD)
   - 8.7 Reserved & Spare Pins
9. [Boot Safety & Critical Design Notes](#9-boot-safety--critical-design-notes)
10. [Bring-up & Verification Procedure](#10-bring-up--verification-procedure)
11. [Appendix A — Master Pin Reference](#appendix-a--master-pin-reference)
12. [Appendix B — Bill of Materials Summary](#appendix-b--bill-of-materials-summary)

---

## 1. Introduction

This document is the electrical reference for the **Smart Decentralized Greenhouse**, an academic proof-of-concept intended for eventual production deployment. The system is a single enclosure (3D-printed frame, plexiglass) growing lettuce and chicory, with an ESP32-class edge controller responsible for environmental sensing and binary actuation.

The build is organised as nine dependency-ordered phases. **Phase 1** — the subject of this document — wires every sensor and actuator to the controller and verifies that each one reads or switches correctly, with **no control logic present**. Establishing a clean, verified hardware baseline here removes electrical faults as a variable for every later phase (threshold control, fuzzy arbitration, RBAC, vision, ledger).

The controlling design constraints, all reflected in the pin assignments that follow, are:

- **ADC2 is unusable while WiFi is active**, so every analog sensor is placed on an **ADC1** channel (GPIO 32–39).
- **Strapping pins** (GPIO 0, 2, 5, 12, 15) are avoided for driven loads, with one deliberate, justified exception (GPIO 5 — see §9).
- **Input-only pins** (GPIO 34, 35, 36, 39) carry only analog inputs, never outputs.
- All actuators are **binary (on/off)**, switched through an **active-LOW** relay module, with the 220 V grow-light circuit requiring guaranteed-off behaviour through boot.

---

## 2. System Overview

The full system splits at MQTT into an **edge tier** (this controller, must run standalone) and a **server tier** (Dokploy-hosted vision, data, RBAC, ledger, dashboard). Phase 1 concerns only the edge hardware.

**Edge signal/power flow at a glance:**

```
220–230 V AC mains
   │
   ├──► S-25-5 PSU ──► 5 V rail ──► LM2596 buck ──► 3.3 V rail
   │                     │                              │
   │                     ├─ ESP32 (5V pin)              ├─ BMP280 ×2, DHT11 ×2
   │                     ├─ Relay coils (JD-VCC)        ├─ LDR ×2, soil, water
   │                     ├─ LCD, MQ135 heater           ├─ encoder, relay logic
   │                     └─ DC loads via relay contacts └─ level-converter LV
   │
   └──► Grow light (220 V), switched by relay CH7 contacts (mains-isolated)
```

A second microcontroller, the **ESP32-CAM**, exists in the system as an **independent WiFi node** for computer vision (Phase 6). It has its own power and network path and is **not wired to the main ESP32-WROOM-32E**; it is therefore outside the scope of this wiring document.

---

## 3. Hardware Components & Specifications

### 3.1 Master inventory

| No | Component | Qty | Power rail | Signal type | Function | Key notes |
|----|-----------|-----|-----------|-------------|----------|-----------|
| 1 | ESP32-WROOM-32E | 1 | 5 V → onboard 3.3 V reg | — (host) | Main edge controller | WiFi/BT; ADC2 unusable with WiFi |
| 2 | ESP32-CAM | 1 | independent | — | Vision node (Phase 6) | Separate WiFi node; **not wired here** |
| 3 | BMP280 (RobotDyn 7-pin) | 2 | 3.3 V | I2C | Inner/outer temperature + pressure | Addr 0x76 / 0x77; **no humidity** |
| 4 | DHT11 (3-pin module) | 2 | 3.3 V | Digital 1-wire | Inner/outer relative humidity | ±5 % RH, integer output (known weak) |
| 5 | MQ135 gas sensor | 1 | **5 V** | Analog (5 V) | Air-quality / gas trend | Heater needs 5 V; **divider required**; 24–48 h burn-in |
| 6 | LDR module (KY-018) | 2 | 3.3 V | Analog | Inner/outer light level | Onboard divider resistor |
| 7 | Soil moisture (FC-28 + LM393) | 1 | 3.3 V | Analog (AO) | Substrate moisture | Resistive probe — corrodes under constant bias |
| 8 | Water-level sensor | 1 | 3.3 V | Analog | Reservoir level | Resistive trace; corrodes |
| 9 | 16×2 LCD (I2C backpack) | 1 | **5 V** | I2C | Local status display | PCF8574, addr 0x27/0x3F; via level converter |
| 10 | Bidirectional logic level converter | 1 | 3.3 V + 5 V | — | I2C voltage bridge for LCD | MOSFET (BSS138) type |
| 11 | Rotary encoder (EC11/KY-040) | 1 | 3.3 V | Digital | Local UI input | Needs pull-ups (internal used) |
| 12 | 8-channel relay module | 1 | 5 V coils / 3.3 V logic | Digital (active-LOW) | Actuator switching | SONGLE SRD-05VDC; JD-VCC jumper |
| 13 | DC fans (5 V) | 3 | 5 V (switched) | — (load) | Cooling + humidity exhaust | Staged ventilation (0–3 fans) |
| 14 | DC pump | 1 | 5 V (switched) | — (load) | Irrigation | |
| 15 | Ultrasonic humidifier | 1 | 5 V (switched) | — (load) | Humidity addition | Driver inrush — measure draw |
| 16 | LED string ("Normal Lights") | 1 | 5 V (switched) | — (load) | Inner lighting | |
| 17 | LED grow light | 1 | **220 V** (switched) | — (load) | Photoperiod lighting | Non-dimmable; schedule-driven; mains-isolated |
| 18 | S-25-5 PSU | 1 | 220 V in / 5 V out | — | Primary 5 V supply | 25 W, 5 A |
| 19 | LM2596 / HW-411 buck | 1 | 5 V in / 3.3 V out | — | 3.3 V rail generator | Adjustable; set to 3.30 V |
| 20 | Resistor 2.2 kΩ | 1 | — | — | MQ135 divider (R1) | |
| 21 | Resistor 3.3 kΩ | 1 | — | — | MQ135 divider (R2) | |
| 22 | Resistor 10 kΩ | 7 | — | — | Relay IN pull-ups | Boot safety |

### 3.2 Extended component notes

**ESP32-WROOM-32E.** Dual-core Xtensa LX6 @ 240 MHz, 2.4 GHz WiFi + BT, 3.3 V logic. Powered on the bench via USB (5 V → onboard AMS1117 → 3.3 V). For standalone operation the 5 V rail feeds the board's 5 V pin. Two ADC blocks exist, but **ADC2 shares hardware with the WiFi radio** and returns garbage once WiFi is up — hence the ADC1-only rule for all analog sensors.

**BMP280 (7-pin RobotDyn variant).** This board exposes `5V · 3V3 · GND · SCK · SDO · SDI · CS` and supports both I2C and SPI. For I2C it requires two deliberate pin states: **CS tied HIGH** selects I2C mode, and **SDO selects the address** (GND → 0x76, 3.3 V → 0x77). This is exactly how the two sensors are differentiated on a shared bus. Measures pressure 300–1100 hPa and temperature −40 to +85 °C; it deliberately provides **no humidity** (that comes from the DHT11s).

**DHT11.** Humidity 20–90 % RH at ±5 %, integer resolution, ≥1 s between reads. The 3-pin module carries an onboard pull-up, so no external resistor is needed. Powered at 3.3 V so its open-drain data line idles at an ESP32-safe level. A documented accuracy limitation of the project — acceptable because humidity here is used for threshold control, not metrology.

**MQ135.** Tin-dioxide gas sensor; its internal **heater requires 5 V** to reach the correct operating temperature, so it cannot run at 3.3 V. The analog output (AO) can swing to nearly the 5 V rail, so it passes through a divider before reaching the ADC (see §8.1). Requires **24–48 h burn-in** for stable readings and resists absolute calibration — treat it as a relative trend signal. The board's digital output (DO) is a 5 V comparator output and is **left unconnected**.

**LDR / soil / water modules.** All three are breakout modules with onboard signal conditioning that output a 0-to-VCC analog voltage. Powered at **3.3 V**, their outputs already land within the ADC range, so **none of them needs an external divider** — the MQ135 is the only analog part that does. The soil (resistive FC-28) and water-level (resistive trace) sensors corrode under continuous DC bias; in later phases, power their VCC from a spare GPIO and energise only during a reading.

**16×2 LCD + level converter.** The HD44780 + PCF8574 backpack wants **5 V** for readable contrast; at 5 V its onboard pull-ups drive SDA/SCL to 5 V, which the ESP32 is **not** 5 V-tolerant for. The bidirectional level converter bridges only the LCD's two I2C lines between the 3.3 V and 5 V domains. The BMP280s are native 3.3 V and connect directly to the bus — they do **not** pass through the converter.

**8-channel relay module.** Opto-isolated, **active-LOW** (GPIO LOW = relay ON). SONGLE SRD-05VDC-SL-C relays, contacts rated ~10 A @ 250 VAC / 30 VDC. The board carries a removable **VCC ↔ JD-VCC jumper**: removing it lets the coils run from 5 V (JD-VCC) while the opto-input logic side runs from 3.3 V (VCC), so a 3.3 V GPIO HIGH fully releases the relay.

**Power supplies.** The **S-25-5** converts mains to 5 V at up to 5 A. The **LM2596** buck steps 5 V down to a regulated **3.30 V**; the 5 V → 3.3 V step provides ~1.7 V of headroom, adequate for this regulator. Set and verify the LM2596 output with a multimeter **before** connecting any 3.3 V device.

---

## 4. Electrical Wiring Color Convention

A consistent color code makes the harness self-documenting and reduces miswiring. The following convention is used throughout this document and should be followed on the physical build.

### 4.1 DC / logic wiring

| Color | Net | Notes |
|---|---|---|
| 🔴 Red | +5 V | From S-25-5 / 5 V rail |
| 🟠 Orange | +3.3 V | From LM2596 / 3.3 V rail |
| ⚫ Black | GND | Common ground (all domains) |
| 🟡 Yellow | I2C (SDA / SCL) | Shared bus lines |
| 🟢 Green | Analog signal | LDR, soil, water, MQ135 AO |
| 🔵 Blue | Digital sensor signal | DHT11 data, encoder CLK/DT/SW |
| 🟣 Purple | Relay control (IN lines) | ESP32 → relay opto inputs |

### 4.2 AC mains wiring (IEC / EU — Netherlands)

| Color | Conductor | Notes |
|---|---|---|
| 🟤 Brown | Line (Live, L) | 220–230 V AC, 50 Hz |
| 🔵 Blue | Neutral (N) | |
| 🟢🟡 Green/Yellow | Protective Earth (PE) | Bond the PSU chassis/enclosure metal |

> **Safety:** Mains wiring (S-25-5 input and the grow-light circuit) must be insulated, strain-relieved, and kept physically separated from all low-voltage wiring. The grow-light relay contacts are the **only** point where mains touches the board, and that side is galvanically isolated from logic ground.

---

## 5. Power Supply Architecture

### 5.1 Distribution chain

```
220–230 V AC ──► S-25-5 PSU ──► 5 V RAIL ──► LM2596 buck ──► 3.3 V RAIL
                                   │
                                   └─ (also feeds 5 V consumers directly)
```

| Stage | Input | Output | Capacity |
|---|---|---|---|
| S-25-5 PSU | 220–230 V AC | +5 V / GND | 5 A (25 W) |
| LM2596 buck | 5 V | +3.30 V / GND | ~2–3 A (set by module) |

### 5.2 Rail allocation

**5 V rail** powers: ESP32 5 V pin (standalone only) · relay **JD-VCC** (coils) · LCD VCC · MQ135 VCC · all switched DC loads (3 fans, pump, humidifier, LED string) through the relay **contacts**.

**3.3 V rail** powers: both BMP280 · both DHT11 · both LDR · soil module · water sensor · rotary encoder · relay **logic VCC** (opto-input side) · level-converter **LV** side.

**220 V mains** feeds: the S-25-5 input · the grow light (through CH7 relay contacts, isolated).

### 5.3 Current budget (estimates — verify by measurement)

| Rail | Consumer | Approx. current |
|---|---|---|
| 5 V | ESP32 (standalone, WiFi peak) | ~250 mA |
| 5 V | Relay coils (7 × ~80 mA, all on) | ~560 mA |
| 5 V | MQ135 heater | ~150 mA |
| 5 V | LCD (+ backlight) | ~25 mA |
| 5 V | LM2596 input (to supply 3.3 V rail) | ~200 mA |
| 5 V | 3 DC fans | ~450 mA |
| 5 V | DC pump | ~300–500 mA |
| 5 V | Ultrasonic humidifier | ~300 mA – 1 A |
| 5 V | LED string | ~200–500 mA |
| **5 V** | **Worst-case total (everything on)** | **~2.5–3.5 A** |
| 3.3 V | All sensors + encoder | ~50 mA |
| 3.3 V | Relay opto inputs (7 × ~5 mA) | ~35 mA |
| **3.3 V** | **Total** | **~85–100 mA** |

The 5 A supply has margin, but the simultaneous **pump + humidifier + all fans** case is the stress point. Measure it. The fan-vs-humidifier conflict arbiter (Phase 4) reduces this peak by design, since it prevents both running at full demand at once.

> The "0.08 mA" fan figure on the relay-board sketch is a typo — real 5 V fans draw ~80–200 mA.

### 5.4 Powering the ESP32 — bench vs standalone

- **Bench / bring-up:** power the ESP32 from **USB only** (it supplies 5 V for the Serial monitor). Do not also feed the 5 V rail to the 5 V pin simultaneously unless your board's input diode is confirmed.
- **Standalone:** connect the 5 V rail to the ESP32 **5 V pin**.
- **Never** back-feed the **3V3 pin** from the LM2596 rail — it fights the onboard regulator.

---

## 6. Grounding Topology

A single **common ground** ties together: S-25-5 GND, LM2596 input/output GND, ESP32 GND, relay logic GND, the level-converter GND (both sides), and every module GND. Route grounds back toward a single node (star topology) rather than daisy-chaining through high-current paths, so actuator switching currents do not corrupt sensor reference voltages.

**The one exception:** the relay's **output contacts** for the grow light carry 220 V and are galvanically separate dry contacts. That mains side never connects to logic ground.

---

## 7. ESP32 Pin Architecture

### 7.1 Design rules applied

| Rule | Reason | Pins affected |
|---|---|---|
| Analog only on ADC1 | ADC2 fails with WiFi active | 32, 33, 34, 35, 36, 39 |
| Input-only pins for analog inputs | 34/35/36/39 cannot output and have no pull-ups | 34, 35, 36, 39 |
| Avoid strapping pins for driven loads | Boot-mode interference / glitches | 0, 2, 12, 15 (avoided); 5 (used — see §9) |
| Never use flash pins | Connected to SPI flash | 6, 7, 8, 9, 10, 11 |
| Reserve UART0 | USB serial + programming | 1 (TX), 3 (RX) |

### 7.2 Functional pin groups

**Analog inputs (ADC1):** GPIO 36, 39, 34, 35, 32
**I2C bus:** GPIO 21 (SDA), 22 (SCL)
**Digital sensor inputs:** GPIO 26, 27 (DHT11), and GPIO 13, 14, 33 (encoder)
**Relay control outputs:** GPIO 19, 18, 5, 17, 16, 4, 23
**Power:** 5 V pin, 3V3 pin (unused as input), GND
**Spare:** GPIO 25

The complete pin-by-pin table is in [Appendix A](#appendix-a--master-pin-reference).

---

## 8. Sensor & Peripheral Wiring Configuration

In every table below: connect the module power pin to the indicated rail, the ground pin to common GND, and the signal pin to the listed ESP32 GPIO.

### 8.1 Analog Sensors

All analog sensors sit on **ADC1**. The four input-only pins (34/35/36/39) carry the passive modules; GPIO 32 carries the MQ135. **Only the MQ135 needs a divider.**

| Sensor | Power | GND | Signal → ESP32 | Extra |
|---|---|---|---|---|
| LDR inner (KY-018) | 3.3 V | GND | S → **GPIO 36** | onboard divider |
| LDR outer (KY-018) | 3.3 V | GND | S → **GPIO 39** | onboard divider |
| Soil moisture (FC-28) | 3.3 V | GND | AO → **GPIO 34** | DO unconnected |
| Water level | 3.3 V | GND | S → **GPIO 35** | — |
| MQ135 | **5 V** | GND | AO → divider → **GPIO 32** | DO unconnected |

**MQ135 voltage divider.** The 5 V AO must be brought below the ADC's nonlinear ceiling (~3.1 V):

```
MQ135 AO ──[ R1 = 2.2 kΩ ]──┬── GPIO 32
                            │
                       [ R2 = 3.3 kΩ ]
                            │
                           GND
```

`V_adc = V_ao × R2 / (R1 + R2) = V_ao × 3.3 / 5.5 = V_ao × 0.60`

At a worst-case 5.0 V AO this yields **3.0 V** at the pin — safely under the ceiling — with a source impedance of `R1 ∥ R2 ≈ 1.32 kΩ`, low enough for clean ADC sampling. The firmware reconstructs AO by multiplying the measured pin voltage by 5.5 / 3.3.

**ADC configuration:** `analogReadResolution(12)` (0–4095) and `ADC_11db` attenuation (~0–3.1 V usable).

### 8.2 Digital Sensors

DHT11 modules are single-wire with an onboard pull-up; powered at 3.3 V their data line is ESP32-safe.

| Sensor | Power | GND | Data → ESP32 |
|---|---|---|---|
| DHT11 inner | 3.3 V | GND | **GPIO 26** |
| DHT11 outer | 3.3 V | GND | **GPIO 27** |

> Module pin rule: on these 3-pin boards the **middle pin is always VCC**; the end pins are signal and GND. Match the silkscreen, not the wire color.

### 8.3 I2C Bus

One bus (`GPIO 21 = SDA`, `GPIO 22 = SCL`) carries **both BMP280s and the LCD**, split into two voltage domains by the level converter.

**Domain layout**

| Domain | Devices | Connection |
|---|---|---|
| LV (3.3 V) | ESP32 + both BMP280 | direct to GPIO 21/22 + converter LV channels |
| HV (5 V) | LCD only | converter HV channels |

**BMP280 ×2 wiring** (the two differ only on SDO):

| Module pin | Inner (0x76) | Outer (0x77) |
|---|---|---|
| 3V3 | 3.3 V | 3.3 V |
| 5V | leave open | leave open |
| GND | GND | GND |
| SCK | GPIO 22 (SCL) | GPIO 22 (SCL) |
| SDI | GPIO 21 (SDA) | GPIO 21 (SDA) |
| **SDO** | **→ GND** (sets 0x76) | **→ 3.3 V** (sets 0x77) |
| **CS** | **→ 3.3 V** (I2C mode) | **→ 3.3 V** (I2C mode) |

**Level converter & LCD wiring:**

| Converter pin | Connects to |
|---|---|
| LV | 3.3 V |
| HV | 5 V |
| GND (both) | common GND |
| LV1 ↔ HV1 | LV1 → GPIO 21 (with BMP280s) · HV1 → LCD SDA |
| LV2 ↔ HV2 | LV2 → GPIO 22 (with BMP280s) · HV2 → LCD SCL |
| (LCD) VCC / GND | 5 V / GND |

**Pull-ups:** the BMP280 boards carry onboard I2C pull-ups (the `103` = 10 kΩ resistors); two in parallel is fine. No external pull-ups required. If the startup I2C scan shows nothing, suspect SDA/SCL swap or a missing CS-high.

**Expected addresses on the bus:** `0x76`, `0x77`, and the LCD at `0x27` (or `0x3F`).

### 8.4 Actuators & Outputs (Relay)

The 8-channel **active-LOW** relay module is the single point of actuation. Seven channels are used; IN8 is free.

**Logic / coil side**

| Relay pin | Connects to |
|---|---|
| GND | common GND |
| VCC (logic) | **3.3 V** |
| JD-VCC (coils) | **5 V** |
| VCC ↔ JD-VCC jumper | **REMOVED** |
| each IN line | + a **10 kΩ pull-up to 3.3 V** (boot safety) |

**Control mapping** (pin order matches your relay-board diagram; physical top-to-bottom on the ESP32 right header for a clean ribbon):

| IN | ESP32 | Load | Contact wiring (COM / NO) |
|---|---|---|---|
| IN1 | GPIO 19 | Pump | COM ← 5 V · NO → Pump(+) · Pump(−) → GND |
| IN2 | GPIO 18 | S-Fan | COM ← 5 V · NO → Fan(+) · (−) → GND |
| IN3 | **GPIO 5** | Internal Fan | COM ← 5 V · NO → Fan(+) · (−) → GND |
| IN4 | GPIO 17 | N-Fan | COM ← 5 V · NO → Fan(+) · (−) → GND |
| IN5 | GPIO 16 | Ultrasonic humidifier | COM ← 5 V · NO → Hmdfr(+) · (−) → GND |
| IN6 | GPIO 4 | Normal Lights (LED string) | COM ← 5 V · NO → LED(+) · (−) → GND |
| IN7 | GPIO 23 | **Grow light (220 V)** | COM ← **mains L** · NO → light L · light N → **mains N** |

> **GPIO 5** is a strapping pin used deliberately for the Internal Fan — see §9 for the full justification. It is never used for the grow light.

### 8.5 Servo Motors

**Not used in this build.** Every actuator in the locked hardware set is binary and relay-switched; there are no servos, ESCs, or PWM-driven motors. This section is retained for completeness and future expansion.

**If a servo is added later:** drive it from the spare **GPIO 25** (full GPIO, LEDC-PWM capable), power its supply rail from 5 V (never from the ESP32 3V3 pin — servo stall current will brown out the logic), and tie its ground to common GND. A 50 Hz LEDC channel on GPIO 25 would control it without disturbing any existing assignment.

### 8.6 Human Interface (Rotary Encoder & LCD)

**Rotary encoder** (incremental, with push-switch). Uses the ESP32 internal pull-ups, so no external resistors are needed. Must be on full-GPIO pins (not the input-only 34/35/36/39).

| Encoder pin | Power/GND | → ESP32 |
|---|---|---|
| + (VCC) | 3.3 V | — |
| GND | GND | — |
| CLK | — | **GPIO 13** (INPUT_PULLUP) |
| DT | — | **GPIO 14** (INPUT_PULLUP) |
| SW | — | **GPIO 33** (INPUT_PULLUP) |

**LCD** — see §8.3 (it is an I2C device on the 5 V side of the level converter).

### 8.7 Reserved & Spare Pins

| Pin(s) | Status | Reason |
|---|---|---|
| GPIO 6–11 | **Unusable** | SPI flash |
| GPIO 1, 3 | **Reserved** | UART0 — USB serial / programming |
| GPIO 0, 2, 12, 15 | **Avoided** | Strapping pins (boot interference) |
| GPIO 5 | **Used (justified)** | Strapping pin; safe for a fan load (§9) |
| GPIO 25 | **Spare** | Free full GPIO — servo / future use |
| 3V3 pin | **Do not drive** | Onboard-regulator output |

---

## 9. Boot Safety & Critical Design Notes

**Relay boot safety.** Every ESP32 GPIO is high-impedance from reset until firmware runs. On an active-LOW board a floating input can drift LOW = relay ON. Three layers prevent this, and all three matter most for the 220 V grow light:

1. **10 kΩ pull-up** from each IN line to the 3.3 V logic VCC — holds IN HIGH (OFF) during the float window.
2. **Firmware drives every relay pin OUTPUT + HIGH as the first action in `setup()`**, before Serial, I2C, or WiFi.
3. Relays are kept off strapping pins (except GPIO 5, justified below).

**GPIO 5 justification.** GPIO 5 is a strapping pin (SDIO slave timing), but that strap is irrelevant when booting from SPI flash, and it has an internal pull-up so it idles HIGH = relay OFF. Its only quirk is a possible brief output blip from the ROM bootloader in the ~100 ms before `setup()` runs. On the **Internal Fan**, a sub-second twitch at power-on is harmless — which is precisely why a fan, not the grow light, is assigned here. (Zero-strapping-pin alternative: move the Internal Fan to the spare GPIO 25, accepting a less tidy harness — one flyer wire instead of a 6-wide ribbon.)

**Mains isolation.** The grow-light relay's COM/NO contacts carry 220 V and are isolated dry contacts. That side never touches logic ground; keep its wiring physically separated and strain-relieved.

**5 V budget.** Verify worst-case 5 V current (§5.3) stays comfortably under 5 A before running all actuators together.

**Sensor corrosion.** The FC-28 and water-level probes corrode under continuous DC. Acceptable for Phase 1; in Phase 2, power their VCC from a GPIO and energise only during reads.

---

## 10. Bring-up & Verification Procedure

A test sketch (`greenhouse_phase1_bringup.ino`) reads every sensor and lets each relay be toggled over Serial, with no control logic. Recommended order — each step isolates a class of fault before the next is added:

1. **Power rails first.** Set the LM2596 to 3.30 V (multimeter, no devices attached). Confirm 5 V and 3.3 V rails and common ground.
2. **I2C subsystem.** Wire the two BMP280s and the LCD (via level converter). Flash the sketch; the startup **I2C scan** must report `0x76`, `0x77`, and the LCD address. A missing BMP280 points directly at its SDO/CS wiring.
3. **Analog modules.** Add the LDRs, soil, water, and MQ135 (with divider). Confirm raw values respond — shade an LDR, touch the soil probe, etc. The MQ135 needs burn-in before its reading settles.
4. **Digital inputs.** Add the DHT11s and the encoder; confirm humidity reads and the encoder position/button track.
5. **Relays — logic only.** Wire the IN ribbon and coil/logic power (jumper removed). Toggle channels `1`–`7` over Serial and confirm each click. **Keep the grow-light circuit de-energised.**
6. **Mains last.** Only after CH7 has been verified silent through several resets, wire the 220 V grow light and confirm switching via command `7`.

Serial: 115200 baud. Commands: `1`–`7` toggle a relay, `x` all off, `s` re-scan I2C, `h` help.

---

## Appendix A — Master Pin Reference

| ESP32 pin | Direction | Connects to | Device rail |
|---|---|---|---|
| GPIO 36 (SVP) | ADC1 in | LDR inner — S | 3.3 V |
| GPIO 39 (SVN) | ADC1 in | LDR outer — S | 3.3 V |
| GPIO 34 | ADC1 in | Soil module — AO | 3.3 V |
| GPIO 35 | ADC1 in | Water sensor — S | 3.3 V |
| GPIO 32 | ADC1 in | MQ135 — AO via 2.2k/3.3k divider | 5 V |
| GPIO 21 | I2C SDA | BMP280 ×2 SDI + level-conv LV1 | 3.3 V |
| GPIO 22 | I2C SCL | BMP280 ×2 SCK + level-conv LV2 | 3.3 V |
| GPIO 26 | digital in | DHT11 inner — data | 3.3 V |
| GPIO 27 | digital in | DHT11 outer — data | 3.3 V |
| GPIO 13 | in (pull-up) | Encoder — CLK | 3.3 V |
| GPIO 14 | in (pull-up) | Encoder — DT | 3.3 V |
| GPIO 33 | in (pull-up) | Encoder — SW | 3.3 V |
| GPIO 19 | digital out | Relay IN1 — Pump | logic 3.3 V |
| GPIO 18 | digital out | Relay IN2 — S-Fan | logic 3.3 V |
| GPIO 5 | digital out | Relay IN3 — Internal Fan | logic 3.3 V (strapping) |
| GPIO 17 | digital out | Relay IN4 — N-Fan | logic 3.3 V |
| GPIO 16 | digital out | Relay IN5 — Ultrasonic humidifier | logic 3.3 V |
| GPIO 4 | digital out | Relay IN6 — Normal Lights | logic 3.3 V |
| GPIO 23 | digital out | Relay IN7 — Grow light (220 V) | logic 3.3 V |
| 5V | power in | 5 V rail (standalone) / USB (bench) | — |
| 3V3 | — | do not drive | — |
| GND | ground | common ground node | — |
| GPIO 25 | spare | future / servo | — |

**Reserved/unusable:** GPIO 6–11 (flash), 1/3 (UART0), 0/2/12/15 (strapping).

---

## Appendix B — Bill of Materials Summary

| Category | Items |
|---|---|
| Controllers | ESP32-WROOM-32E (×1), ESP32-CAM (×1, separate node) |
| Sensors | BMP280 ×2, DHT11 ×2, MQ135 ×1, LDR ×2, soil FC-28 ×1, water level ×1 |
| Interface | 16×2 I2C LCD ×1, rotary encoder ×1, level converter ×1 |
| Actuation | 8-ch relay ×1; loads: 3× DC fan, pump, ultrasonic humidifier, LED string, 220 V grow light |
| Power | S-25-5 PSU (5 V/5 A) ×1, LM2596/HW-411 buck ×1 |
| Passives | 2.2 kΩ ×1, 3.3 kΩ ×1 (MQ135 divider); 10 kΩ ×7 (relay pull-ups) |

---

*End of document — Phase 1 wiring locked. Next phase: sensor abstraction layer and threshold control loops (Phase 2).*
