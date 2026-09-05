#include "shim.h"
#include "config_handler.h"
#include "config_store.h"
#include <string>
static int pass=0, fail=0;
static void expect(const char* name, const char* payload, ConfigResult r, const char* code) {
  ConfigOutcome o = handleConfig((const uint8_t*)payload, strlen(payload));
  bool ok = o.result == r && (code == nullptr ? o.code == nullptr : (o.code && strcmp(o.code, code) == 0));
  printf("%s %-28s -> %s %s | %s\n", ok ? "PASS" : "FAIL", name,
         o.result==CFG_ACCEPTED?"accepted":o.result==CFG_REJECTED?"rejected":"ignored", o.code?o.code:"-", o.detail);
  ok ? pass++ : fail++;
}
// Build a down/config envelope around a canonical string, computing the real hash.
static std::string env(const char* canon, int ver, const char* gh, const char* hashOverride=nullptr, int v=1) {
  unsigned char d[32]; host_sha256((const unsigned char*)canon, strlen(canon), d);
  char hex[65]; for(int i=0;i<32;i++) sprintf(hex+2*i,"%02x",d[i]);
  std::string esc; for (const char* p=canon; *p; p++) { if(*p=='"'||*p=='\\') esc+='\\'; esc+=*p; }
  char buf[4096];
  snprintf(buf,sizeof buf,"{\"v\":%d,\"ts\":1,\"gh\":\"%s\",\"ver\":%d,\"alg\":\"es256\",\"keys_ver\":1,\"cfg_hash\":\"%s\",\"cfg_canonical\":\"%s\",\"sigs\":[]}",
           v, gh, ver, hashOverride?hashOverride:hex, esc.c_str());
  return buf;
}
int main() {
  configStoreInit();
  // 0. contract test vector: SHA-256 path must reproduce 911a72…a908
  { const char* c="{\"a\":[3,1,2],\"b\":{\"x\":1,\"y\":2},\"c\":null,\"d\":true}"; unsigned char d[32]; host_sha256((const unsigned char*)c,strlen(c),d);
    char hex[65]; for(int i=0;i<32;i++) sprintf(hex+2*i,"%02x",d[i]);
    bool ok = strcmp(hex,"911a7250d4853dec84df401015ab201c6241ee1c87fb6e70862afd13e087a908")==0;
    printf("%s contract test vector SHA-256 = %s\n", ok?"PASS":"FAIL", hex); ok?pass++:fail++; }

  const char* GOOD = "{\"cfg\":{\"sys\":{\"telemetry_interval_s\":30,\"stale_after_s\":60},\"vent\":{\"stage_offsets_dc\":[0,20,40],\"min_off_s\":60},\"photo\":{\"tz_offset_min\":0},\"canopy\":{\"enabled_for_cooling\":true,\"max_pct\":100,\"step_pct\":10,\"min_dwell_s\":30},\"arb_a\":{\"priority\":\"temperature\",\"fan_cap_stage\":1,\"max_suppress_s\":900},\"arb_b\":{\"priority\":\"light\",\"max_pct_in_photo\":30}},\"gh\":\"gh1\",\"ver\":1}";
  const char* FLOOD = "{\"cfg\":{\"sys\":{\"telemetry_interval_s\":30,\"stale_after_s\":60},\"pump\":{\"max_runtime_s\":18000},\"vent\":{\"stage_offsets_dc\":[0,20,40],\"min_off_s\":60},\"photo\":{\"tz_offset_min\":0},\"canopy\":{\"enabled_for_cooling\":true,\"max_pct\":100,\"step_pct\":10,\"min_dwell_s\":30},\"arb_a\":{\"priority\":\"temperature\",\"fan_cap_stage\":1,\"max_suppress_s\":900},\"arb_b\":{\"priority\":\"light\",\"max_pct_in_photo\":30}},\"gh\":\"gh1\",\"ver\":2}";

  expect("empty retained (cleared)", "   ", CFG_IGNORED, nullptr);
  expect("not JSON",                  "{nope", CFG_REJECTED, "PARSE");
  expect("wrong schema v",            env(GOOD,1,"gh1",nullptr,2).c_str(), CFG_REJECTED, "SCHEMA");
  expect("missing cfg_hash",          "{\"v\":1,\"gh\":\"gh1\",\"ver\":1,\"cfg_canonical\":\"{}\"}", CFG_REJECTED, "PARSE");
  expect("hash mismatch",             env(GOOD,1,"gh1","0000000000000000000000000000000000000000000000000000000000000000").c_str(), CFG_REJECTED, "HASH_MISMATCH");
  expect("envelope ver != signed",    env(GOOD,7,"gh1").c_str(), CFG_REJECTED, "VER_STALE");
  expect("wrong greenhouse",          env("{\"cfg\":{},\"gh\":\"gh2\",\"ver\":1}",1,"gh2").c_str(), CFG_REJECTED, "VER_STALE");
  expect("ENVELOPE: pump 18000s",     env(FLOOD,2,"gh1").c_str(), CFG_REJECTED, "ENVELOPE");
  expect("good config ver 1",         env(GOOD,1,"gh1").c_str(), CFG_ACCEPTED, nullptr);
  expect("same ver again → stale",    env(GOOD,1,"gh1").c_str(), CFG_REJECTED, "NOT_NEWER");
  printf("\n%d passed, %d failed\n", pass, fail);
  return fail;
}
