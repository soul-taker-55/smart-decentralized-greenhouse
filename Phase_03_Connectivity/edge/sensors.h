// SDIGF edge — sensor layer.
//
// STAGE A: EVERY SENSOR IS A STUB. Nothing is wired. Each reading reports
// q = "init" with val = null — the contract's honest representation of
// "never successfully read since boot" (v4 §3.1). This is not a placeholder
// value; it is the truthful state of a bare board and the bridge stores it
// as SQL NULL, exactly as it would for a real sensor that had not answered.
//
// Phase 02 replaces the bodies, not the interface. Callers (telemetry
// publisher now, control loop later) never change.
#pragma once
#include <stdint.h>

// Contract v4 §3.1 quality flags.
enum SensorQ : uint8_t { Q_OK = 0, Q_STALE, Q_FAIL, Q_INIT };
extern const char* const SENSOR_Q_STR[4];

struct Reading {
  float   val;     // meaningful only when q == Q_OK or Q_STALE
  SensorQ q;
};

// Contract v4 §3.1 keys, in this order. 11 readings.
enum SensorId : uint8_t {
  S_TEMP_IN = 0, S_TEMP_OUT, S_PRESS_IN, S_PRESS_OUT,
  S_HUM_IN, S_HUM_OUT, S_AQ, S_LIGHT_IN, S_LIGHT_OUT, S_SOIL, S_WATER,
  S_COUNT
};
extern const char* const SENSOR_KEYS[S_COUNT];

// true if this key is published as an integer in the contract (§3.1 table).
bool sensorIsInt(SensorId id);

void sensorsInit();
void sensorsPoll();                 // called every loop; drivers rate-limit themselves
Reading sensorGet(SensorId id);
