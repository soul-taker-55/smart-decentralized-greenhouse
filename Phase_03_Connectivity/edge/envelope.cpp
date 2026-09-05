#include <Arduino.h>
#include <string.h>
#include <stdio.h>
#include "envelope.h"

// ── Bounds, each with its physical justification (mirrors safety.js) ─────────
static const int DC_MIN = -400, DC_MAX = 850;        // BMP280 operating range, deci-°C
static const int PCT_MIN = 0, PCT_MAX = 100;         // definitional
static const int MIN_OF_DAY_MAX = 1439;              // minutes in a day
static const int TZ_MIN = -720, TZ_MAX = 840;        // UTC-12 .. UTC+14
static const int VENT_STAGE_MAX = 3;                 // three fans → stages 0..3
static const int PUMP_MAX_RUNTIME_S = 3600;          // diaphragm pump, no thermal cutout
static const int CANOPY_STEP_MIN = 1;                // step 0 = unbounded moves
static const int CANOPY_DWELL_MIN_S = 1;             // dwell 0 = overlapping moves, MG996R stall

struct Ctx { int count; EnvelopeViolation* first; };

static void fail(Ctx& c, const char* field, const char* fmt, ...) {
  if (c.count == 0) {
    c.first->field = field;
    va_list ap; va_start(ap, fmt);
    vsnprintf(c.first->detail, sizeof(c.first->detail), fmt, ap);
    va_end(ap);
  }
  c.count++;
}

// Null is ACCEPTED on purpose: it marks a value the engineer has not supplied.
// The envelope rejects values that would damage equipment; an absent value
// cannot. The control loop simply does not act on a threshold it lacks.
static void checkInt(Ctx& c, const char* path, JsonVariantConst v, int lo, int hi, bool required = false) {
  if (v.isNull()) { if (required) fail(c, path, "required, may not be null"); return; }
  // Floats are forbidden contract-wide (canonicalization drift). Deci-units exist for this.
  if (!v.is<int>() || (v.is<float>() && v.as<float>() != (float)v.as<int>())) {
    fail(c, path, "must be an integer"); return;
  }
  int x = v.as<int>();
  if (x < lo || x > hi) fail(c, path, "outside equipment limits %d..%d, got %d", lo, hi, x);
}
static bool isInt(JsonVariantConst v) { return !v.isNull() && v.is<int>(); }

