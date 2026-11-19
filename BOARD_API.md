# ParkHere – ข้อมูลที่บอร์ด/กล้องต้องส่งเข้า Firebase


> **v3 (ThingsBoard)**: ผังลานจอดปัจจุบัน: **3 ชั้น x 6 ช่อง** คีย์ `{f}-{i}` (f=1..3, i=0..5) จัดเป็น 2 คอลัมน์ x 3 แถว: i0=A1, i1=A2, i2=B1, i3=B2, i4=C1, i5=C2 (ค่าเริ่มต้นของ config `floors:3, slots:6`; ตั้งใหม่ได้ผ่าน config เท่านั้น)  
> **บอร์ดจริง (ParkHere-Lot) คุมช่องเดียวคือ `1-1` (A2 ชั้น 1) ทั้งกล้องและไม้กั้น ช่องอื่นทุกช่องทุกชั้นเป็น ParkHere-Sim (Wokwi)** แมปเป็น config ของ API: env `SLOT_DEVICE_MAP` (ค่าเริ่ม `1-1=lot`) + `SLOT_DEVICE_DEFAULT` (ค่าเริ่ม `sim` เมื่อมี `TB_SIM_DEVICE_ID`) API อ่าน `slot_`/`bar_` ของแต่ละช่องจากอุปกรณ์เจ้าของเท่านั้น **ค่าของช่องอื่นที่อุปกรณ์ไม่ใช่เจ้าของส่งมา (เช่น Lot ส่ง `slot_1-2`, `slot_1-5`, `slot_1-6`) ถูกตัดทิ้ง** และ RPC `setBarrier` ของ `1-1` ไป Lot ช่องอื่นไป Sim  
บอร์ดเขียนข้อมูลลง Realtime Database ตัวเดียวกับเว็บ เว็บจะอัปเดตทันที (ไม่ต้องรีเฟรช)

## โครงสร้างข้อมูล
```
/sensors/{ชั้น}-{ช่อง}   เช่น /sensors/1-0 (ชั้น 1 ช่อง A1), /sensors/1-1 (A2), /sensors/1-2 (B1)
      = { "occ": true/false, "t": <timestamp> }      occ=true หมายถึงมีรถจอดอยู่
/status/lastSeen         = <timestamp>               ส่งทุก ~20 วินาที เพื่อบอกว่าบอร์ดยังออนไลน์ (เกิน 90 วิ เว็บขึ้น "ไม่ได้รับสัญญาณ")
/config                  = { "floors": 1, "slots": 4, "rate": 20, "penalty": 20 }   (ตั้งในหน้า Firebase Console ได้เลย)
/barrier/{ชั้น}-{ช่อง}/cmd    = { "u": <uid>, "b": <id การจอง>, "car": "กข 1234 · ...", "t": <timestamp> }   แอปเขียน (ผู้ใช้กด "ลดไม้กั้น")
/barrier/{ชั้น}-{ช่อง}/state  = { "down": true/false, "b": <id การจอง>, "car": "...", "t": <timestamp> }       บอร์ดเขียน
```
ลำดับช่อง (ผัง 2 คอลัมน์ x 3 แถว): index 0→A1, 1→A2, 2→B1, 3→B2, 4→C1, 5→C2 (แถวละ 2 ช่อง)
ใช้ `{".sv":"timestamp"}` เป็นค่าเวลา เพื่อให้เซิร์ฟเวอร์ใส่เวลาให้ (บอร์ดไม่ต้องมีนาฬิกา)

## ขั้นตอนตั้งค่า
1. Firebase → Authentication → Users → **Add user**: อีเมล `board@parkhere.com` + รหัสผ่าน (เป็นบัญชีของบอร์ดโดยเฉพาะ)
2. Realtime Database → Rules แทนที่ด้วย
```json
{
  "rules": {
    "users": { "$uid": { ".read": "auth.uid === $uid", ".write": "auth.uid === $uid" } },
    "taken": { ".read": "auth != null", "$slot": { ".write": "auth != null" } },
    "sensors": { ".read": "auth != null", ".write": "auth.token.email === 'board@parkhere.com'" },
    "status":  { ".read": "auth != null", ".write": "auth.token.email === 'board@parkhere.com'" },
    "config":  { ".read": "auth != null", ".write": "auth.token.email === 'board@parkhere.com'" },
    "barrier": {
      ".read": "auth != null",
      "$slot": {
        "cmd": {
          ".write": "auth != null",
          ".validate": "newData.child('u').val() === auth.uid && newData.child('b').isString() && root.child('taken').child($slot).child(newData.child('b').val()).exists() && newData.child('t').val() === now"
        },
        "state": { ".write": "auth != null && (auth.token.email === 'board@parkhere.com' || auth.token.email === 'cpe@parkhere.com' || auth.token.email === 'master@parkhere.com' || root.child('admins').child(auth.uid).exists())" }
      }
    }
  }
}
```
> ถ้าใน Console มีกฎอื่นอยู่แล้ว (เช่น `cancels`, `closed`) ให้เพิ่มเฉพาะบล็อก `"barrier"` เข้าไป ไม่ต้องลบของเดิม
> `barrier/{ช่อง}/state` ให้บอร์ดและแอดมินเขียนได้ (แอดมินกด "🚧 โหมดสั่งไม้กั้น" ในหน้า Admin → ช่องจอด เพื่อยก/ลดไม้กั้นเองเวลาผู้ใช้ติดปัญหา บอร์ดต้องฟัง `state` ด้วย ถ้า `b` = `"admin"` ให้ทำตาม `down` ทันที)
> กฎ `barrier/{ช่อง}/cmd` ยอมให้เขียนเฉพาะผู้ใช้ที่จองช่องนั้นอยู่จริง (`/taken/{ช่อง}/{id การจอง}`) คนอื่นจึงสั่งลดไม้กั้นช่องที่ตัวเองไม่ได้จองไม่ได้
3. ตั้ง `/config` ให้ตรงกับโมเดลลานจอด (กี่ชั้น กี่ช่อง) ใน Console → Data → + เพิ่ม

