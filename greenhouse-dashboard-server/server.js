const express = require("express");
const app = express();
const db = require("./db"); // تأكدي أن ملف db.js موجود
const PORT = 3000;

app.use(express.json());

// 1. مسار الاستقبال (هذا هو الذي سيحفظ البيانات في الجداول)
app.post("/api/telemetry", (req, res) => {
  const data = req.body;
  const sqlLog = `INSERT INTO telemetry_logs (device_id, firmware_version, timestamp, uptime_seconds, wifi_rssi, status) VALUES (?, ?, ?, ?, ?, ?)`;

  db.query(
    sqlLog,
    [
      data.device_id,
      data.firmware_version,
      data.timestamp,
      data.uptime_seconds,
      data.wifi_rssi,
      data.status,
    ],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const logId = result.insertId;

      const sqlSens = `INSERT INTO sensors_data (log_id, in_dht_temp, in_dht_hum, in_bmp_temp, in_bmp_press, in_bmp_alt, in_ldr_raw, in_ldr_pct, out_dht_temp, out_dht_hum, out_bmp_temp, out_bmp_press, out_bmp_alt, out_ldr_raw, out_ldr_pct, rain_raw, is_raining, mq135_raw, gas_ppm, w1_raw, w1_pct, w2_raw, w2_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      db.query(sqlSens, [
        logId,
        data.sensors.indoor.dht11.temperature_c,
        data.sensors.indoor.dht11.humidity_pct,
        data.sensors.indoor.bmp280.temperature_c,
        data.sensors.indoor.bmp280.pressure_hpa,
        data.sensors.indoor.bmp280.altitude_m,
        data.sensors.indoor.ldr.light_raw,
        data.sensors.indoor.ldr.light_pct,
        data.sensors.outdoor.dht11.temperature_c,
        data.sensors.outdoor.dht11.humidity_pct,
        data.sensors.outdoor.bmp280.temperature_c,
        data.sensors.outdoor.bmp280.pressure_hpa,
        data.sensors.outdoor.bmp280.altitude_m,
        data.sensors.outdoor.ldr.light_raw,
        data.sensors.outdoor.ldr.light_pct,
        data.sensors.rain.rain_raw,
        data.sensors.rain.is_raining,
        data.sensors.air_quality.mq135_raw,
        data.sensors.air_quality.gas_ppm,
        data.sensors.water_level.sensor_1_raw,
        data.sensors.water_level.sensor_1_pct,
        data.sensors.water_level.sensor_2_raw,
        data.sensors.water_level.sensor_2_pct,
      ]);

      const sqlAct = `INSERT INTO actuators_state (log_id, south_fan, north_fan, pump, light_storage, light_croom, light_green, win_angle, roof_angle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      db.query(sqlAct, [
        logId,
        data.actuators.fans.south_fan,
        data.actuators.fans.north_fan,
        data.actuators.pump,
        data.actuators.lights.storage,
        data.actuators.lights.control_room,
        data.actuators.lights.green_area,
        data.actuators.servos.windows_angle,
        data.actuators.servos.roof_angle,
      ]);

      res.status(200).json({ status: "success" });
    },
  );
});

// 2. مسار عرض البيانات (هنا سنضع كود الـ JOIN)
app.get("/api/dashboard/data", (req, res) => {
  const sql = `SELECT t.*, s.*, a.* FROM telemetry_logs t 
                 JOIN sensors_data s ON t.id = s.log_id 
                 JOIN actuators_state a ON t.id = a.log_id 
                 ORDER BY t.id DESC LIMIT 1`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results[0] || { message: "لا توجد بيانات بعد" });
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
