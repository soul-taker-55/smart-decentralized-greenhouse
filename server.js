const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cors());

// إعدادات الاتصال بقاعدة البيانات العلائقية المحلية
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '', // ضعي كلمة مرور الـ MySQL الخاصة بجهازكِ هنا إن وجدت
    database: 'greenhouse_db'
};

// استقبال قراءات الـ ESP32 وإرسال جيسن التحكم العكسي فوراً
app.post('/api/greenhouse/data', async (req, res) => {
    try {
        const { analogSensors, digitalSensors, i2cSensors } = req.body;

        // منطق التحكم التلقائي (Control Logic) بناءً على وثيقة المشروع
        let southFan = "OFF";
        let northFan = "OFF";
        let waterPump = "OFF";
        let greenAreaLights = "OFF";
        let windowsServo = 0;   
        let roofServo = 0;      

        // 1. اتخاذ القرار برمجياً بناءً على الحساسات
        if (digitalSensors.dht11Inner.temperature > 30.0) {
            southFan = "ON";  
            northFan = "ON";
            windowsServo = 90; 
        }
        if (analogSensors.waterSensor1 < 50.0) {
            waterPump = "ON"; 
        }
        if (analogSensors.ldrInner < 400.0) {
            greenAreaLights = "ON"; 
        }
        if (analogSensors.rainSensor < 500.0) {
            roofServo = 0; 
        } else {
            roofServo = 45; 
        }

        // 2. محاولة التخزين في قاعدة البيانات (مع حمايتها بـ try-catch داخلي لمنع انهيار الرد العكسي)
        try {
            const connection = await mysql.createConnection(dbConfig);

            // حفظ الحساسات
            await connection.execute(
                `INSERT INTO greenhouse_sensors 
                (rain_sensor, mq135_gas, water_sensor_1, water_sensor_2, ldr_inner, ldr_outer, dht11_inner_temp, dht11_inner_hum, dht11_outer_temp, dht11_outer_hum, bmp280_inner_press, bmp280_inner_temp, bmp280_outer_press, bmp280_outer_temp) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    analogSensors.rainSensor, analogSensors.mq135Gas, analogSensors.waterSensor1, analogSensors.waterSensor2,
                    analogSensors.ldrInner, analogSensors.ldrOuter, digitalSensors.dht11Inner.temperature, digitalSensors.dht11Inner.humidity,
                    digitalSensors.dht11Outer.temperature, digitalSensors.dht11Outer.humidity, i2cSensors.bmp280Inner.pressure, i2cSensors.bmp280Inner.temperature,
                    i2cSensors.bmp280Outer.pressure, i2cSensors.bmp280Outer.temperature
                ]
            );

            // حفظ المشغلات
            await connection.execute(
                `INSERT INTO greenhouse_actuators (south_fan, north_fan, storage_lights, c_room_lights, green_area_lights, water_pump, windows_servo_angle, roof_servo_angle) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [southFan, northFan, "OFF", "OFF", greenAreaLights, waterPump, windowsServo, roofServo]
            );

            await connection.end();
            console.log("📥 [MySQL]: تم حفظ قراءات الحساسات وحالات المشغلات بنجاح!");
        } catch (dbErr) {
            // في حال عدم وجود قاعدة بيانات حالياً، سنطبع تنبيهاً فقط دون تعطيل الخدمة
            console.warn("⚠️ [تنبيه قاعدة البيانات]: تعذر التخزين في MySQL (تأكدي من تشغيل السيرفر المحلي لاحقاً). تم تخطي خطوة الحفظ لتسهيل الاختبار الحقيقي للمشغلات.");
        }

        console.log("⚙️ [منطق التحكم]: تم تطبيق الشروط الحيوية وحساب مخرجات التحكم العكسي بنجاح.");

        // 3. إرجاع جيسن التحكم العكسي للـ ESP32 فوراً (سيعمل دائماً وأبداً)
        return res.status(200).json({
            status: "execute",
            relays: {
                IN1_southFan: southFan,       
                IN2_storageLights: "OFF",    
                IN3_cRoomLights: "OFF",      
                IN6_greenAreaLights: greenAreaLights, 
                IN7_waterPump: waterPump,     
                IN8_northFan: northFan        
            },
            servos: {
                mg90s_windows_pair: windowsServo, 
                mg996r_roof: roofServo            
            }
        });

    } catch (err) {
        console.error('❌ خطأ فادح في معالجة طلب الدفيئة:', err.message);
        res.status(500).json({ error: 'فشل السيرفر بالكامل في معالجة الحزمة المرسلة' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 السيرفر التبادلي المرن يعمل بكفاءة على المنفذ: ${PORT}`);
});