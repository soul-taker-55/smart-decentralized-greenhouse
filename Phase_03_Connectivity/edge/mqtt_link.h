// SDIGF edge — MQTT link. Contract v4 §1, §2, §3.1–3.3, §3.5.
//
// Stage A publishes: status (with last will), up/health, up/telemetry,
// up/actuators. Subscribes to down/# so stage B can attach handlers without
// touching this file's connection logic.
//
// THE NETWORK IS AN ENHANCEMENT, NEVER A DEPENDENCY. Every function here
// returns promptly whether or not the broker is reachable. Nothing blocks the
// loop waiting for a connection; reconnect is attempted on a backoff timer.
#pragma once
#include <stdint.h>

#define FW_VERSION "0.1.0-A"

void mqttInit();       // sets buffer size, LWT, callback. Does not connect.
void mqttLoop();       // call every loop(): maintains connection, pumps client
bool mqttConnected();
uint32_t mqttReconnects();

// Publishers. Each returns true if the publish was handed to the client.
bool publishStatusOnline();
bool publishHealth();
bool publishTelemetry();
bool publishActuators();

// Shared envelope helpers (v4 §2).
uint32_t envelopeTs();        // unix seconds if NTP synced, else seconds since boot
const char* envelopeTsq();    // "ntp" | "boot"
uint32_t envelopeNextSeq();   // monotonic, resets on reboot
