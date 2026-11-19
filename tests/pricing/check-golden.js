'use strict';
/*
 * ตรวจว่าสูตรปัจจุบัน (หรือ pricing.js หลัง P1) ให้ยอดตรงกับ golden.json ทุกเซลล์
 * รัน:  node tests/pricing/check-golden.js                      (ตรวจสูตรฝั่งผู้ใช้ + ตัวเฝ้า admin ว่าไม่คิดยอดเอง)
 *       node tests/pricing/check-golden.js ./adapter-pricing.js   (ตรวจ adapter ของ pricing.js)
 * adapter ต้อง export { name, impls: { <ชื่อ>: { load(raw) } } } รูปแบบเดียวกับ adapter-current.js
 * ออกด้วยรหัส 1 ถ้ามีเซลล์ไม่ตรง
 */
const path = require('path');
const golden = require('./golden.json');
const adapterPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : path.join(__dirname, 'adapter-current.js');
const A = require(adapterPath);

let cells = 0; const bad = [];
const chk = (where, what, got, want) => { cells++; if (got !== want) bad.push(where + ' ' + what + ': ได้ ' + got + ' ควรเป็น ' + want); };

for (const [impl, I] of Object.entries(A.impls)) {
  for (const c of golden.cases) {
    const w = '[' + impl + '][' + c.name.split(':')[0] + ']';
    const x = I.load(c.raw);
    chk(w, 'effective.rate', x.effective.rate, c.effective.rate);
    chk(w, 'effective.freemin', x.effective.freemin, c.effective.freemin);
    if (x.effective.bookfee != null) chk(w, 'effective.bookfee', x.effective.bookfee, c.effective.bookfee);
    c.price.forEach((p, m) => chk(w, 'price(' + m + ')', x.price(m), p));
    c.fee.forEach((f, m) => chk(w, 'fee(' + m + ' นาที)', x.fee(m * 60000), f));
    c.live.forEach((l, m) => {
      // admin/master ไม่มีนาฬิกานับสดแยก ใช้ค่าเท่ากับ fee
      const want = impl === 'user' ? l : c.fee[m];
      chk(w, 'live(' + m + ' นาที)', x.live(m * 60000), want);
    });
    for (const [m, f] of Object.entries(c.feeExtra)) chk(w, 'fee(' + m + ' นาที)', x.fee(m * 60000), f);
    for (const [ms, f] of Object.entries(c.feeByMs)) chk(w, 'fee(' + ms + ' ms)', x.fee(+ms), f);
  }
}
if (typeof A.guards === 'function') {
  const g = A.guards();
  cells += g.cells;
  g.problems.forEach(x => bad.push('[guard] ' + x));
}
if (bad.length) {
  console.error('ไม่ผ่าน: ' + bad.length + ' จาก ' + cells + ' เซลล์ (adapter: ' + A.name + ')\n - ' + bad.slice(0, 30).join('\n - '));
  process.exit(1);
}
console.log('ผ่าน: ' + cells + ' เซลล์ตรงกับ golden.json (adapter: ' + A.name + '; ' + Object.keys(A.impls).join(', ') + ')');
