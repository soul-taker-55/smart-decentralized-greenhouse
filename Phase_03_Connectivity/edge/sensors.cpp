#include <Arduino.h>
#include "sensors.h"

const char* const SENSOR_Q_STR[4] = { "ok", "stale", "fail", "init" };

const char* const SENSOR_KEYS[S_COUNT] = {
  "temp_in", "temp_out", "press_in", "press_out",
  "hum_in", "hum_out", "aq", "light_in", "light_out", "soil", "water"
};

bool sensorIsInt(SensorId id) {
  switch (id) {
    case S_TEMP_IN: case S_TEMP_OUT: case S_PRESS_IN: case S_PRESS_OUT: return false;
    default: return true;
  }
}

static Reading readings[S_COUNT];

void sensorsInit() {
  for (uint8_t i = 0; i < S_COUNT; i++) readings[i] = { 0.0f, Q_INIT };
}

// STUB. Phase 02 fills this in per driver. Until then every reading stays
// Q_INIT, which the telemetry publisher renders as {"val": null, "q": "init"}.
void sensorsPoll() {}

Reading sensorGet(SensorId id) {
  return readings[id < S_COUNT ? id : 0];
}
