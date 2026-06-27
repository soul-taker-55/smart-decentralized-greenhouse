const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(cors());

// دالة مساعدة لقراءة البيانات من ملف JSON بأمان
const readDataFromFile = () => {
    if (!fs.existsSync(DATA_FILE)) {
        return null;
    }
    const rawData = fs.readFileSync(DATA_FILE, 'utf8');
    return rawData ? JSON.parse(rawData) : null;
};

app.get('/', (req, res) => {
    res.send('سيرفر مشروع التخرج (نسخة JSON المستقرة) يعمل بنجاح! 🚀');
});

// استقبال البيانات من الـ ESP32 وحفظها داخل ملف JSON
app.post('/api/sensors', (req, res) => {
    try {
        const newData = req.body;
        // إضافة التوقيت الحالي تلقائياً إذا لم يرسله الحساس
        if (!newData.timestamp) {
            newData.timestamp = new Date().toISOString();
        }
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(newData, null, 2), 'utf8');
        console.log('📬 تم استقبال قراءة جديدة وحفظها في ملف JSON بنجاح!');
        res.status(200).json({ message: 'تم استقبال قراءة الـ ESP32 وتحديث ملف JSON!' });
    } catch (err) {
        console.error('خطأ أثناء كتابة الملف:', err);
        res.status(500).json({ error: 'فشل حفظ البيانات محلياً' });
    }
});

// جلب أحدث قراءة لتغذية لوحة التحكم (Dashboard) حياً
app.get('/api/sensors/latest', (req, res) => {
    try {
        const latestData = readDataFromFile();
        if (!latestData) {
            return res.status(404).json({ error: 'لا توجد بيانات مسجلة بعد، قم بتشغيل ملف المحاكاة أولاً.' });
        }
        res.json(latestData);
    } catch (err) {
        res.status(500).json({ error: 'خطأ أثناء قراءة البيانات من الملف' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 السيرفر المستقر يعمل حالياً على: http://localhost:${PORT}`);
});