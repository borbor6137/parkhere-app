// M3: ชั้นข้อมูลการจอง (รูปร่าง ตรวจรูปแบบ ตัดเพดานขนาด ใบเสร็จที่คำนวณจาก books) + อ่าน/เขียน bk_* และ books
// ที่มาของโครงสร้าง: docs/migration/M3-data.md + M3-plan หัวข้อ 0 (ข้อ 29-32)
//   bk_{f}-{i}  asset ParkHere-Data  = [] หรือ 1 รายการ active  (ตัวตัดสินจริง ห้ามเชื่อ books แทน)
//   books       USER SERVER_SCOPE    = ประวัติของผู้ใช้ ใหม่สุดก่อน <= 60 รายการ และ <= 30,000 ไบต์ (สำเนา + ที่มาของใบเสร็จ)
// ไม่มีคีย์ rcp ใบเสร็จคำนวณจาก books ตอนตอบ (ข้อ 29)
const crypto = require('crypto');
const { isObj, sha } = require('./lib');
const { normalizeBookings } = require('./lot');

const MAX_BOOKS = 60, MAX_BOOKS_BYTES = 30000;
const STATUS = new Set(['active', 'done', 'noshow', 'cancelled', 'void']);
const THAI_DIGIT = { '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4', '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9' };

// เทียบทะเบียนด้วยรูปที่ปรับมาตรฐาน: NFKC, ตัดช่องว่าง/ขีด, ตัวพิมพ์เล็ก, เลขไทย -> อารบิก (M3 ข้อ 18)
const normPlate = s => String(s).normalize('NFKC').replace(/[๐-๙]/g, c => THAI_DIGIT[c]).replace(/[\s\-‐-―−]+/g, '').toLowerCase();

const slotKey = (f, i) => f + '-' + i;
const bkKey = (f, i) => 'bk_' + f + '-' + i;
// ชื่อช่องแบบที่เว็บแสดง: (ผัง 2 คอลัมน์ x 3 แถว) index 0->A1, 1->A2, 2->B1, 3->B2, 4->C1, 5->C2
const slotName = i => String.fromCharCode(65 + (i >> 1)) + ((i & 1) + 1);

const newBookingId = () => 'b' + crypto.randomBytes(12).toString('hex');
const newReceiptNo = () => 'PH' + String(crypto.randomInt(0, 1e8)).padStart(8, '0');
const rqOf = reqId => sha(String(reqId)).slice(0, 12);

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// อ่าน books ของผู้ใช้จาก attribute (ค่าอาจเป็นสตริง JSON หรืออาร์เรย์) ทิ้งรายการที่รูปแบบเสีย เก็บเฉพาะคีย์ที่รู้จัก
function normBooks(raw) {
  let a = raw;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return []; } }
  if (!Array.isArray(a)) return [];
  const out = [], seen = new Set();
  for (const b of a.slice(0, 200)) {
    if (!isObj(b) || typeof b.id !== 'string' || !/^[\w-]{1,64}$/.test(b.id) || seen.has(b.id)) continue;
    if (!int(b.f, 1, 99) || !int(b.i, 0, 999) || !Number.isFinite(b.s) || !Number.isFinite(b.e) || b.e <= b.s) continue;
    if (typeof b.car !== 'string' || !b.car || b.car.length > 20) continue;
    const status = STATUS.has(b.status) ? b.status : null; if (!status) continue;
    seen.add(b.id);
    const o = { id: b.id, f: b.f, i: b.i, car: b.car, s: b.s, e: b.e, status,
      amt: int(b.amt, 0, 100000) ? b.amt : 0, pm: typeof b.pm === 'string' && /^[\w-]{1,40}$/.test(b.pm) ? b.pm : 'pp' };
    if (typeof b.rno === 'string' && /^PH\d{8}$/.test(b.rno)) o.rno = b.rno;
    if (typeof b.rq === 'string' && /^[0-9a-f]{12}$/.test(b.rq)) o.rq = b.rq;
    if (typeof b.arr === 'number' && Number.isFinite(b.arr) && b.arr > 0) o.arr = b.arr;
    if (typeof b.out === 'number' && Number.isFinite(b.out) && b.out > 0) o.out = b.out;
    if (int(b.min, 0, 1e7)) o.min = b.min;
    if (int(b.park, 0, 1e7)) o.park = b.park;
    if (b.by === 'admin') o.by = 'admin';
    if (typeof b.bu === 'string' && b.bu.length <= 64) o.bu = b.bu;
    if (typeof b.reason === 'string') o.reason = b.reason.slice(0, 100);
    out.push(o);
  }
  return out;
}

const bytesOf = list => Buffer.byteLength(JSON.stringify(list), 'utf8');

