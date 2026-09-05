#include <Arduino.h>
#include <ArduinoJson.h>
#include <mbedtls/sha256.h>
#include <string.h>
#include <stdio.h>
#include "config_handler.h"
#include "config_store.h"
#include "envelope.h"

#define GH_ID              "gh1"
#define SUPPORTED_SCHEMA_V 1

static ConfigOutcome reject(ConfigOutcome& o, const char* code, const char* field, const char* fmt, ...) {
  o.result = CFG_REJECTED; o.code = code; o.field = field;
  va_list ap; va_start(ap, fmt);
  vsnprintf(o.detail, sizeof(o.detail), fmt, ap);
  va_end(ap);
  return o;
}

// SHA-256 over exactly the bytes we were handed. No re-serialization — that
// is the entire reason cfg_canonical replaced cfg on the wire (§5).
static void sha256Hex(const uint8_t* data, size_t len, char out[65]) {
  uint8_t d[32];
  mbedtls_sha256(data, len, d, 0);
  static const char* H = "0123456789abcdef";
  for (int i = 0; i < 32; i++) { out[i*2] = H[d[i] >> 4]; out[i*2+1] = H[d[i] & 15]; }
  out[64] = 0;
}

ConfigOutcome handleConfig(const uint8_t* raw, size_t len) {
  ConfigOutcome o;
  memset(&o, 0, sizeof(o));
  o.result = CFG_REJECTED;

  // ── 1. Parse ──────────────────────────────────────────────────────────────
  // An EMPTY retained payload is how a retained message is deleted — the server
  // clears down/config when no profile is active. Not a malformed config.
  bool blank = true;
  for (size_t i = 0; i < len; i++) if (raw[i] > ' ') { blank = false; break; }
  if (blank) { o.result = CFG_IGNORED; snprintf(o.detail, sizeof(o.detail), "retained config cleared by the server"); return o; }

  // ArduinoJson zero-copies strings from a mutable buffer, so we copy once and
  // keep the copy alive for the whole handler. PubSubClient reuses its buffer.
  char* buf = (char*)malloc(len + 1);
  if (!buf) return reject(o, "PARSE", nullptr, "out of memory for %u B payload", (unsigned)len);
  memcpy(buf, raw, len); buf[len] = 0;

  JsonDocument msg;
  DeserializationError err = deserializeJson(msg, buf, len);
  if (err) { reject(o, "PARSE", nullptr, "not valid JSON: %s", err.c_str()); free(buf); return o; }

  o.ref_ver = msg["ver"] | 0;
  const char* h = msg["cfg_hash"] | "";
  strncpy(o.ref_hash, h, 64); o.ref_hash[64] = 0;

  // ── 2. Schema ─────────────────────────────────────────────────────────────
  if ((msg["v"] | -1) != SUPPORTED_SCHEMA_V) {
    reject(o, "SCHEMA", "v", "unsupported schema version %d", msg["v"] | -1); free(buf); return o;
  }
  static const char* const REQ[4] = { "ver", "gh", "cfg_hash", "cfg_canonical" };
  for (int i = 0; i < 4; i++) if (msg[REQ[i]].isNull()) {
    reject(o, "PARSE", REQ[i], "required field missing"); free(buf); return o;
  }

  // ── 3. Integrity ──────────────────────────────────────────────────────────
  const char* canonical = msg["cfg_canonical"].as<const char*>();
  size_t canonLen = strlen(canonical);
  char computed[65];
  sha256Hex((const uint8_t*)canonical, canonLen, computed);
  // Compare lowercase; the contract specifies lowercase hex but be tolerant on input case.
  bool match = strlen(h) == 64;
  for (int i = 0; match && i < 64; i++) if (tolower((unsigned char)h[i]) != computed[i]) match = false;
  if (!match) {
    reject(o, "HASH_MISMATCH", "cfg_hash", "computed %.16s… over the received bytes, envelope claims %.16s…", computed, h);
    free(buf); return o;
  }

  // The signed content must now be parseable — the hash just proved it intact.
  JsonDocument signedDoc;
  err = deserializeJson(signedDoc, canonical, canonLen);
  if (err) { reject(o, "PARSE", "cfg_canonical", "intact but unparseable: %s", err.c_str()); free(buf); return o; }

  // ── (stage C inserts signature verification HERE) ─────────────────────────

  // ── 4. Freshness, and envelope-vs-signed agreement ────────────────────────
  // v4 moved ver and gh INSIDE the signed content to close a replay/downgrade
  // hole. The envelope copies are convenience only. THE SIGNED COPIES WIN, and
  // a disagreement between them is itself the attack signature.
  uint32_t signedVer = signedDoc["ver"] | 0;
  const char* signedGh = signedDoc["gh"] | "";
  const char* envGh = msg["gh"] | "";
  if (signedVer != o.ref_ver || strcmp(signedGh, envGh) != 0) {
    reject(o, "VER_STALE", nullptr, "envelope (ver %lu, gh %s) disagrees with signed content (ver %lu, gh %s)",
           (unsigned long)o.ref_ver, envGh, (unsigned long)signedVer, signedGh);
    free(buf); return o;
  }
  if (strcmp(signedGh, GH_ID) != 0) {
    reject(o, "VER_STALE", "gh", "addressed to %s, this device is %s", signedGh, GH_ID); free(buf); return o;
  }
  // Equal counts as stale: re-applying would cancel active overrides for no reason.
  if (signedVer <= configApplied().ver) {
    reject(o, "NOT_NEWER", "ver", "received ver %lu, already running ver %lu",
           (unsigned long)signedVer, (unsigned long)configApplied().ver);
    free(buf); return o;
  }

  // ── 5. Safety envelope ────────────────────────────────────────────────────
  // The second gate, independent of the first. A config signed by a full quorum
  // is still rejected here if the values would damage equipment.
  EnvelopeViolation v;
  int n = envelopeCheck(signedDoc["cfg"], v);
  if (n > 0) {
    if (n == 1) reject(o, "ENVELOPE", v.field, "%s", v.detail);
    else        reject(o, "ENVELOPE", v.field, "%s (and %d more)", v.detail, n - 1);
    free(buf); return o;
  }

  // ── 6. Apply, then acknowledge ────────────────────────────────────────────
  // Persist BEFORE acking. An ack claiming a config the device forgets on
  // reboot would survive a power cut as a lie. §3.9 rule 3 (stage E): while
  // stopped, the config is STORED but not acted on — that distinction lives in
  // the control loop, not here; this module always stores.
  if (!configStoreApply(signedVer, computed, canonical, canonLen)) {
    reject(o, "PARSE", nullptr, "NVS write failed; config not applied"); free(buf); return o;
  }

  o.result = CFG_ACCEPTED;
  o.code = nullptr; o.field = nullptr;
  snprintf(o.detail, sizeof(o.detail), "applied ver %lu", (unsigned long)signedVer);
  free(buf);
  return o;
}
