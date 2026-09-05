// SDIGF edge — safety envelope. THE SECOND ENFORCEMENT GATE.
//
// Port of Phase_04_Logging/4c_tool/mock-edge/src/safety.js. Same shape on
// purpose: a flat list of checks, each naming the field it rejected, so the
// dashboard renders it and the thesis counts by category (v4 §3.4).
//
// WHAT BELONGS HERE: limits that come from the HARDWARE — datasheet ranges,
// pump dry-run, servo stall, relay switching life, definitional bounds.
// WHAT DOES NOT: anything agronomic. "Lettuce prefers 15–22 °C" is the
// engineer's decision, delivered as config. Encoding it here would overrule
// the expert this system exists to serve.
//
// Every bound is traceable to a component or to arithmetic. If a future bound
// cannot be justified that way, it is agronomy and does not belong here.
//
// Server RBAC decides WHO may change a config. This decides whether the values
// are PHYSICALLY SURVIVABLE. A config signed by a full quorum is still rejected
// here if it would flood the enclosure. That independence is the point.
#pragma once
#include <ArduinoJson.h>

struct EnvelopeViolation {
  const char* field;    // dotted path, or nullptr for a structural fault
  char        detail[96];
};

// Returns the number of violations found (0 = survivable). Fills `first` with
// the first one — the ack carries one structured reason, and "N more" in detail.
int envelopeCheck(JsonVariantConst cfg, EnvelopeViolation& first);
