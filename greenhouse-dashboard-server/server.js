const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
let latestGreenhouseData = {};

app.post("/api/telemetry", (req, res) => {
  try {
    const telemetryData = req.body;
    if (!telemetryData.deviceId) {
      return res.status(400).json({ error: "Invalid data" });
    }
    latestGreenhouseData = telemetryData;
    console.log(
      `[${new Date().toISOString()}] Data received from ${telemetryData.deviceId}`,
    );
    console.log(
      "Telemetry details:",
      JSON.stringify(telemetryData.sensors, null, 2),
    );
    res.status(200).json({ status: "success", message: "Telemetry received" });
  } catch (error) {
    res.status(500).json({ error: "Internal Error" });
  }
});

app.get("/api/telemetry/latest", (req, res) => {
  res.status(200).json(latestGreenhouseData);
});

app.listen(PORT, () => {
  console.log(`Greenhouse Core Server is running on port ${PORT}`);
});
