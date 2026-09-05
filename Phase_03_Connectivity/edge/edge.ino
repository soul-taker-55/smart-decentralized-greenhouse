// SDIGF — edge controller firmware. ESP32-WROOM-32E.
//
// STAGE A: connectivity on bare silicon. Nothing wired but USB. Proves the
// device speaks contract v4 to the live broker: status with last will,
// up/health, up/telemetry (all readings honestly "init"), up/actuators (all
// off). Subscribes to down/# so stage B can attach handlers.
//
// LAYERS, and why they exist before any control logic does:
//   sensors     — stubbed now, real in Phase 02. Interface will not change.
//   actuators   — real GPIO now. The only file that knows active-LOW.
//   estop       — reads NVS, drives the LED. Trigger/clear come later.
//   mqtt_link   — everything network. Never blocks the loop.
//   CONTROL LOOP — the named empty slot below. Phase 02 fills it.
//
// Phase 03 was started before Phase 02 by decision (6 Sep 2026). The layer
// boundaries are the safeguard: connectivity plugs INTO control, never the
// reverse. If a later change makes the control loop depend on this file's
// network state, that is the design failure to catch in review.
//
// Toolchain: Arduino IDE, esp32 core 3.x. Board: "ESP32 Dev Module".
// Libraries: PubSubClient, ArduinoJson (7.x). mbedTLS and Preferences are in
// the core.

#include <Arduino.h>
#include <WiFi.h>
#include <time.h>
#include "pins.h"
#include "secrets.h"
#include "actuators.h"
#include "sensors.h"
#include "estop.h"
#include "mqtt_link.h"

// v4 §2: telemetry interval is FIXED at 30 s. Not a tuning knob.
#define TELEMETRY_INTERVAL_MS  (30UL * 1000UL)
#define HEALTH_INTERVAL_MS     (60UL * 1000UL)
#define ACTUATORS_INTERVAL_MS  (60UL * 1000UL)   // retained; also sent on every state change later

static uint32_t tTelemetry = 0, tHealth = 0, tActuators = 0;

void setup() {
  // ORDER IS THE SAFETY ARGUMENT. Wiring doc §9.
  actuatorsSafeInit();   // 1. every relay pin HIGH (off). Before anything.
  estopInit();           // 2. LED reflects the persisted flag. Before Serial.

  Serial.begin(115200);
  delay(300);
  Serial.println("\n\n=== SDIGF edge " FW_VERSION " — stage A ===");
  Serial.printf("[SYS] boot: relays safe, e-stop %s (origin %s%s)\n",
                estopGet().active ? "ACTIVE" : "clear",
                estopGet().origin == ORIGIN_LOCAL ? "local" : "remote",
                estopGet().nvs_valid ? "" : ", NVS absent → fail-closed remote");
  Serial.printf("[SYS] heap %u  min %u\n", ESP.getFreeHeap(), ESP.getMinFreeHeap());

  sensorsInit();
  mqttInit();

  Serial.printf("[NET] joining %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(250); Serial.print("."); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[NET] IP %s  RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  } else {
    Serial.println("[NET] not connected — control would continue regardless; retrying in loop");
  }
  Serial.println("=== setup complete ===\n");
}

void loop() {
  // Network first so inbound messages are pumped, but it never blocks.
  if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
  mqttLoop();

  sensorsPoll();

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ CONTROL LOOP — Phase 02.                                        │
  // │ Threshold+hysteresis per variable, rule arbiter, safety         │
  // │ envelope, overrides, e-stop enforcement. Reads sensorGet(),     │
  // │ writes actuatorSet(). Must not read anything from mqtt_link.    │
  // └─────────────────────────────────────────────────────────────────┘

  uint32_t now = millis();
  if (mqttConnected()) {
    if (now - tTelemetry >= TELEMETRY_INTERVAL_MS) { tTelemetry = now; publishTelemetry(); }
    if (now - tHealth    >= HEALTH_INTERVAL_MS)    { tHealth    = now; publishHealth(); }
    if (now - tActuators >= ACTUATORS_INTERVAL_MS) { tActuators = now; publishActuators(); }
  }
  delay(10);
}