// ตัดให้อยู่ในเพดาน: ลำดับตัด void ก่อน แล้วรายการจบเก่าสุด ห้ามตัด active (รายการใหม่สุดต้องอยู่)
function trimBooks(list) {
  const out = list.slice();
  const over = () => out.length > MAX_BOOKS || bytesOf(out) > MAX_BOOKS_BYTES;
  while (over()) {
    let idx = -1;
    for (let n = out.length - 1; n >= 0; n--) if (out[n].status === 'void') { idx = n; break; }   // void เก่าสุดก่อน
    if (idx < 0) for (let n = out.length - 1; n >= 0; n--) if (out[n].status !== 'active') { idx = n; break; }   // รายการจบเก่าสุด (ท้ายสุด)
    if (idx < 0) break;   // เหลือแต่ active ตัดไม่ได้
    out.splice(idx, 1);
  }
  return out;
}

// เติม/แทนรายการตาม id (ทำซ้ำได้) รายการใหม่ใส่หน้าสุด
function upsertBook(list, entry) {
  const i = list.findIndex(x => x.id === entry.id);
  if (i >= 0) { const c = list.slice(); c[i] = entry; return c; }
  return [entry, ...list];
}

// รายการที่ผู้ใช้เห็น: ซ่อน void และคีย์ภายใน (uid, rno, rq, bu) ใช้ allowlist ไม่ใช้ spread
function publicBooking(b) {
  const o = { id: b.id, f: b.f, i: b.i, car: b.car, s: b.s, e: b.e, status: b.status, amt: b.amt, pm: b.pm };
  for (const k of ['arr', 'out', 'min', 'park']) if (b[k] !== undefined) o[k] = b[k];
  if (b.by !== undefined) { o.by = b.by; o.reason = b.reason === undefined ? '' : b.reason; }
  return o;
}
const visibleBooks = books => books.filter(b => b.status !== 'void').map(publicBooking);

const receiptOf = (kind, b, no, t, amt, extra) => {
  const where = ` ช่อง ${slotName(b.i)} ชั้น ${b.f}`;
  const r = { no, bid: b.id, kind, t, f: b.f, i: b.i };
  if (extra && extra.min !== undefined) r.min = extra.min;
  r.desc = (kind === 'book' ? 'ค่าจอง' : kind === 'park' ? `ค่าจอด ${extra.min} นาที` : 'คืนค่าจอง') + where;
  r.amt = amt; r.pm = b.pm;
  return r;
};
// ใบเสร็จของรายการเดียว (กฎข้อ 29): ค่าจอง amt!=0 · ค่าจอด done และ park>0 · คืนเงิน cancelled และ amt!=0
function receiptsOf(b) {
  const out = [];
  if (!b.rno || b.status === 'void') return out;
  if (b.amt !== 0) out.push(receiptOf('book', b, b.rno, b.s, b.amt));
  if (b.status === 'done' && b.park > 0) out.push(receiptOf('park', b, b.rno + '-p', b.out || b.s, b.park, { min: b.min }));
  if (b.status === 'cancelled' && b.amt !== 0) out.push(receiptOf('refund', b, b.rno + '-r', b.out, -b.amt));
  return out;
}
// ใบเสร็จทั้งหมด (ใหม่สุดก่อน) จาก books ล่าสุด <= 60 รายการ
function receiptsFrom(books) {
  const out = [];
  for (const b of books.slice(0, MAX_BOOKS)) out.push(...receiptsOf(b));
  return out.sort((a, b) => b.t - a.t || (a.no < b.no ? 1 : -1));
}

// รายการใน bk_ ที่เขียนลง asset (ไม่มี out/min/park เพราะจบแล้วถูกถอน)
function bkEntry(b) {
  const o = { id: b.id, uid: b.uid, car: b.car, s: b.s, e: b.e, status: 'active', amt: b.amt, pm: b.pm, rno: b.rno, rq: b.rq };
  if (b.arr !== undefined) o.arr = b.arr;
  return o;
}

function createStore(cfg, tb) {
  return {
    // อ่านสดจาก ThingsBoard เสมอ (ห้ามใช้ cache ของ lot): คีย์เดียวหรือหลายคีย์
    async readBk(f, i) {
      const k = bkKey(f, i), a = await tb.readAssetAttrs([k]);
      return normalizeBookings(a[k], true);
    },
    async writeBk(f, i, list) { await tb.writeAssetAttrs({ [bkKey(f, i)]: list }); },
    async readBooks(uid) { const a = await tb.readAttrs(uid, ['books']); return normBooks(a.books); },
    async writeBooks(uid, list) { await tb.writeAttrs(uid, { books: trimBooks(list) }); },
  };
}

module.exports = { createStore, normPlate, normBooks, trimBooks, upsertBook, publicBooking, visibleBooks, receiptsOf, receiptsFrom, bkEntry, bkKey, slotKey, slotName, newBookingId, newReceiptNo, rqOf, MAX_BOOKS, MAX_BOOKS_BYTES };
