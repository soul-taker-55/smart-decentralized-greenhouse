// SDIGF edge — pin map. Source of truth: Phase_01 wiring doc v1.8, Appendix A.
// Change the wiring doc first, then this file. Never the reverse.
#pragma once

// ---- Relays (active-LOW module, 10k pull-up to 3.3V on every IN) ----
#define PIN_RELAY_PUMP        19   // IN1
#define PIN_RELAY_S_FAN       18   // IN2
#define PIN_RELAY_INT_FAN      5   // IN3 — strapping pin, justified (§9)
#define PIN_RELAY_N_FAN       17   // IN4
#define PIN_RELAY_HUMIDIFIER  16   // IN5
#define PIN_RELAY_LIGHTS       4   // IN6 — LED string
#define PIN_RELAY_GROW_LIGHT  23   // IN7 — 220 V mains. Never on a strapping pin.

// ---- Servo ----
#define PIN_SERVO_CANOPY      25

// ---- E-stop indicator (v1.8) ----
#define PIN_ESTOP_LED          2   // 220 Ω to GND; strapping pin, harmless case (§7.10)

// ---- I²C ----
#define PIN_I2C_SDA           21
#define PIN_I2C_SCL           22

// ---- DHT11 ----
#define PIN_DHT_IN            26
#define PIN_DHT_OUT           27

// ---- ADC1 only (ADC2 is dead while WiFi is on) ----
#define PIN_LDR_IN            36
#define PIN_LDR_OUT           39
#define PIN_SOIL              34
#define PIN_WATER             35
#define PIN_MQ135             32   // via 2.2k/3.3k divider

// ---- Encoder ----
#define PIN_ENC_CLK           13
#define PIN_ENC_DT            14
#define PIN_ENC_SW            33
