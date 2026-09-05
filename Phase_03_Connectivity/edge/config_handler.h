// SDIGF edge — down/config handler. Contract v4 §3.4, §3.6, §5.
//
// Port of mock-edge handlers.js handleConfig(), same six-step order:
//   1 parse · 2 schema · 3 integrity (SHA-256 over received bytes) ·
//   4 freshness + envelope-vs-signed agreement · 5 safety envelope · 6 apply
//
// STAGE B: no signature verification. `verify` is declared "unsupported" and,
// per §3.4, an unverifying device STILL applies configs that clear the
// envelope. Stage C inserts signature checks between steps 3 and 4 and flips
// the declaration to "enforced". The dataset will show exactly which config
// version that happened at — which is what the field is for.
#pragma once
#include <stdint.h>
#include <stddef.h>

enum ConfigResult : uint8_t { CFG_ACCEPTED, CFG_REJECTED, CFG_IGNORED };

struct ConfigOutcome {
  ConfigResult result;
  uint32_t     ref_ver;        // as received (0 if unparseable)
  char         ref_hash[65];   // as received ("" if absent)
  const char*  code;           // rejection code, or nullptr
  const char*  field;          // dotted path, or nullptr
  char         detail[128];
};

// `raw` is the payload exactly as received; it is NOT modified.
ConfigOutcome handleConfig(const uint8_t* raw, size_t len);
