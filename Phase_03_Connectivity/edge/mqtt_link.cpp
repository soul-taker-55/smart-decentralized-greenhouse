#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "mqtt_link.h"
#include "sensors.h"
#include "actuators.h"
#include "estop.h"
#include "config_store.h"
#include "config_handler.h"
#include "secrets.h"

// ---- topics (v4 §1) ----
#define T_BASE        "sdigf/v1/gh1/"
#define T_TELEMETRY   T_BASE "up/telemetry"
#define T_ACTUATORS   T_BASE "up/actuators"
#define T_HEALTH      T_BASE "up/health"
#define T_ACK         T_BASE "up/ack"
#define T_STATUS      T_BASE "status"
#define T_DOWN_ALL    T_BASE "down/#"
#define T_DOWN_CONFIG T_BASE "down/config"

#define CLIENT_ID     "sdigf-edge-gh1"

// v4 §2: PubSubClient's 256 B default DROPS payloads SILENTLY. 2048 is
// mandatory — measured down/config reaches 1,556 B at four signatures.
#define MQTT_BUF_SIZE 2048

#if MQTT_USE_TLS
  static WiFiClientSecure net;
#else
  static WiFiClient net;
#endif
static PubSubClient mqtt(net);

static uint32_t seqCounter   = 0;
static uint32_t reconnects   = 0;
static uint32_t lastAttempt  = 0;
static uint32_t backoffMs    = 1000;
static bool     wasConnected = false;

// ---- envelope (v4 §2) ----
uint32_t envelopeTs() {
  time_t now; time(&now);
  return (now > 1700000000) ? (uint32_t)now : (uint32_t)(millis() / 1000);
}
const char* envelopeTsq() {
  time_t now; time(&now);
  return (now > 1700000000) ? "ntp" : "boot";
}
uint32_t envelopeNextSeq() { return seqCounter++; }

static void addEnvelope(JsonDocument& d) {
  d["v"]   = 1;
  d["ts"]  = envelopeTs();
  d["tsq"] = envelopeTsq();
  d["seq"] = envelopeNextSeq();
}

// ---- inbound ----
static bool publishAck(const ConfigOutcome& o);

static void onMessage(char* topic, uint8_t* payload, unsigned int len) {
  Serial.printf("[MQTT] rx %s (%u B)\n", topic, len);

  if (strcmp(topic, T_DOWN_CONFIG) == 0) {
    ConfigOutcome o = handleConfig(payload, len);
    if (o.result == CFG_IGNORED) {
      Serial.printf("[CFG] ignored: %s\n", o.detail);
      return;                              // no ack for a cleared retained topic
    }
    if (o.result == CFG_ACCEPTED)
      Serial.printf("[CFG] ACCEPTED ver %lu hash %.16s…\n", (unsigned long)o.ref_ver, o.ref_hash);
    else
      Serial.printf("[CFG] REJECTED %s field=%s — %s\n", o.code, o.field ? o.field : "-", o.detail);
    publishAck(o);
    if (o.result == CFG_ACCEPTED) publishHealth();   // retained cfg block must reflect the new version
    return;
  }

  Serial.printf("[MQTT]   no handler for %s yet\n", topic);
}

// ---- connection ----
static const char* bootReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "power_on";
    case ESP_RST_SW:       return "sw_reset";
    case ESP_RST_PANIC:    return "panic";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:      return "watchdog";
    case ESP_RST_BROWNOUT: return "brownout";
    default:               return "unknown";
  }
}

void mqttInit() {
#if MQTT_USE_TLS
  net.setInsecure();   // KNOWN GAP: certificate not verified. Same status as the CAM.
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(MQTT_BUF_SIZE);
  mqtt.setKeepAlive(30);
  mqtt.setCallback(onMessage);
}

static bool tryConnect() {
  // v4 §3.5: last will is fixed at connect time and carries NO ts —
  // the server timestamps offline events on receipt.
  const char* will = "{\"v\":1,\"state\":\"offline\"}";
  bool ok = mqtt.connect(CLIENT_ID, MQTT_USER, MQTT_PASS,
                         T_STATUS, 1, true, will);
  if (!ok) {
    Serial.printf("[MQTT] connect failed rc=%d (next in %lu ms)\n",
                  mqtt.state(), (unsigned long)backoffMs);
    return false;
  }
  Serial.printf("[MQTT] connected to %s:%d as %s\n", MQTT_HOST, MQTT_PORT, MQTT_USER);
  mqtt.subscribe(T_DOWN_ALL, 1);
  publishStatusOnline();
  publishActuators();   // retained state must be fresh on every connect
  publishHealth();
  backoffMs = 1000;
  return true;
}

void mqttLoop() {
  if (WiFi.status() != WL_CONNECTED) return;

  if (!mqtt.connected()) {
    if (wasConnected) { reconnects++; wasConnected = false; }
    uint32_t now = millis();
    if (now - lastAttempt >= backoffMs) {
      lastAttempt = now;
      if (tryConnect()) wasConnected = true;
      else backoffMs = min<uint32_t>(backoffMs * 2, 60000);
    }
    return;
  }
  mqtt.loop();
}

bool mqttConnected()      { return mqtt.connected(); }
uint32_t mqttReconnects() { return reconnects; }

