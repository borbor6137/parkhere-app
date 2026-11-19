// ตัวอย่างสำหรับพัฒนาในเครื่อง: คัดลอกเป็น config.js แล้วแก้ที่อยู่ parkhere-api (ไม่ใส่ค่าลับในไฟล์นี้)
// ตอน deploy ขั้นตอน build ของ Render เขียน config.js เองจาก env PH_API_BASE (docs/migration/deploy-plan-parkhere-api.md ข้อ 4)
// ไม่มี config.js ก็ได้: script.js ใช้ http://localhost:10000
window.PH_API_BASE = 'http://localhost:10000';
