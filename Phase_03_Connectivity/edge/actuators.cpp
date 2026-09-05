#include <Arduino.h>
#include "actuators.h"
#include "pins.h"

const char* const ACTUATOR_KEYS[ACT_COUNT] = {
  "pump", "s_fan", "internal_fan", "n_fan", "humidifier", "lights", "grow_light"
};

static const uint8_t PINS[ACT_COUNT] = {
  PIN_RELAY_PUMP, PIN_RELAY_S_FAN, PIN_RELAY_INT_FAN, PIN_RELAY_N_FAN,
  PIN_RELAY_HUMIDIFIER, PIN_RELAY_LIGHTS, PIN_RELAY_GROW_LIGHT
};

static ActuatorState state[ACT_COUNT];

// Active-LOW: logical ON = electrical LOW. This is the one place that fact lives.
static inline void drive(uint8_t pin, bool on) {
  digitalWrite(pin, on ? LOW : HIGH);
}

void actuatorsSafeInit() {
  for (uint8_t i = 0; i < ACT_COUNT; i++) {
    // Write HIGH before switching to OUTPUT so the pin never drives LOW,
    // not even for the microseconds between the two calls.
    digitalWrite(PINS[i], HIGH);
    pinMode(PINS[i], OUTPUT);
    digitalWrite(PINS[i], HIGH);
    state[i] = { false, SRC_AUTO, (uint32_t)millis(), 0 };
  }
}

void actuatorSet(ActuatorId id, bool on, ActuatorSrc src) {
  if (id >= ACT_COUNT) return;
  ActuatorState& s = state[id];
  if (s.on != on) s.since_ms = millis();
  s.on  = on;
  s.src = src;
  drive(PINS[id], on);
}

const ActuatorState& actuatorGet(ActuatorId id) {
  return state[id < ACT_COUNT ? id : 0];
}

uint8_t actuatorVentStage() {
  return (uint8_t)(state[ACT_S_FAN].on + state[ACT_INT_FAN].on + state[ACT_N_FAN].on);
}

void actuatorsAllOff() {
  for (uint8_t i = 0; i < ACT_COUNT; i++) actuatorSet((ActuatorId)i, false, SRC_SAFETY);
}
