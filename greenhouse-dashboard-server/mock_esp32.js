const axios = require("axios");
const SERVER_URL = "http://localhost:3000/api/telemetry";

function sendMockData() {
  const mockData = {
    deviceId: "ESP32-GH-01",
    timestamp: new Date().toISOString(),
    sensors: {
      ambientTemperature: (25 + Math.random() * 3).toFixed(1),
      ambientHumidity: (60 + Math.random() * 5).toFixed(1),
      soilMoisture: (45 - Math.random() * 2).toFixed(1),
      lightIntensity: Math.floor(400 + Math.random() * 100),
    },
    powerManagement: {
      batteryVoltage: 3.72,
      batteryPercentage: 85,
      solarPanelVoltage: 5.1,
      currentConsumption: 120,
    },
    actuatorsStatus: {
      waterPump: "OFF",
      exhaustFan: "OFF",
      growLights: "ON",
    },
  };

  axios
    .post(SERVER_URL, mockData)
    .then((res) => console.log("Mock Data Sent:", res.data))
    .catch((err) => console.error("Error sending data:", err.message));
}

setInterval(sendMockData, 5000);
