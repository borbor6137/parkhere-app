# ParkHere × ThingsBoard × Edge Impulse × Render

```
บอร์ดจริง (ESP32-CAM + โมเดล Edge Impulse + เซอร์โวไม้กั้น)
      │  MQTT  (telemetry slot_* / bar_* / hb  ·  RPC setBarrier)
      ▼
ThingsBoard Cloud  ── device "ParkHere-Lot"
      ▲  REST (poll ค่าล่าสุด / ส่ง RPC)
      │
parkhere-bridge  (Render Web Service – thingsboard/bridge.js)
      │  Firebase SDK (ล็อกอินบัญชี board@parkhere.com)
      ▼
Firebase Realtime Database  ←→  เว็บแอป ParkHere (Render Static Site)
```

แอป ผู้ใช้ Admin และ Master ไม่ต้องแก้: bridge เขียนข้อมูลลง Firebase ที่ path เดิม (`/sensors`, `/status/lastSeen`, `/barrier/{ช่อง}/state`)
และอ่านคำสั่ง `/barrier/{ช่อง}/cmd` ไปสั่งบอร์ดผ่าน ThingsBoard ให้

## ข้อมูลระหว่างบอร์ดกับ ThingsBoard
| ทิศทาง | รูปแบบ | ความหมาย |
|---|---|---|
| บอร์ด → TB telemetry | `{"slot_1-2": true}` | ช่อง ชั้น1 ช่อง index 2 (B1) มีรถ (`false` = ว่าง) |
| บอร์ด → TB telemetry | `{"bar_1-2": 1}` | ไม้กั้นช่องนั้นลดแล้ว (`0` = ยกขวาง) – ส่งหลังทำตามคำสั่ง |
| บอร์ด → TB telemetry | `{"hb": 1}` ทุก 20 วิ | บอกว่ายังออนไลน์ (เกิน 90 วิ แอปขึ้น "ไม่ได้รับสัญญาณ") |
| TB → บอร์ด RPC | `{"method":"setBarrier","params":{"slot":"1-2","down":true}}` | สั่งลด/ยกไม้กั้น (topic `v1/devices/me/rpc/request/+`) |

ลำดับช่อง (ผัง 2 คอลัมน์ x 3 แถว): index 0→A1, 1→A2, 2→B1, 3→B2, 4→C1, 5→C2 · ลานจอดเริ่มต้น 3 ชั้น x 6 ช่อง · บอร์ดจริงคุมแค่ช่อง `1-1` (A2) ช่องอื่นเป็น ParkHere-Sim (ดู `SLOT_DEVICE_MAP` ใน `docs/migration/M2-api.md`)

bridge จัดการให้เอง: ลดไม้กั้นแล้วรถไม่เข้าใน 60 วิ → ยกกลับ · รถออกจากช่อง (slot เปลี่ยน true→false) → ยกกลับ

## ค่าที่ต้องตั้งใน Render (parkhere-bridge → Environment)
| key | ค่า |
|---|---|
| `TB_API_KEY` | ThingsBoard → มุมซ้ายล่างคลิกชื่อตัวเอง → แท็บ **Security** → API keys → **Manage** → สร้าง key แล้ว copy (แสดงครั้งเดียว) |
| `TB_SENSOR_DEVICE_ID` | ตั้งไว้ใน render.yaml แล้ว = device **ParkHere-Lot** (`b4256bd0-d96d-11f1-86c1-cdf15b9d0c51`) |
| `TB_BARRIER_DEVICE_ID` | ถ้าไม้กั้นใช้บอร์ดแยก ใส่ Device ID ของบอร์ดนั้น (ไม่ใส่ = ใช้ตัวเดียวกับข้างบน) |
| `FB_PASSWORD` | รหัสผ่านบัญชี `board@parkhere.com` ใน Firebase |

เปิด URL ของ parkhere-bridge จะเห็นสถานะ (`tbOk`, `fbOk`, `lastTelemetry`, ช่องที่มีรถ, ไม้กั้น)

## พอบอร์ดจริงมาถึง
1. Edge Impulse (โปรเจกต์ tanathip-project-1): ถ่ายรูปโมเดลลานจอดจากมุมกล้องจริง ตีกรอบ label `car` → Create impulse (Image 96x96, Object Detection/FOMO) → Train → Deployment: **Arduino library**
2. Arduino IDE: เปิด `esp32cam_parkhere/esp32cam_parkhere.ino` ใส่ WiFi, `TB_TOKEN` (Access token ของ device), แก้ `SLOTS` ให้ตรงตำแหน่งช่องในภาพและขาเซอร์โว → Upload
3. ดูใน ThingsBoard → Devices → ParkHere-Lot → Latest telemetry ต้องเห็น `slot_*` และ `hb` ขึ้น
4. แอปจะขึ้น 🟢 เซนเซอร์/กล้องออนไลน์ และปุ่ม 🚧 ลดไม้กั้น จะสั่งเซอร์โวจริง

> อย่าเปิด `board-simulator.html` พร้อมบอร์ดจริง เพราะจะเขียนค่าช่องจอดทับกัน (ตัวจำลองนั้นเขียน Firebase ตรง ไม่ผ่าน ThingsBoard)

## รันในคอม (ทดสอบแทน Render)
```
cd thingsboard
npm install
set TB_API_KEY=... & set TB_SENSOR_DEVICE_ID=b4256bd0-d96d-11f1-86c1-cdf15b9d0c51 & set FB_PASSWORD=...
node bridge.js
```
