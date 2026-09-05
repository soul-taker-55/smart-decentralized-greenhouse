// SDIGF edge — applied-config store (NVS).
//
// Holds the config currently RUNNING: version, hash as received, the canonical
// string as received, and where it came from. Persisted so a reboot with no
// broker resumes on last-known-good — the observable fact that makes edge
// autonomy provable (v4 §3.3: cfg.src = "nvs").
//
// Three-tier fallback (brief §7.5): compiled defaults → last-known-good NVS →
// server config. This module owns the middle tier. Phase 02 owns the first
// (it parses `canonical` into its control-loop struct, or uses defaults when
// there is none).
#pragma once
#include <stdint.h>
#include <stddef.h>

// v4 §3.6: measured max payload 1,556 B at four signatures; the canonical
// string alone is ~1,230 B at two. 2 KB leaves headroom.
#define CFG_CANONICAL_MAX 2048
#define CFG_HASH_HEX_LEN  64

enum CfgSrc : uint8_t { CFG_SRC_NONE = 0, CFG_SRC_NVS, CFG_SRC_MQTT };
extern const char* const CFG_SRC_STR[3];

struct AppliedConfig {
  uint32_t ver;                       // 0 = none
  char     hash[CFG_HASH_HEX_LEN + 1];// "" when none
  char     canonical[CFG_CANONICAL_MAX];
  size_t   canonical_len;
  CfgSrc   src;
};

// Load from NVS. src becomes NVS if a record exists, NONE otherwise.
void configStoreInit();

const AppliedConfig& configApplied();

// Persist and mark src = MQTT. Returns false if NVS write failed — the caller
// must then NOT ack "accepted", because an ack the device would forget on
// reboot is a lie (same principle as the mock's estop handler).
bool configStoreApply(uint32_t ver, const char* hash, const char* canonical, size_t len);
