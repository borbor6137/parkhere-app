'use strict';
/*
 * สร้าง tests/pricing/golden.json จากสูตรในซอร์สปัจจุบัน (ดู adapter-current.js)
 * รัน:  node tests/pricing/gen-golden.js
 * สร้างใหม่ได้ก็ต่อเมื่อซอร์สยังเป็นสูตรเดิม ถ้า 3 ไฟล์ให้ค่าไม่ตรงกัน สคริปต์จะ throw และไม่เขียนไฟล์
 * ห้ามสร้าง golden.json ใหม่เพื่อให้ผ่านหลัง P1 ถ้ายอดเปลี่ยน นั่นคือบั๊ก
 */
const fs = require('fs');
const path = require('path');
const A = require('./adapter-current');
const API = require('../../thingsboard/api/test/adapter-pricing');   // หลัง M5 admin/master ไม่มีสูตร: ใช้ pricing.js (api) เป็นตัวไขว้แทน

const CONFIGS = [
  { name: 'A: rate 20 / ฟรี 30 (ค่าเริ่มต้นของระบบ)', raw: { rate: 20, freemin: 30, bookfee: 20 } },
  { name: 'B: rate 15 / ฟรี 0', raw: { rate: 15, freemin: 0, bookfee: 20 } },
  { name: 'C: rate 37 / ฟรี 45', raw: { rate: 37, freemin: 45, bookfee: 20 } },
  { name: 'D: rate 0 -> ถูกตีความเป็น 20 (L10/D6)', raw: { rate: 0, freemin: 30, bookfee: 20 } },
  { name: 'E: ไม่มี config เลย -> ค่าเริ่มต้น', raw: {} },
  { name: 'F: มีแต่ rate 25 และ bookfee 0 (freemin ใช้ค่าเริ่มต้น 30)', raw: { rate: 25, bookfee: 0 } },
  { name: 'G: rate 100 / ฟรี 60 / ค่าจอง 35', raw: { rate: 100, freemin: 60, bookfee: 35 } },
  { name: 'H: ค่าเป็นสตริงตัวเลข', raw: { rate: '30', freemin: '15', bookfee: '10' } }
];
const MAXM = 600;
const EXTRA = [720, 1440, 2880, 10080];
const MS = [0, 1, 59999, 60000, 60001, 119999, 120000, 899999, 900000, 900001, 1799999, 1800000, 1800001, 1859999, 1860000, 1860001, 2699999, 2700000, 2700001, 3599999, 3600000, 3600001, 36000000];

const impls = Object.assign({}, A.impls, API.impls);   // user + api
const problems = [];
const note = s => problems.push(s);
let floatDiffs = 0, floatCells = 0;
const cases = [];

for (const cfg of CONFIGS) {
  const I = {};
  for (const k of Object.keys(impls)) I[k] = impls[k].load(cfg.raw);
  const eff = I.user.effective;
  // 3 ไฟล์ต้องอ่านค่า rate / freemin ได้เท่ากัน
  for (const k of ['api']) {
    if (I[k].effective.rate !== eff.rate || I[k].effective.freemin !== eff.freemin)
      note(cfg.name + ': ' + k + ' อ่าน config ได้ ' + JSON.stringify(I[k].effective) + ' แต่ user อ่านได้ ' + JSON.stringify(eff));
  }
  const price = [], fee = [], live = [];
  for (let m = 0; m <= MAXM; m++) {
    const p = I.user.price(m);
    for (const k of ['api']) if (I[k].price(m) !== p) note(cfg.name + ': price(' + m + ') ' + k + '=' + I[k].price(m) + ' user=' + p);
    price.push(p);
    const f = I.user.fee(m * 60000);
    for (const k of ['api']) if (I[k].fee(m * 60000) !== f) note(cfg.name + ': fee(' + m + ' นาที) ' + k + '=' + I[k].fee(m * 60000) + ' user=' + f);
    fee.push(f);
    live.push(I.user.live(m * 60000));
    floatCells++; if (p !== Math.ceil(m * eff.rate / 60)) floatDiffs++;
  }
  const feeExtra = {};
  for (const m of EXTRA) {
    const f = I.user.fee(m * 60000);
    for (const k of ['api']) if (I[k].fee(m * 60000) !== f) note(cfg.name + ': fee(' + m + ' นาที) ' + k + ' ไม่ตรง user');
    feeExtra[m] = f;
  }
  const feeByMs = {};
  for (const ms of MS) {
    const f = I.user.fee(ms);
    for (const k of ['api']) if (I[k].fee(ms) !== f) note(cfg.name + ': fee(' + ms + ' ms) ' + k + ' ไม่ตรง user');
    feeByMs[ms] = f;
  }
  // นาฬิกานับสดของ admin ต้องตรง fee; ของ user ต่างได้เฉพาะที่ 0 มิลลิวินาทีเมื่อ freemin=0 (ไม่ปัดขั้นต่ำ 1 นาที)
  for (let m = 0; m <= MAXM; m++) {
    for (const k of ['api']) if (I[k].live(m * 60000) !== fee[m]) note(cfg.name + ': live api ' + m + ' ไม่ตรง fee');
    if (live[m] !== fee[m] && !(m === 0 && eff.freemin === 0)) note(cfg.name + ': live user (' + live[m] + ') ต่างจาก fee (' + fee[m] + ') ที่ ' + m + ' นาที นอกกรณีที่ทราบ');
  }
  cases.push({
    name: cfg.name, raw: cfg.raw,
    effective: { rate: eff.rate, freemin: eff.freemin, bookfee: eff.bookfee },
    bookAmt: eff.bookfee,
    ext30: I.user.ext30(),
    price, fee, live, feeExtra, feeByMs
  });
}

