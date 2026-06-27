// كود محاكاة الـ ESP32 لإرسال بيانات JSON
const data = {
    "deviceId": "ESP32-GH-01",
    "timestamp": "2026-06-25T21:00:00Z",
    "sensors": {
        "ambientTemperature":40.5,
        "ambientHumidity": 62.3,
        "soilMoisture": 45.8,
        "lightIntensity": 450
    },
    "powerManagement": {
        "batteryVoltage": 3.72,
        "batteryPercentage": 85,
        "solarPanelVoltage": 5.10,
        "currentConsumption": 120
    },
    "actuatorsStatus": {
        "waterPump": "OFF",
        "exhaustFan": "OFF",
        "growLights": "ON"
    }
};

// إرسال البيانات إلى السيرفر الخاص بنا
fetch('http://localhost:3000/api/sensors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
})
.then(res => res.json())
.then(json => console.log('الرد القادم من السيرفر:', json))
.catch(err => console.error('حدث خطأ أثناء الإرسال:', err));