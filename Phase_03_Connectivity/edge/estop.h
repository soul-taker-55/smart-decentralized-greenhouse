// SDIGF edge — emergency stop flag and indicator.
//
// STAGE A SCOPE: read the persisted flag from NVS, drive the GPIO 2 LED,
// expose the state. Trigger and clear (local via encoder, remote via
// down/estop) are Phase 02 / stage E. Nothing here changes the flag yet.
//
// FAIL-CLOSED ORIGIN RULE (project planner decision, 6 Sep 2026):
// If the NVS record is absent or unreadable, origin is treated as REMOTE.
// A stop whose origin cannot be proven local must not be clearable locally.
// Cost: a genuinely local stop whose record was lost becomes clearable only
// from the dashboard. Accepted — the alternative lets anyone with physical
// access clear a stop an identified engineer set remotely, which is the exact
// authority downgrade the origin rule exists to prevent.
#pragma once
#include <stdint.h>

enum EstopOrigin : uint8_t { ORIGIN_LOCAL = 0, ORIGIN_REMOTE = 1 };

struct EstopState {
  bool        active;
  EstopOrigin origin;
  uint32_t    since;      // unix seconds if known, else 0
  uint32_t    seq;        // server-allocated; edge never invents one (v4 §3.9)
  bool        nvs_valid;  // false if the record was absent/corrupt → origin forced REMOTE
};

// MUST be the second call in setup(), immediately after actuatorsSafeInit().
// Reads NVS, drives the LED. Wiring doc §7.10 / §9.
void estopInit();

const EstopState& estopGet();
void estopDriveLed();   // reflects current state onto GPIO 2
