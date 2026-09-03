// SDIGF Phase 06 — ESP32-CAM bring-up
// Board: AI-Thinker ESP32-CAM layout
// Sensor: unconfirmed — driver rejects JPEG, so likely OV7670 not OV2640.
//         This sketch identifies it by PID on successful init.
// Purpose: prove the hardware before any network upload exists.
// Captures one frame per cycle and reports size, WiFi and heap over serial.
// NO upload, NO MQTT. Evidence-gathering only.

#include <Arduino.h>
#include <WiFi.h>
#include "esp_camera.h"
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
#define USE_FLASH       true      // set false if the rail browns out
#define FLASH_MS         120

static uint32_t frameCount = 0;

const char* sensorName(uint16_t pid) {
  switch (pid) {
    case 0x26: return "OV2640 (has JPEG encoder)";
    case 0x76: return "OV7670 (NO JPEG encoder)";
    case 0x77: return "OV7725 (NO JPEG encoder)";
    case 0x36: return "OV3660";
    case 0x56: return "OV5640";
    default:   return "unknown";
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
  c.pixel_format = PIXFORMAT_RGB565;   // raw — sensor has no JPEG encoder
  c.frame_size   = FRAMESIZE_QVGA;     // 320x240 = 150 KB/frame in RGB565
  c.jpeg_quality = 12;                 // ignored for RGB565, kept for later
  c.fb_count     = psramFound() ? 2 : 1;
  c.grab_mode    = CAMERA_GRAB_LATEST;
  c.fb_location  = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("[CAM] init FAILED 0x%02X\n", err);
    if (err == 0x105) {
      Serial.println("[CAM] 0x105 = no sensor answered: ribbon seating or power.");
    } else if (err == 0x106) {
      Serial.println("[CAM] 0x106 = sensor identified but rejected the requested format.");
    }
    return false;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s != NULL) {
    Serial.printf("[CAM] sensor PID 0x%02X = %s\n", s->id.PID, sensorName(s->id.PID));
  } else {
    Serial.println("[CAM] WARNING: sensor_get() returned NULL after init OK");
  }

  Serial.println("[CAM] init OK");
  return true;
}

void setup() {
  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);   // never on at boot

  Serial.begin(115200);
  delay(1500);
  Serial.println("\n\n=== SDIGF Phase 06 — CAM bring-up ===");
  Serial.printf("[SYS] PSRAM: %s\n", psramFound() ? "found" : "NOT FOUND");
  Serial.printf("[SYS] free heap: %u B\n", ESP.getFreeHeap());

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
    Serial.printf("[NET] MAC : %s\n", WiFi.macAddress().c_str());
  } else {
    Serial.println("[NET] FAILED — camera test continues regardless.");
  }
  Serial.println("=== setup complete ===\n");
}

void loop() {
  if (USE_FLASH) { digitalWrite(FLASH_LED_PIN, HIGH); delay(FLASH_MS); }
  camera_fb_t *fb = esp_camera_fb_get();
  if (USE_FLASH) digitalWrite(FLASH_LED_PIN, LOW);

  if (!fb) {
    Serial.println("[CAP] capture FAILED (null frame buffer)");
  } else {
    frameCount++;
    Serial.printf("[CAP] #%lu  %ux%u  %u B  fmt %d  heap %u  rssi %d\n",
                  frameCount, fb->width, fb->height, fb->len, fb->format,
                  ESP.getFreeHeap(),
                  WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
    esp_camera_fb_return(fb);     // mandatory — leaking this exhausts PSRAM
  }
  delay(5000);
}