const http = require('http');

// البيانات الافتراضية الدقيقة المطابقة لدوكيومنت المشروع تماماً
const greenhouseData = JSON.stringify({
  deviceId: "ESP32_WROOM_32E_G01",
  analogSensors: {
    rainSensor: 1024.0, // لا يوجد مطر
    mq135Gas: 320.5,
    waterSensor1: 45.2, // التربة جافة (ستعمل المضخة)
    waterSensor2: 88.0,
    ldrInner: 620.0,
    ldrOuter: 850.0
  },
  digitalSensors: {
    dht11Inner: { "temperature": 32.5, "humidity": 60.0 }, // حرارة مرتفعة (ستعمل المراوح)
    dht11Outer: { "temperature": 32.0, "humidity": 45.0 }
  },
  i2cSensors: {
    bmp280Inner: { "pressure": 1013.25, "temperature": 25.8 },
    bmp280Outer: { "pressure": 1011.10, "temperature": 31.4 }
  }
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/greenhouse/data',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': greenhouseData.length
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  
  res.on('end', () => {
    console.log('\n==================================================');
    console.log('📡 [ESP32 Emulator]: تم إرسال حزمة الحساسات بنجاح!');
    console.log('==================================================');
    console.log('📥 [جيسن التحكم الراجع من السيرفر]:\n', JSON.stringify(JSON.parse(data), null, 2));
    console.log('==================================================\n');
  });
});

req.on('error', (error) => {
  console.error(`❌ فشل الاتصال بالسيرفر: ${error.message}`);
});

req.write(greenhouseData);
req.end();