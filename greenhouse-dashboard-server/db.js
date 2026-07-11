const mysql = require("mysql2");

// غييري localhost إلى 127.0.0.1
const connection = mysql.createConnection({
  host: "127.0.0.1",
  user: "root",
  password: "",
  database: "greenhouse_db",
});
connection.connect((err) => {
  if (err) {
    console.error("خطأ في الاتصال: " + err.stack);
    return;
  }
  console.log("تم الاتصال بقاعدة البيانات بنجاح!");
});

module.exports = connection;