// ---- publishers ----
static bool send(const char* topic, JsonDocument& d, bool retain, int qos) {
  char buf[MQTT_BUF_SIZE];
  size_t n = serializeJson(d, buf, sizeof(buf));
  // PubSubClient has no QoS-1 publish API; QoS 1 is achieved by the broker
  // side for subscribers. What we control here is retain. qos is kept in the
  // signature so the contract's per-topic table is visible at each call site.
  (void)qos;
  bool ok = mqtt.publish(topic, (const uint8_t*)buf, n, retain);
  Serial.printf("[MQTT] %s %s (%u B)%s\n", ok ? "tx" : "TX FAILED", topic,
                (unsigned)n, retain ? " retained" : "");
  return ok;
}

bool publishStatusOnline() {
  JsonDocument d;
  d["v"] = 1; d["state"] = "online"; d["ts"] = envelopeTs();
  return send(T_STATUS, d, true, 1);
}

bool publishHealth() {
  JsonDocument d;
  addEnvelope(d);
  d["up_s"]     = millis() / 1000;
  d["rssi"]     = WiFi.RSSI();
  d["heap"]     = ESP.getFreeHeap();
  d["heap_min"] = ESP.getMinFreeHeap();
  d["fw"]       = FW_VERSION;
  // v4 §3.3: cfg.src = "none" on a fresh device is a DISTINCT state, not null.
  // No config has been received (stage B) and nothing is in NVS.
  // v4 §3.3. cfg.src is load-bearing for the thesis: "nvs" after a reboot with
  // no broker is the observable proof of edge autonomy. "none" is a distinct
  // third state, not an absence.
  const AppliedConfig& ac = configApplied();
  JsonObject cfg = d["cfg"].to<JsonObject>();
  cfg["ver"]    = ac.ver;
  if (ac.ver > 0) cfg["hash"] = ac.hash; else cfg["hash"] = nullptr;
  cfg["src"]    = CFG_SRC_STR[ac.src];
  // DEVICE-DECLARED, never server-supplied (§3.4). Stage B has no signature
  // verification, so this MUST say "unsupported": the device applies configs
  // on envelope grounds alone, exactly as v3 did. Stage C earns "enforced".
  // Stage A wrongly declared "enforced" — corrected here; the record notes it.
  cfg["verify"] = "unsupported";
  d["mqtt_reconnects"] = reconnects;
  d["boot_reason"]     = bootReason();
  return send(T_HEALTH, d, true, 0);
}

bool publishTelemetry() {
  JsonDocument d;
  addEnvelope(d);
  JsonObject r = d["r"].to<JsonObject>();
  for (uint8_t i = 0; i < S_COUNT; i++) {
    Reading rd = sensorGet((SensorId)i);
    JsonObject o = r[SENSOR_KEYS[i]].to<JsonObject>();
    // v4 §3.1 null rule: fail/init → val is null, never a sentinel.
    if (rd.q == Q_OK || rd.q == Q_STALE) {
      if (sensorIsInt((SensorId)i)) o["val"] = (int)lroundf(rd.val);
      else                          o["val"] = roundf(rd.val * 10.0f) / 10.0f;
    } else {
      o["val"] = nullptr;
    }
    o["q"] = SENSOR_Q_STR[rd.q];
  }
  return send(T_TELEMETRY, d, false, 0);
}

bool publishActuators() {
  JsonDocument d;
  addEnvelope(d);
  JsonObject a = d["a"].to<JsonObject>();
  uint32_t now = millis();
  for (uint8_t i = 0; i < ACT_COUNT; i++) {
    const ActuatorState& s = actuatorGet((ActuatorId)i);
    JsonObject o = a[ACTUATOR_KEYS[i]].to<JsonObject>();
    o["on"]    = s.on;
    o["src"]   = s.src == SRC_AUTO ? "auto" : s.src == SRC_MANUAL ? "manual" : "safety";
    o["for_s"] = (now - s.since_ms) / 1000;
    if (s.src == SRC_MANUAL && s.ovr_until_ms > now)
      o["ovr_s"] = (s.ovr_until_ms - now) / 1000;
  }
  // Canopy: no servo driver until Phase 02. Report the honest boot state —
  // position unknown-but-commanded-nothing. 0 is "fully open" per §3.2
  // (pos = % closed). Phase 02 decides and justifies the real boot position.
  JsonObject c = d["canopy"].to<JsonObject>();
  c["pos"] = 0; c["target"] = 0; c["moving"] = false; c["src"] = "auto";
  d["vent"] = actuatorVentStage();
  return send(T_ACTUATORS, d, true, 1);
}

// v4 §3.4 — "the most important payload in the contract". ref = what was
// received; applied = what is NOW running (on rejection, the previous config —
// the edge never ends up running nothing).
static bool publishAck(const ConfigOutcome& o) {
  JsonDocument d;
  addEnvelope(d);
  JsonObject ref = d["ref"].to<JsonObject>();
  ref["ver"] = o.ref_ver;
  if (o.ref_hash[0]) ref["hash"] = o.ref_hash; else ref["hash"] = nullptr;

  d["result"] = (o.result == CFG_ACCEPTED) ? "accepted" : "rejected";

  const AppliedConfig& ac = configApplied();
  JsonObject ap = d["applied"].to<JsonObject>();
  ap["ver"] = ac.ver;
  if (ac.ver > 0) ap["hash"] = ac.hash; else ap["hash"] = nullptr;

  d["verify"] = "unsupported";                 // stage B; see publishHealth()
  d["verified_by"].to<JsonArray>();            // empty — §3.4: empty when unsupported

  if (o.result == CFG_ACCEPTED) {
    d["reason"] = nullptr;
  } else {
    JsonObject r = d["reason"].to<JsonObject>();
    r["code"]   = o.code;
    if (o.field) r["field"] = o.field; else r["field"] = nullptr;
    r["detail"] = o.detail;
  }
  return send(T_ACK, d, false, 1);
}
