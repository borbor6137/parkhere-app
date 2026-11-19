/* ชื่อช่องจอดจากคีย์ "{ชั้น}-{index}" (ใช้ซ้ำได้ทั้งหน้าผู้ใช้และ admin)
   ผัง 2 คอลัมน์ x 3 แถว: index เรียงทีละแถว ซ้าย->ขวา
   0=A1 1=A2 2=B1 3=B2 4=C1 5=C2 (เกิน 6 ช่องก็ต่อแถวถัดไป D1.. ตามลำดับ)
   คีย์ผิดรูปแบบ -> '?' (ไม่โยน error) แยกไฟล์เพราะหน้าเว็บใช้ CSP ห้าม inline script */
(function (g) {
  'use strict';
  var COLS = 2;
  function phSlotName(key) {
    var m = /^(\d{1,2})-(\d{1,3})$/.exec(String(key == null ? '' : key));
    if (!m) return '?';
    var i = +m[2], row = Math.floor(i / COLS);
    if (row > 25) return '?';
    return String.fromCharCode(65 + row) + (i % COLS + 1);
  }
  g.phSlotName = phSlotName;
  g.PH_SLOT_COLS = COLS;
})(typeof window !== 'undefined' ? window : globalThis);
