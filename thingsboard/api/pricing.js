// ยอดเงินเดโมฟังก์ชันเดียวของฝั่งเซิร์ฟเวอร์ (M3 A9) ต้องตรง tests/pricing/golden.json ทุกเซลล์ (AC-14)
// ห้ามเปลี่ยนรูปนิพจน์ Math.ceil(m/60*rate) เป็น m*rate/60 (ผลต่างกันที่ทศนิยม) ห้ามแก้ golden เพื่อให้ผ่าน
// ความหมายของ config ตาม golden (เหมือนระบบเดิม):
//   rate    = +cfg.rate || 20       (0 หรือไม่มี = 20, ข้อ D6 รอเจ้าของ ถ้าเปลี่ยนต้องแก้ golden + script.js พร้อมกัน)
//   freemin = ไม่มี -> 30, bookfee = ไม่มี -> 20, สตริงตัวเลข ("30") ใช้ได้
// ค่าที่ไม่ใช่จำนวนเต็มไม่ติดลบ (NaN, ติดลบ, ทศนิยม, object) ใช้ค่าเริ่มต้น เพราะเงินเดโมเป็นบาทเต็ม

const D = { rate: 20, freemin: 30, bookfee: 20 };

const wholeNum = v => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
  const n = +v;
  return Number.isInteger(n) && n >= 0 ? n : null;
};

function effective(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const rate = wholeNum(c.rate), fm = wholeNum(c.freemin), bf = wholeNum(c.bookfee);
  return { rate: rate || D.rate, freemin: fm === null ? D.freemin : fm, bookfee: bf === null ? D.bookfee : bf };
}

// ค่าจอดของ "นาทีที่คิดเงิน" m
const price = (cfg, m) => Math.ceil(m / 60 * effective(cfg).rate);
// ค่าจอง (ครั้งเดียว ตอนจอง)
const bookFee = cfg => effective(cfg).bookfee;
// นาทีที่จอด: อย่างน้อย 1 นาที ปัดขึ้น
const parkMinutes = (s, out) => Math.max(1, Math.ceil((out - s) / 60000));
// ค่าจอดสุทธิตอนออก: หักนาทีฟรี
const parkFee = (cfg, s, out) => price(cfg, Math.max(0, parkMinutes(s, out) - effective(cfg).freemin));

module.exports = { effective, price, bookFee, parkMinutes, parkFee };
