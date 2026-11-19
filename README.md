# ParkHere 🅿️ ระบบจองที่จอดรถอัจฉริยะ

เว็บแอปจองที่จอดรถ ทำงานร่วมกับ **ThingsBoard Cloud** (IoT platform) และ **ESP32** (จำลองบน Wokwi)
ผู้ใช้เห็นสถานะช่องจอดแบบเรียลไทม์ จองช่อง ชำระเงิน (ระบบจำลอง) และสั่งลดไม้กั้นจากเว็บได้

## สถาปัตยกรรม

```
ESP32 (Wokwi) ──MQTT──► ThingsBoard Cloud ◄──REST/RPC── parkhere-api (Node.js) ◄──HTTPS/SSE── เว็บแอป
  ปุ่ม/ไฟ/ไม้กั้น        telemetry + RPC              ตรวจสิทธิ์ จอง คิดค่าจอด         ผังลานจอด จอง จ่าย
```

- **ESP32** ส่ง `slot_{ชั้น}-{ช่อง}` (มีรถ/ว่าง), `bar_{ชั้น}-{ช่อง}` (ไม้กั้น), `hb` (heartbeat) และรับ RPC `setBarrier`
- **ThingsBoard** เก็บ telemetry, บัญชีผู้ใช้ (Customer/Role) และข้อมูลการจอง (attributes)
- **parkhere-api** เป็นตัวกลาง: ล็อกอินผ่าน ThingsBoard, ตรวจการจองซ้ำ, คิดค่าจอด, ส่งคำสั่งไม้กั้น, ส่งสถานะสดด้วย SSE
- **เว็บแอป** HTML/CSS/JS ล้วน (PWA) หน้าผู้ใช้ `index.html`, หน้าผู้ดูแล `admin.html`, `master.html`

## ฟีเจอร์หลัก

- ผังลานจอด 3 ชั้น × 6 ช่อง (A1–C2) อัปเดตสด: 🟢 ว่าง 🟡 จองแล้ว 🔴 มีรถ
- สมัคร / ล็อกอิน / จัดการทะเบียนรถ
- จองช่อง + ชำระเงินจำลอง + บัตรเข้าลานจอด (QR)
- จองแล้วไม้กั้นยก → ผู้จองกด **ลดไม้กั้น** จากเว็บ → เข้าจอด → **ออกจากลานจอด** คิดค่าจอดตามเวลาจริง
- หน้าผู้ดูแล: ดูการจอง, ยกเลิก, สั่งไม้กั้น, ปิดช่อง, ตั้งค่าราคา/จำนวนช่อง

## โครงสร้างไฟล์

| ไฟล์/โฟลเดอร์ | หน้าที่ |
|---|---|
| `index.html` `script.js` `style.css` | หน้าเว็บผู้ใช้ |
| `admin.html` `master.html` `admin-core.js` | หน้าผู้ดูแลระบบ |
| `thingsboard/api/` | parkhere-api (Node.js ไม่มี dependency ภายนอก) |
| `thingsboard/api/test/` | ชุดทดสอบ (`npm test`) |
| `thingsboard/.env.example` | ตัวอย่างค่าตั้ง (ห้าม commit `.env` จริง) |
| `BOARD_API.md` | สัญญาข้อมูลระหว่างบอร์ดกับระบบ |

Firmware / ตัวจำลอง Wokwi อยู่ใน repo แยก (parkhere-firmware)

## รันในเครื่อง

```bash
cd thingsboard
cp .env.example .env      # ใส่ TB_API_KEY, device id ฯลฯ
npm run api               # http://localhost:10000
```
แล้วเปิดเว็บผ่าน web server ใดก็ได้ (เช่น XAMPP: `http://localhost/<โฟลเดอร์>/`)

## Deploy (Render)

- **parkhere-api**: Web Service, root `thingsboard`, start `node api/server.js`, ตั้ง env ตาม `.env.example`
- **เว็บ**: Static Site, build เขียน `config.js` จาก env `PH_API_BASE` (ที่อยู่ api)

## ความปลอดภัย

ไม่มีรหัสผ่าน/โทเคนใน repo, ระบบจ่ายเงินเป็นการจำลอง (ไม่เก็บเลขบัตร), API ตรวจสิทธิ์ทุกคำขอ + จำกัดอัตราการเรียก
