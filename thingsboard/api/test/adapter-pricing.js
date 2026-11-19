'use strict';
// adapter ของ pricing.js (ฝั่งเซิร์ฟเวอร์) สำหรับ tests/pricing/check-golden.js (AC-14)
// รัน: node tests/pricing/check-golden.js thingsboard/api/test/adapter-pricing.js
// golden มีไฟล์เดียว: tests/pricing/golden.json (ห้ามทำสำเนา ห้ามสร้างใหม่เพื่อให้ผ่าน)
// live ของฝั่งเซิร์ฟเวอร์ = fee (เซิร์ฟเวอร์ไม่มีนาฬิกานับสด; golden เทียบ live กับ fee ให้ impl ที่ไม่ใช่ user)
const P = require('../pricing');
const S0 = 1700000000000;

module.exports = {
  name: 'thingsboard/api/pricing.js',
  S0,
  impls: {
    api: {
      file: 'thingsboard/api/pricing.js',
      load(raw) {
        const fee = ms => P.parkFee(raw, S0, S0 + ms);
        return { effective: P.effective(raw), price: m => P.price(raw, m), fee, live: fee, ext30: () => P.price(raw, 30) };
      },
    },
  },
};
