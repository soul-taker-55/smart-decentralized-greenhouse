#include <Arduino.h>
#include <Preferences.h>
#include <string.h>
#include "config_store.h"

const char* const CFG_SRC_STR[3] = { "none", "nvs", "mqtt" };

static AppliedConfig applied;
static Preferences prefs;

void configStoreInit() {
  memset(&applied, 0, sizeof(applied));
  applied.src = CFG_SRC_NONE;

  if (!prefs.begin("cfg", true)) return;          // namespace absent → none
  if (prefs.isKey("ver") && prefs.isKey("canon")) {
    applied.ver = prefs.getULong("ver", 0);
    prefs.getString("hash", applied.hash, sizeof(applied.hash));
    applied.canonical_len = prefs.getString("canon", applied.canonical, sizeof(applied.canonical));
    if (applied.ver > 0 && applied.canonical_len > 0) applied.src = CFG_SRC_NVS;
    else { applied.ver = 0; applied.hash[0] = 0; applied.canonical_len = 0; }
  }
  prefs.end();
}

const AppliedConfig& configApplied() { return applied; }

bool configStoreApply(uint32_t ver, const char* hash, const char* canonical, size_t len) {
  if (len >= CFG_CANONICAL_MAX) return false;

  if (!prefs.begin("cfg", false)) return false;
  bool ok = true;
  ok &= prefs.putULong("ver", ver) > 0;
  ok &= prefs.putString("hash", hash) > 0;
  ok &= prefs.putString("canon", canonical) > 0;
  prefs.end();
  if (!ok) return false;

  applied.ver = ver;
  strncpy(applied.hash, hash, CFG_HASH_HEX_LEN); applied.hash[CFG_HASH_HEX_LEN] = 0;
  memcpy(applied.canonical, canonical, len); applied.canonical[len] = 0;
  applied.canonical_len = len;
  applied.src = CFG_SRC_MQTT;
  return true;
}
