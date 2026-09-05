#include "shim.h"
#include "config_store.h"
const char* const CFG_SRC_STR[3] = { "none", "nvs", "mqtt" };
static AppliedConfig applied = {};
void configStoreInit() { applied = {}; applied.src = CFG_SRC_NONE; }
const AppliedConfig& configApplied() { return applied; }
bool configStoreApply(uint32_t ver, const char* hash, const char* canonical, size_t len) {
  if (len >= CFG_CANONICAL_MAX) return false;
  applied.ver = ver; strncpy(applied.hash, hash, 64); applied.hash[64]=0;
  memcpy(applied.canonical, canonical, len); applied.canonical[len]=0; applied.canonical_len=len; applied.src=CFG_SRC_MQTT; return true;
}
