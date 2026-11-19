// ตรรกะตัดสินใจของ bridge (แยกออกมาให้ทดสอบได้ ไม่แตะ Firebase/ThingsBoard เอง)
// สวิตช์ (M4 ข้อ 4.9): userCmd = รับ barrier/{k}/cmd จากผู้ใช้ไปสั่ง RPC, autoRaise = ยกอัตโนมัติเมื่อรถออก/หมดเวลา
// เปิดทั้งคู่ = พฤติกรรมเดิมทุกอย่าง · ส่วนที่คงไว้เสมอ: สะท้อนสถานะ และรับ state b:'admin' (จน M5)
function createCore({ userCmd, autoRaise, autoRaiseMs, rpc, fail, setT = setTimeout, clearT = clearTimeout }) {
  const occ = {}, bar = {}, lastCmd = {}, seenCmd = {}, seenAdmin = {}, raiseTimer = {};

  function armAutoRaise(k) {
    if (!autoRaise) return;
    clearT(raiseTimer[k]);
    raiseTimer[k] = setT(() => { if (!occ[k] && bar[k]) rpc(k, false, 'รถไม่เข้าภายในเวลา').catch(e => fail('auto-raise', e)); }, autoRaiseMs);
  }

  // ค่าช่องจอดใหม่จาก telemetry · คืน true ถ้าค่าเปลี่ยน (ผู้เรียกเขียน Firebase sensors/ ต่อ)
  function onSlot(k, v) {
    if (occ[k] === v) return false;
    const was = occ[k]; occ[k] = v;
    return { was };
  }
  // เรียกหลังเขียน sensors/ แล้ว: รถมา = เลิกนับเวลา, รถออก = ยกไม้กั้น (เฉพาะเมื่อเปิด autoRaise)
  function afterSlot(k, v, was) {
    if (v) clearT(raiseTimer[k]);
    else if (autoRaise && was && bar[k]) rpc(k, false, 'รถออกจากช่อง').catch(e => fail('raise', e));
  }

  function onBar(k, v) {
    if (bar[k] === v) return null;
    bar[k] = v; const c = lastCmd[k] || {};
    return { down: v, b: v ? (c.b || 'device') : (c.b || ''), car: v ? (c.car || '') : '', src: 'tb' };
  }

  function onBarrier(all, now) {
    for (const [k, v] of Object.entries(all || {})) {
      const c = v && v.cmd, s = v && v.state;
      if (c && c.t > (seenCmd[k] || 0)) {
        seenCmd[k] = c.t;
        if (userCmd && now - c.t < 15000) {
          lastCmd[k] = { b: c.b, car: c.car || '' };
          rpc(k, true, 'ผู้ใช้สั่ง').then(() => armAutoRaise(k)).catch(e => fail('cmd', e));
        }
      }
      if (s && s.b === 'admin' && s.by && !s.src && s.t > (seenAdmin[k] || 0)) {
        seenAdmin[k] = s.t;
        if (now - s.t < 15000) { lastCmd[k] = { b: 'admin', car: '' }; rpc(k, !!s.down, 'แอดมินสั่ง').catch(e => fail('admin', e)); }
      }
    }
  }

  return { occ, bar, lastCmd, seenCmd, seenAdmin, raiseTimer, armAutoRaise, onSlot, afterSlot, onBar, onBarrier };
}
module.exports = { createCore };
