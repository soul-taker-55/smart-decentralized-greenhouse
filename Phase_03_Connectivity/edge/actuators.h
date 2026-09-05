// SDIGF edge — actuator layer.
//
// THE ONLY FILE THAT KNOWS THE RELAY MODULE IS ACTIVE-LOW. Every caller speaks
// in logical terms (on/off); the polarity inversion lives here and nowhere
// else. Contract v4 §3.2: "on: true means the GPIO is driven LOW."
//
// Stage A: relays are real GPIO, driven HIGH (off) as the first action in
// setup() per wiring doc §9. Nothing turns anything on yet — there is no
// control loop and no command handler. Both plug into this layer later.
#pragma once
#include <stdint.h>

enum ActuatorId : uint8_t {
  ACT_PUMP = 0,
  ACT_S_FAN,
  ACT_INT_FAN,
  ACT_N_FAN,
  ACT_HUMIDIFIER,
  ACT_LIGHTS,
  ACT_GROW_LIGHT,
  ACT_COUNT
};

// Contract v4 §3.2 key names, in ActuatorId order.
extern const char* const ACTUATOR_KEYS[ACT_COUNT];

// Source of the current state. Contract v4 §3.2 `src`.
enum ActuatorSrc : uint8_t { SRC_AUTO = 0, SRC_MANUAL, SRC_SAFETY };

struct ActuatorState {
  bool        on;
  ActuatorSrc src;
  uint32_t    since_ms;   // millis() at last state change
  uint32_t    ovr_until_ms; // 0 unless src == SRC_MANUAL
};

// MUST be the first call in setup(). Drives every relay pin OUTPUT + HIGH
// before Serial, WiFi, or anything else. Wiring doc §9, layer 2.
void actuatorsSafeInit();

void actuatorSet(ActuatorId id, bool on, ActuatorSrc src);
const ActuatorState& actuatorGet(ActuatorId id);

// Derived ventilation stage 0–3 (count of fans on). Contract §3.2 `vent`.
uint8_t actuatorVentStage();

// All off, src = SRC_SAFETY. Used by e-stop.
void actuatorsAllOff();