if (problems.length) {
  console.error('ไม่เขียน golden.json เพราะสูตรในแต่ละไฟล์ให้ค่าไม่ตรงกัน:\n - ' + problems.slice(0, 40).join('\n - ') + (problems.length > 40 ? '\n ... รวม ' + problems.length + ' ข้อ' : ''));
  process.exit(1);
}

const golden = {
  meta: {
    about: 'ยอดเงินอ้างอิงจากสูตรปัจจุบัน (baseline P0-2) ใช้เทียบตอน P1 รวมเป็นฟังก์ชันเดียวและทุกรอบ QA',
    source: {
      'script.js': 'price (บรรทัด 234), parkMin (196), finish (197-199), ตัวอย่างก่อนยืนยันออก fee0 (345), นาฬิกานับสด (246, 274, 416), config (165)',
      'admin.html': 'RATE/FREE/price (309), mins (312), cost (313)',
      'master.html': 'RATE/FREE/price (221), mins (224), cost (225)'
    },
    formulas: {
      price: 'Math.ceil(m/60*RATE)',
      rate: '+cfg.rate||20   (rate 0 หรือไม่มี = 20)',
      freemin: 'cfg.freemin!=null ? +cfg.freemin : 30',
      bookfee: 'cfg.bookfee!=null ? +cfg.bookfee : 20   (ค่าจองช่อง = BOOKFEE ตรง ๆ ไม่มีสูตร; ฝั่ง admin ไม่มีค่าเริ่มต้น ใช้ b.amt ที่บันทึกไว้)',
      fee: 'price(max(0, max(1, ceil(ms/60000)) - freemin))   (ออกจริง / admin cost)',
      live: 'price(max(0, ceil(ms/60000) - freemin))   (นาฬิกานับสดบนหน้าผู้ใช้ ไม่มีขั้นต่ำ 1 นาที)',
      ext30: 'price(30)   (โค้ดต่อเวลาที่ยังไม่มีปุ่ม D1)'
    },
    fields: {
      price: 'price[m] = ค่าจอดของ m นาทีที่คิดเงิน, m = 0..' + MAXM,
      fee: 'fee[m] = ค่าจอดสุทธิเมื่อจอดมาพอดี m นาที (ออกจริง) ทั้ง user, admin, master ต้องเท่ากัน',
      live: 'live[m] = ตัวเลขนาฬิกานับสดของหน้าผู้ใช้ ที่ m นาทีพอดี',
      feeExtra: 'fee ที่นาทีมาก ๆ ' + EXTRA.join(', '),
      feeByMs: 'fee เมื่อจอดมา ms มิลลิวินาที ตรวจการปัดขึ้นเป็นนาที (ขอบ 59999/60000/60001 ฯลฯ)'
    },
    knownQuirks: [
      'live[0] ต่างจาก fee[0] เฉพาะเมื่อ freemin=0 (live=0, fee=price(1)) เพราะนาฬิกานับสดไม่มีขั้นต่ำ 1 นาที ถ้า P1 รวมสูตรแล้วตัวเลขนี้เปลี่ยน ต้องแจ้งเจ้าของ ไม่ใช่แก้ golden เงียบ ๆ',
      'rate=0 กลายเป็น 20 ทั้ง 3 ไฟล์ (D6 รอเจ้าของตัดสิน ถ้าเลือก "0 = ฟรี" ให้แก้ golden เคส D พร้อมบันทึกเหตุผล)',
      'ต้องคงรูปนิพจน์ Math.ceil(m/60*rate) ห้ามเปลี่ยนเป็น Math.ceil(m*rate/60) เพราะผลต่างกันที่ทศนิยม (ดูจำนวนเซลล์ที่ต่างใน floatDifferentCells)',
      'ค่า config ที่ผิดช่วง (ติดลบ ทศนิยม NaN) ไม่อยู่ใน golden เพราะเป็นงาน A5/D14'
    ],
    floatDifferentCells: floatDiffs + ' จาก ' + floatCells + ' เซลล์ (price[m] เทียบกับ Math.ceil(m*rate/60) เมื่อรวมทุกชุด config)',
    minutesRange: [0, MAXM],
    generatedBy: 'node tests/pricing/gen-golden.js',
    generatedOn: '2026-11-16'
  },
  cases
};

let txt = JSON.stringify(golden, null, 1);
txt = txt.replace(/\[\s+(-?\d[\d,\s-]*?)\s+\]/g, (m, g) => '[' + g.replace(/\s+/g, '') + ']');
fs.writeFileSync(path.join(__dirname, 'golden.json'), txt + '\n');
console.log('เขียน golden.json แล้ว: ' + cases.length + ' ชุด config × ' + (MAXM + 1) + ' นาที, ต่างจากสูตรจำนวนเต็ม ' + floatDiffs + '/' + floatCells + ' เซลล์');