## ส่งข้อมูลจากบอร์ด (REST – ใช้ได้กับ ESP32/ESP8266/Python/Raspberry Pi)
```
# 1) ล็อกอินครั้งเดียวได้ idToken (หมดอายุ 1 ชม. ให้ล็อกอินใหม่เป็นระยะ)
POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<apiKey>
body: {"email":"board@parkhere.com","password":"...","returnSecureToken":true}

# 2) อัปเดตช่อง 1-0 ว่ามีรถ
PUT https://parkhere-7c639-default-rtdb.asia-southeast1.firebasedatabase.app/sensors/1-0.json?auth=<idToken>
body: {"occ":true,"t":{".sv":"timestamp"}}

# 3) heartbeat
PUT .../status/lastSeen.json?auth=<idToken>   body: {".sv":"timestamp"}
```
## ไม้กั้นที่ช่องจอด (ลดจากแอป)
แต่ละช่องมีไม้กั้นยกขวางไว้ หลังจองสำเร็จ ผู้ใช้ไปถึงช่องแล้วกดปุ่ม **🚧 ลดไม้กั้น** ในแอป (หน้าชำระเงินสำเร็จ / หน้าหลัก / การจอง / บัตร QR)
ปุ่มจะแสดงจนกว่าเซนเซอร์จะเห็นรถเข้าช่อง
```
# 1) ฟังคำสั่งทุกช่องแบบ realtime (Server-Sent Events) – ESP32 ใช้ HTTPClient อ่านทีละบรรทัด
GET .../barrier.json?auth=<idToken>      header: Accept: text/event-stream
    -> event: put  data: {"path":"/1-2/cmd","data":{"u":"...","b":"b1730...","car":"...","t":1730...}}
    path บอกว่าเป็นช่องไหน (1-2 = ชั้น 1 ช่อง B1)
    (ถ้าทำ stream ไม่ได้ ให้ GET .../barrier/1-2/cmd.json ของแต่ละช่องทุก 1 วินาที แล้วดูว่า t เปลี่ยนไหม)

# 2) ได้คำสั่งใหม่ (t มากกว่าครั้งก่อน และไม่เก่ากว่า ~15 วินาที) -> สั่งเซอร์โวลดไม้กั้นช่องนั้น แล้วตอบกลับ
PUT .../barrier/1-2/state.json?auth=<idToken>
body: {"down":true,"b":"<b จากคำสั่ง>","car":"...","t":{".sv":"timestamp"}}

# 3) ยกไม้กั้นกลับเมื่อรถออกจากช่อง (เซนเซอร์ occ เปลี่ยน true -> false)
#    หรือรถไม่เข้าช่องภายใน ~60 วินาที
PATCH .../barrier/1-2/state.json?auth=<idToken>   body: {"down":false,"t":{".sv":"timestamp"}}
```
แอปรอคำตอบ `down:true` ที่มี `b` ตรงกับการจองนั้น 10 วินาที ถ้าไม่ได้รับจะขึ้น "ไม้กั้นไม่ตอบสนอง"
ทดสอบได้ด้วย `board-simulator.html` (ทุกช่องมีแถบไม้กั้นจำลอง ลดเองเมื่อได้คำสั่ง และยกกลับเมื่อแตะช่องจาก "มีรถ" เป็น "ว่าง")

กล้อง: ให้โปรแกรมตรวจจับ (เช่น OpenCV/YOLO บนคอม) ส่ง occ ต่อช่องด้วยวิธีเดียวกัน ส่งเฉพาะตอนสถานะเปลี่ยน

## เว็บทำอะไรกับข้อมูลนี้
- ช่องที่ `occ=true` = สีแดง "มีรถจอด" (กดจองไม่ได้)
- ช่องที่มีการจองคาบเกี่ยวเวลาปัจจุบัน แต่ยังไม่มีรถ = สีส้ม "จองแล้ว"
- ผู้ใช้ที่จอดเกินเวลา แล้วกล้องเห็นช่องว่าง → ระบบจบการจอดและคิดค่าปรับให้อัตโนมัติ
