// SDIGF Phase 06 — CAM: capture, software JPEG, upload to server.
// Board: AI-Thinker ESP32-CAM layout. Sensor: OV7670-class (PID 0x2145),
// no hardware JPEG encoder — software encode via frame2jpg() is the
// documented workaround, not a design preference. See Phase 06 chapter notes.
//
// STEP 3 of the CAM plan: scheduled uploads only. The on-demand snapshot poll
// (GET /api/camera/pending) is Step 4's job, wired once the dashboard button
// exists to set that flag — building the poll caller before there's a caller
// of the flag would be scope creep ahead of its own dependency.
//
// KNOWN GAP, stated plainly rather than hidden: TLS certificate validation is
// OFF (WiFiClientSecure::setInsecure()). The endpoint only accepts image
// uploads gated by a bearer token; a MITM here can see or drop a JPEG, not
// reach any actuator or control-path route. Certificate pinning against
// greenhouse.progrex.tech is real future work, not silently skipped.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include "esp_camera.h"
#include "img_converters.h"
#include "secrets.h"

// ---- AI-Thinker pin map (fixed by the board, not a choice) ----
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

#define FLASH_LED_PIN      4
#define USE_FLASH       true
#define FLASH_MS         120

#define JPEG_QUALITY      80

// ── CAPTURE INTERVAL ────────────────────────────────────────────────────
// 30 SECONDS FOR BENCH TESTING ONLY. Before real deployment change this to
// a real timelapse interval, e.g. 10 minutes:
//   #define CAPTURE_INTERVAL_MS (10UL * 60UL * 1000UL)
#define CAPTURE_INTERVAL_MS (30UL * 1000UL)

// Server endpoint. Not secret — kept here rather than in secrets.h so
// changing environments (bench vs deployed) doesn't touch the file that
// holds WiFi and device credentials.
#define UPLOAD_URL "https://greenhouse.progrex.tech/api/camera/upload"

static uint32_t frameCount = 0;
static uint32_t uploadOk = 0;
static uint32_t uploadFail = 0;

const char* sensorName(uint16_t pid) {
  switch (pid) {
    case 0x26:   return "OV2640 (hardware JPEG)";
    case 0x2145:
    case 0x76:   return "OV7670-class (no hardware JPEG)";
    case 0x77:   return "OV7725 (no hardware JPEG)";
    case 0x36:   return "OV3660";
    case 0x56:   return "OV5640";
    default:     return "unknown";
  }
}

bool initCamera() {
  camera_config_t c;
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;   c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;   c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;   c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;   c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href  = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn  = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 10000000;
  c.pixel_format = PIXFORMAT_RGB565;
  c.frame_size   = FRAMESIZE_QVGA;
  c.jpeg_quality = 12;
  c.fb_count     = psramFound() ? 2 : 1;
  c.grab_mode    = CAMERA_GRAB_LATEST;
  c.fb_location  = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("[CAM] init FAILED 0x%02X\n", err);
    return false;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s != NULL) {
    Serial.printf("[CAM] sensor PID 0x%02X = %s\n", s->id.PID, sensorName(s->id.PID));
  }
  Serial.println("[CAM] init OK");
  return true;
}

/**
 * ISO 8601 UTC timestamp for x-captured-at, if NTP has synced.
 * Returns false (and leaves out) if the clock isn't trustworthy yet — the
 * server defaults captured_at to its own receipt time in that case, which is
 * honest: an unsynced device should not assert a capture time it can't back.
 */
bool getIsoTimestamp(char *out, size_t outLen) {
  time_t now;
  time(&now);
  if (now < 1700000000) {  // before ~Nov 2023 means NTP hasn't synced
    return false;
  }
  struct tm timeinfo;
  gmtime_r(&now, &timeinfo);
  strftime(out, outLen, "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
  return true;
}

/**
 * Encode and upload one frame. Returns true on a 2xx response.
 *
 * Failure handling matches Phase 03's stated principle for the main
 * controller, applied here to the vision node: the network is an
 * enhancement, never a dependency. A failed upload is logged and the loop
 * continues to the next scheduled capture — it never blocks, retries in a
 * tight loop, or halts the device.
 */
bool captureAndUpload() {
  if (USE_FLASH) { digitalWrite(FLASH_LED_PIN, HIGH); delay(FLASH_MS); }
  camera_fb_t *fb = esp_camera_fb_get();
  if (USE_FLASH) digitalWrite(FLASH_LED_PIN, LOW);

  if (!fb) {
    Serial.println("[CAP] capture FAILED (null frame buffer)");
    return false;
  }

  uint8_t *jpgBuf = NULL;
  size_t   jpgLen = 0;
  bool encOk = frame2jpg(fb, JPEG_QUALITY, &jpgBuf, &jpgLen);
  esp_camera_fb_return(fb);

  if (!encOk) {
    Serial.println("[JPG] encode FAILED");
    return false;
  }

  frameCount++;
  Serial.printf("[JPG] #%lu  %u B  heap %u\n", frameCount, (unsigned)jpgLen, ESP.getFreeHeap());

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[NET] not connected — skipping upload, keeping frame count");
    free(jpgBuf);
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();  // KNOWN GAP — see file header

  HTTPClient http;
  http.begin(client, UPLOAD_URL);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("x-device-token", CAMERA_DEVICE_TOKEN);
  http.addHeader("x-trigger", "schedule");

  char isoTs[32];
  if (getIsoTimestamp(isoTs, sizeof(isoTs))) {
    http.addHeader("x-captured-at", isoTs);
  }

  uint32_t t0 = millis();
  int code = http.POST(jpgBuf, jpgLen);
  uint32_t tUp = millis() - t0;

  bool ok = (code >= 200 && code < 300);
  if (ok) {
    uploadOk++;
    Serial.printf("[UP ] OK  status %d  %lu ms  (ok=%lu fail=%lu)\n",
                  code, tUp, uploadOk, uploadFail);
  } else {
    uploadFail++;
    String body = http.getString();
    Serial.printf("[UP ] FAILED  status %d  %lu ms  body: %s\n", code, tUp, body.c_str());
  }

  http.end();
  free(jpgBuf);
  return ok;
}

void setup() {
  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);

  Serial.begin(115200);
  delay(1500);
  Serial.println("\n\n=== SDIGF Phase 06 — CAM upload ===");
  Serial.printf("[SYS] PSRAM: %s\n", psramFound() ? "found" : "NOT FOUND");

  if (!initCamera()) {
    Serial.println("[FATAL] halting.");
    while (true) delay(1000);
  }

  Serial.printf("[NET] joining %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(500); Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[NET] IP  : %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("[NET] RSSI: %d dBm\n", WiFi.RSSI());

    // NTP for x-captured-at. Failure here is non-fatal — see getIsoTimestamp().
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    Serial.print("[NTP] syncing");
    char tsCheck[32];
    uint32_t tNtp = millis();
    while (!getIsoTimestamp(tsCheck, sizeof(tsCheck)) && millis() - tNtp < 10000) {
      delay(300); Serial.print(".");
    }
    Serial.println();
    Serial.printf("[NTP] %s\n", getIsoTimestamp(tsCheck, sizeof(tsCheck)) ? tsCheck : "NOT SYNCED — server will timestamp on receipt");
  } else {
    Serial.println("[NET] FAILED — will retry upload attempts each cycle regardless");
  }

  Serial.printf("[CFG] capture interval: %lu ms\n", (unsigned long)CAPTURE_INTERVAL_MS);
  Serial.println("=== setup complete ===\n");
}

void loop() {
  captureAndUpload();
  delay(CAPTURE_INTERVAL_MS);
}
