# tests/baseline: สคริปต์ยุค Firebase (เก็บเป็นหลักฐาน ไม่ใช่เทสต์ที่รันได้)

สถานะ: **ล้าสมัย (obsolete) ตั้งแต่ M7-1 (2026-11-19)** รันไม่ได้และไม่ควรรัน

เหตุผล
- `capture.js.txt` และ `smoke-mock.js.txt` เขียนตอน P0-2 (2026-11-16) เพื่อเก็บภาพ/ผล smoke ก่อน redesign ของหน้าผู้ใช้เดิม
  ซึ่งใช้ Firebase SDK (`db.ref`, `firebase.auth()`) ฟังก์ชันและ id ในหน้า (`show()`, `setApp`, `s-user`, `l-email` ...) ของ `script.js` ยุคนั้น
- หน้าเว็บตอนนี้ไม่มี Firebase แล้ว (ใช้ parkhere-api + ThingsBoard) การ mock `db.ref` จึงไม่มีผล สคริปต์จะพังหรือผ่านแบบไม่ได้ตรวจอะไร
- ผลที่สคริปต์เหล่านี้สร้างไว้ยังอ้างอิงอยู่ใน `docs/qa/2026-11-16-baseline/` (README, smoke-list.md, ภาพ) จึงไม่ลบ แค่เปลี่ยนนามสกุลเป็น `.txt`
  เพื่อไม่ให้ถูกรันหรือถูก grep `db.ref` ในโค้ดที่รันจริงเจอ (เกณฑ์ข้อ 4 ของ M7-1) ประวัติเต็มดูได้ใน git

ถ้าต้องการ baseline/smoke ของหน้าผู้ใช้ยุค ThingsBoard ให้เขียนใหม่ให้ใช้ mock API แบบ `tests/admin-ui/serve-mock.js` (mock ThingsBoard + parkhere-api ในโปรเซส ไม่ยิงของจริง) แทนการ mock `db.ref`
