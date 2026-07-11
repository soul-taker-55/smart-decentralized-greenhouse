const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let latestGreenhouseData = {};

app.post("/api/telemetry", (req, res) => {
  try {
    const telemetryData = req.body;

    // التعديل هنا: استخدام device_id حسب الهيكل الجديد الذي طلبته
    if (!telemetryData.device_id) {
      return res.status(400).json({ error: "Invalid data: missing device_id" });
    }

    latestGreenhouseData = telemetryData;

    console.log(
      `[${new Date().toISOString()}] Data received from ${telemetryData.device_id}`,
    );

    // يمكنك طباعة الكائن كاملاً لرؤية الهيكل الجديد في الترمينال
    console.log("Telemetry received:", JSON.stringify(telemetryData, null, 2));

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
