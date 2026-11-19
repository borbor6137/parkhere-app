'use strict';
/*
 * Adapter ที่ "ดึงสูตรยอดเงินจริง" ออกมาจากซอร์สปัจจุบัน แล้วรันใน vm (ไม่ต้องมี DOM / Firebase)
 *   - user   : script.js   (price, parkMin, finish, ค่านาฬิกานับสด, ตัวอย่างก่อนยืนยันออก, การอ่าน config)
 *   - admin  : admin.html  (RATE/FREE/price, mins, cost)
 *   - master : master.html (เหมือน admin)
 * หลัง M3 (F3) เว็บไม่คิดยอดจริงเอง: finish() และต่อเวลา ถูกลบ ยอดจริงตอนออกคิดที่เซิร์ฟเวอร์ (pricing.js พิสูจน์ด้วย pricing-golden.json)
 * adapter นี้จึงตรวจเฉพาะสูตรที่ยังอยู่ในเว็บ: price, parkMin, ยอด "ประมาณ" ก่อนยืนยันออก (fee0), นาฬิกานับสด (3 จุด), ค่า config
 * ถ้าโค้ดถูกแก้ (เช่นหลัง P1 รวมเป็น pricing.js) regex จะหาไม่เจอแล้ว throw ข้อความชัดเจน
 * ให้ไปเขียน adapter ใหม่ที่เรียก pricing.js แทน (ดู README.md)
 *
 * รูปแบบ adapter: load(raw) -> { effective:{rate,freemin,bookfee|null}, price(m), fee(ms), live(ms) }
 *   raw  = ค่า config ดิบแบบที่ Firebase ส่งมา (ฟิลด์ไหนไม่มีก็ไม่ใส่)
 *   price(m)  = ค่าจอดของ "นาทีที่คิดเงิน" m
 *   fee(ms)   = ค่าจอดสุทธิเมื่อออกจริงหลังจอดมา ms มิลลิวินาที (นาที = max(1, ceil(ms/60000)) ลบนาทีฟรี)
 *   live(ms)  = ตัวเลขที่นาฬิกานับสดบนหน้าจอแสดง ณ ms (หน้าผู้ใช้เท่านั้น; admin ใช้ค่าเดียวกับ fee)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const S0 = 1700000000000; // เวลาเริ่มจอดสมมติ (ค่าคงที่ ไม่เกี่ยวกับเวลาจริง)

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
function grab(src, re, label) {
  const m = src.match(re);
  if (!m) throw new Error('หาสูตร "' + label + '" ในซอร์สไม่เจอ (โค้ดถูกแก้หรือย้ายไปไฟล์อื่น ต้องปรับ adapter) pattern=' + re);
  return m;
}
function mkCtx(extra) {
  const ctx = vm.createContext(Object.assign({ __NOW: 0 }, extra || {}));
  vm.runInContext('globalThis.Date = class extends Date { static now(){ return globalThis.__NOW } }', ctx);
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);

function loadUser(raw) {
  const src = read('script.js');
  const defaults = grab(src, /let N=6,RATE=20,BOOKFEE=20,FREEMIN=30,FL=3,NOSHOW_MIN=30;/, 'ค่าเริ่มต้น config')[0];
  // หลัง M2 config มาจาก GET /api/lot ผ่าน applyCfg (ค่าที่ขาดคงค่าเริ่มต้นเดิม ความหมายเท่าเดิม)
  const cfgAssign = grab(src, /const applyCfg=c=>\{(N=[^\n]*?NOSHOW_MIN=\+c\.noshow\|\|NOSHOW_MIN;)\};/, 'การอ่าน config (applyCfg)')[1];
  const price = grab(src, /const price=m=>[^;]+;/, 'price')[0];
  const sName = grab(src, /const sName=[^\n]*;/, 'sName')[0];
  const bsbe = grab(src, /const bs=b=>[^\n]*;/, 'bs/be')[0];
  const parkMin = grab(src, /const parkMin=b=>[^\n]*;/, 'parkMin')[0];
  // เวลาของเซิร์ฟเวอร์: parkMin/นาฬิกานับสดใช้ nowS() (ส่วนต่างมาจาก serverNow ของ API) ในเทสต์ srvOff=0 และ Date.now() ถูกแทนด้วย __NOW
  const srv = grab(src, /let srvOff=0;/, 'srvOff')[0] + grab(src, /const nowS=[^\n]*;/, 'nowS')[0];
  const fee0 = grab(src, /fee0=(price\(Math\.max\(0,m-FREEMIN\)\))/, 'fee0 (ตัวอย่างก่อนยืนยันออก)')[1];
  // นาฬิกานับสด: มีหลายจุดในโค้ด ต้องได้ค่าเท่ากันทุกจุด
  const liveExprs = src.match(/price\(Math\.max\(0,Math\.ceil\(\((?:[^()]|\(\))*\)\/6e4\)-FREEMIN\)\)/g) || [];
  if (liveExprs.length < 3) throw new Error('นิพจน์นาฬิกานับสดใน script.js เหลือ ' + liveExprs.length + ' จุด (คาดว่า 3: liveInfo, การ์ดการจอง, setInterval)');
  // ค่าจองช่อง: ต้องเป็นค่า BOOKFEE ตรง ๆ
  grab(src, /S\.d=\{f:S\.f,i:S\.s,car,amt:BOOKFEE\}/, 'ยอดค่าจอง = BOOKFEE');

  const ctx = mkCtx();
  run(ctx, srv + defaults + price + sName + bsbe + parkMin);
  run(ctx, '(c=>{' + cfgAssign + '})(' + JSON.stringify(raw) + ')');
  const nowAt = ms => { ctx.__NOW = S0 + ms; };
  return {
    effective: run(ctx, '({rate:RATE,freemin:FREEMIN,bookfee:BOOKFEE})'),
    price: m => run(ctx, 'price(' + m + ')'),
    ext30: () => run(ctx, 'price(30)'),   // ไม่มีปุ่มต่อเวลาแล้ว คง price(30) ไว้ให้ตารางเดิมตรวจครบ
    fee(ms) { // ยอด "ประมาณ" ก่อนยืนยันออก: สูตรเดียวกับ finish เดิม (min=max(1,ceil(ms/60000)), price(max(0,min-FREEMIN)))
      nowAt(ms);
      return run(ctx, '(()=>{const b={s:' + S0 + '};const m=parkMin(b);return ' + fee0 + '})()');
    },
    live(ms) {
      nowAt(ms);
      const vals = liveExprs.map(e => run(ctx, '(()=>{const n=__NOW,s0=' + S0 + ',s=' + S0 + ',el={dataset:{s:' + S0 + '}};return ' + e + '})()'));
      if (new Set(vals).size !== 1) throw new Error('script.js: นาฬิกานับสดแต่ละจุดให้ค่าไม่เท่ากัน ' + JSON.stringify(vals) + ' ที่ ms=' + ms);
      return vals[0];
    }
  };
}

// หลัง M5: admin.html / master.html / admin-core.js ไม่คิดยอดเงินเองแล้ว (แสดงเฉพาะ amt/park ที่ parkhere-api ส่งมา จาก pricing.js)
// golden จึงเทียบสูตรใน 3 ไฟล์นี้ไม่ได้อีก; แทนที่ด้วยการเฝ้าไม่ให้สูตรราคากลับเข้ามาฝั่ง admin และตรวจว่ายังแสดงค่าจากเซิร์ฟเวอร์
// ยอดจริงของ admin พิสูจน์ที่ pricing.js ด้วยตารางเดียวกัน: node tests/pricing/check-golden.js thingsboard/api/test/adapter-pricing.js
const ADMIN_FILES = ['admin.html', 'master.html', 'admin-core.js'];
const FORBIDDEN = [
  [/\bconst\s+(RATE|FREE|price|mins|cost)\s*=/, 'ประกาศสูตร RATE/FREE/price/mins/cost'],
  [/Math\.ceil\([^\n]*\/\s*60\s*\*/, 'นิพจน์ค่าจอด Math.ceil(m/60*rate)'],
  [/\b(?:cfg|config)\.(?:rate|freemin)\b/, 'อ่าน rate/freemin ไปคำนวณเอง']
];
function guards() {
  const out = [];
  let cells = 0;
  for (const f of ADMIN_FILES) {
    const src = read(f);
    for (const [re, why] of FORBIDDEN) { cells++; if (re.test(src)) out.push(f + ': พบ ' + why + ' (ยอดเงินต้องคิดที่ pricing.js ที่เดียว)'); }
  }
  const core = read('admin-core.js');
  // ต้องแสดงยอดที่เซิร์ฟเวอร์ส่งมา (b.amt ค่าจอง, b.park ค่าจอดตอนออก) ทั้งหน้าจอและ CSV
  for (const [re, label] of [[/fmt\(b\.amt\)/, 'หน้าจอ: ค่าจอง b.amt'], [/fmt\(b\.park\)/, 'หน้าจอ: ค่าจอดตอนออก b.park'],
    [/num\(b\.amt\)/, 'CSV: b.amt'], [/num\(b\.park\)/, 'CSV: b.park']]) {
    cells++; if (!re.test(core)) out.push('admin-core.js: ไม่พบการแสดง ' + label + ' จากเซิร์ฟเวอร์');
  }
  return { cells, problems: out };
}

module.exports = {
  name: 'ซอร์สปัจจุบัน (script.js ฝั่งผู้ใช้ + ตัวเฝ้า admin.html / master.html / admin-core.js)',
  S0,
  guards,
  impls: {
    user: { load: loadUser, file: 'script.js' }
  }
};