int envelopeCheck(JsonVariantConst cfg, EnvelopeViolation& first) {
  Ctx c = { 0, &first };
  first.field = nullptr; first.detail[0] = 0;

  if (!cfg.is<JsonObjectConst>()) { fail(c, nullptr, "config is not an object"); return c.count; }

  JsonVariantConst sys = cfg["sys"], temp = cfg["temp"], hum = cfg["hum"], vent = cfg["vent"],
                   pump = cfg["pump"], photo = cfg["photo"], canopy = cfg["canopy"],
                   arb_a = cfg["arb_a"], arb_b = cfg["arb_b"];

  // ── Reporting cadence ────────────────────────────────────────────────────
  if (!sys.isNull()) {
    checkInt(c, "sys.telemetry_interval_s", sys["telemetry_interval_s"], 1, 3600, true);
    checkInt(c, "sys.stale_after_s",        sys["stale_after_s"],        1, 86400, true);
    // A staleness window shorter than the publish interval makes every reading stale on arrival.
    if (isInt(sys["telemetry_interval_s"]) && isInt(sys["stale_after_s"]) &&
        sys["stale_after_s"].as<int>() <= sys["telemetry_interval_s"].as<int>())
      fail(c, "sys.stale_after_s", "must exceed sys.telemetry_interval_s (%d); every reading would arrive stale",
           sys["telemetry_interval_s"].as<int>());
  }

  // ── Temperature ──────────────────────────────────────────────────────────
  if (!temp.isNull()) {
    checkInt(c, "temp.min_dc",  temp["min_dc"],  DC_MIN, DC_MAX);
    checkInt(c, "temp.max_dc",  temp["max_dc"],  DC_MIN, DC_MAX);
    checkInt(c, "temp.hyst_dc", temp["hyst_dc"], 0,      DC_MAX);
    if (isInt(temp["min_dc"]) && isInt(temp["max_dc"]) && temp["min_dc"].as<int>() >= temp["max_dc"].as<int>())
      fail(c, "temp.min_dc", "must be below temp.max_dc (%d)", temp["max_dc"].as<int>());
  }

  // ── Humidity ─────────────────────────────────────────────────────────────
  if (!hum.isNull()) {
    checkInt(c, "hum.min_pct",  hum["min_pct"],  PCT_MIN, PCT_MAX);
    checkInt(c, "hum.max_pct",  hum["max_pct"],  PCT_MIN, PCT_MAX);
    checkInt(c, "hum.hyst_pct", hum["hyst_pct"], PCT_MIN, PCT_MAX);
    if (isInt(hum["min_pct"]) && isInt(hum["max_pct"]) && hum["min_pct"].as<int>() >= hum["max_pct"].as<int>())
      fail(c, "hum.min_pct", "must be below hum.max_pct (%d)", hum["max_pct"].as<int>());
  }

  // ── Ventilation ──────────────────────────────────────────────────────────
  if (!vent.isNull()) {
    JsonArrayConst offs = vent["stage_offsets_dc"];
    if (offs.isNull() || offs.size() != 3) {
      fail(c, "vent.stage_offsets_dc", "must have exactly 3 entries — three fans");
    } else {
      static const char* const P[3] = { "vent.stage_offsets_dc[0]", "vent.stage_offsets_dc[1]", "vent.stage_offsets_dc[2]" };
      for (int i = 0; i < 3; i++) checkInt(c, P[i], offs[i], 0, DC_MAX, true);
      // Non-ascending offsets mean a later stage engages before an earlier one.
      for (int i = 1; i < 3; i++)
        if (isInt(offs[i]) && isInt(offs[i-1]) && offs[i].as<int>() <= offs[i-1].as<int>()) {
          fail(c, "vent.stage_offsets_dc", "must ascend — stage %d (%d) is not above stage %d (%d)",
               i+1, offs[i].as<int>(), i, offs[i-1].as<int>());
          break;
        }
    }
    // Relays have finite switching life; zero rest lets the loop chatter a contact.
    checkInt(c, "vent.min_off_s", vent["min_off_s"], 1, 86400, true);
  }

  // ── Watering ─────────────────────────────────────────────────────────────
  if (!pump.isNull()) {
    checkInt(c, "pump.soil_start_pct", pump["soil_start_pct"], PCT_MIN, PCT_MAX);
    checkInt(c, "pump.soil_stop_pct",  pump["soil_stop_pct"],  PCT_MIN, PCT_MAX);
    checkInt(c, "pump.max_runtime_s",  pump["max_runtime_s"],  1, PUMP_MAX_RUNTIME_S);
    checkInt(c, "pump.cooldown_s",     pump["cooldown_s"],     0, 86400);
    checkInt(c, "pump.water_min_pct",  pump["water_min_pct"],  PCT_MIN, PCT_MAX);
    // start >= stop: the pump runs until max_runtime_s every cycle. Pump-destroying.
    if (isInt(pump["soil_start_pct"]) && isInt(pump["soil_stop_pct"]) &&
        pump["soil_start_pct"].as<int>() >= pump["soil_stop_pct"].as<int>())
      fail(c, "pump.soil_start_pct", "must be below pump.soil_stop_pct (%d); the pump would never reach its stop condition",
           pump["soil_stop_pct"].as<int>());
  }

  // ── Photoperiod ──────────────────────────────────────────────────────────
  if (!photo.isNull()) {
    checkInt(c, "photo.on_min",        photo["on_min"],        0, MIN_OF_DAY_MAX);
    checkInt(c, "photo.off_min",       photo["off_min"],       0, MIN_OF_DAY_MAX);
    checkInt(c, "photo.tz_offset_min", photo["tz_offset_min"], TZ_MIN, TZ_MAX, true);
    // No on/off ordering rule: a schedule may wrap midnight. That would be agronomy.
  }

  // ── Canopy ───────────────────────────────────────────────────────────────
  if (!canopy.isNull()) {
    if (!canopy["enabled_for_cooling"].is<bool>())
      fail(c, "canopy.enabled_for_cooling", "must be true or false");
    checkInt(c, "canopy.only_above_dc",     canopy["only_above_dc"],     DC_MIN, DC_MAX);
    checkInt(c, "canopy.max_pct",           canopy["max_pct"],           PCT_MIN, PCT_MAX, true);
    checkInt(c, "canopy.step_pct",          canopy["step_pct"],          CANOPY_STEP_MIN, PCT_MAX, true);
    checkInt(c, "canopy.min_dwell_s",       canopy["min_dwell_s"],       CANOPY_DWELL_MIN_S, 86400, true);
    checkInt(c, "canopy.max_shade_min_day", canopy["max_shade_min_day"], 0, MIN_OF_DAY_MAX + 1);
    // A step larger than the ceiling drives the servo against its mechanical limit.
    if (isInt(canopy["max_pct"]) && isInt(canopy["step_pct"]) && canopy["step_pct"].as<int>() > canopy["max_pct"].as<int>())
      fail(c, "canopy.step_pct", "cannot exceed canopy.max_pct (%d)", canopy["max_pct"].as<int>());
  }

  // ── Conflict A: fans vs humidifier ───────────────────────────────────────
  if (!arb_a.isNull()) {
    const char* p = arb_a["priority"] | "";
    if (strcmp(p, "temperature") != 0 && strcmp(p, "humidity") != 0)
      fail(c, "arb_a.priority", "must be temperature or humidity");
    checkInt(c, "arb_a.fan_cap_stage",  arb_a["fan_cap_stage"],  0, VENT_STAGE_MAX, true);
    checkInt(c, "arb_a.max_suppress_s", arb_a["max_suppress_s"], 0, 86400, true);
  }

  // ── Conflict B: canopy vs photoperiod ────────────────────────────────────
  if (!arb_b.isNull()) {
    const char* p = arb_b["priority"] | "";
    if (strcmp(p, "light") != 0 && strcmp(p, "temperature") != 0)
      fail(c, "arb_b.priority", "must be light or temperature");
    checkInt(c, "arb_b.max_pct_in_photo", arb_b["max_pct_in_photo"], PCT_MIN, PCT_MAX, true);
    // Shading beyond the mechanical ceiling is unreachable.
    if (!canopy.isNull() && isInt(canopy["max_pct"]) && isInt(arb_b["max_pct_in_photo"]) &&
        arb_b["max_pct_in_photo"].as<int>() > canopy["max_pct"].as<int>())
      fail(c, "arb_b.max_pct_in_photo", "cannot exceed canopy.max_pct (%d)", canopy["max_pct"].as<int>());
  }

  return c.count;
}
