const axios = require("axios");
const SERVER_URL = "http://localhost:3000/api/telemetry";

function sendMockData() {
  const mockData = {
    device_id: "ESP32_GH_01",
    firmware_version: "1.0.0",
    timestamp: new Date().toISOString(),
    uptime_seconds: 3600,
    wifi_rssi: -45,
    status: "online",
    sensors: {
      indoor: {
        dht11: { temperature_c: 27.3, humidity_pct: 62.5 },
        bmp280: {
          temperature_c: 27.1,
          pressure_hpa: 1013.25,
          altitude_m: 48.2,
        },
        ldr: { light_raw: 2450, light_pct: 59.8 },
      },
      // ... أكمل باقي أقسام الـ sensors كما في الهيكل الذي أرسلته
    },
    actuators: {
      fans: { south_fan: false, north_fan: false },
      pump: false,
      lights: { storage: false, control_room: true, green_area: true },
      servos: { windows_angle: 0, roof_angle: 0 },
    },
  };

  axios
    .post(SERVER_URL, mockData)
    .then((res) => console.log("تم إرسال البيانات بنجاح"))
    .catch((err) => console.error("خطأ:", err.message));
}
// أضف هذا السطر في نهاية الملف
sendMockData();
