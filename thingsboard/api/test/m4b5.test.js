// AC-M4-19: bridge ไม่ซ้ำหน้าที่ — ทดสอบตรรกะใน bridge-core ด้วย fake (ไม่ต่อ Firebase/ThingsBoard, ไม่ส่ง RPC จริง)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCore } = require('../../bridge-core');

function mk(flags) {
  const rpcs = [], timers = [];
  let id = 0;
  const core = createCore({
    ...flags, autoRaiseMs: 60000,
    rpc: async (k, down, why) => { rpcs.push({ k, down, why }); },
    fail: (w, e) => { throw e; },
    setT: (fn, ms) => { timers.push({ id: ++id, fn, ms, live: true }); return id; },
    clearT: i => { const t = timers.find(x => x.id === i); if (t) t.live = false; },
  });
  const fire = () => timers.filter(t => t.live).forEach(t => { t.live = false; t.fn(); });
  return { core, rpcs, timers, fire };
}
const tick = () => new Promise(r => setImmediate(r));
const NOW = 1e12;
const cmd = (k = '1-0') => ({ [k]: { cmd: { u: 'x', b: 'bk', car: 'P', t: NOW - 1000 } } });

test('ปิดทั้งคู่: cmd ผู้ใช้ + รถออก ไม่ส่ง RPC แต่ยังสะท้อนสถานะ', async () => {
  const { core, rpcs, timers, fire } = mk({ userCmd: false, autoRaise: false });
  core.onBarrier(cmd(), NOW); await tick();
  assert.equal(rpcs.length, 0);
  assert.equal(core.seenCmd['1-0'], NOW - 1000);      // จำว่าเห็นแล้ว ไม่ส่งย้อนหลังตอนเปิดสวิตช์
  assert.deepEqual(core.onBar('1-0', true), { down: true, b: 'device', car: '', src: 'tb' });   // ยังสะท้อน bar_
  const a = core.onSlot('1-0', true); assert.ok(a); core.afterSlot('1-0', true, a.was);          // ยังสะท้อน slot_
  const c = core.onSlot('1-0', false); assert.deepEqual(c, { was: true }); core.afterSlot('1-0', false, c.was);
  core.armAutoRaise('1-0'); fire(); await tick();
  assert.equal(timers.length, 0);
  assert.equal(rpcs.length, 0);
  assert.equal(core.onSlot('1-0', false), false);     // ค่าซ้ำ = ไม่เขียนซ้ำ
});

test('ปิดทั้งคู่: state b:admin ยังสั่ง RPC ตามเดิม (จน M5) และ state จากบอร์ด/simulator ถูกเมิน', async () => {
  const { core, rpcs } = mk({ userCmd: false, autoRaise: false });
  core.onBarrier({ '1-1': { state: { b: 'admin', by: 'a@x', down: true, t: NOW - 500 } } }, NOW); await tick();
  assert.deepEqual(rpcs, [{ k: '1-1', down: true, why: 'แอดมินสั่ง' }]);
  core.onBarrier({ '1-1': { state: { b: 'admin', by: 'a@x', down: true, t: NOW - 500 } } }, NOW); await tick();
  assert.equal(rpcs.length, 1);                        // ไม่ซ้ำ
  core.onBarrier({ '1-2': { state: { b: 'admin', by: 'a@x', src: 'tb', down: true, t: NOW - 500 } } }, NOW);
  core.onBarrier({ '1-3': { state: { b: 'admin', by: 'a@x', down: true, t: NOW - 20000 } } }, NOW); await tick();
  assert.equal(rpcs.length, 1);                        // src หรือเก่าเกิน 15 วิ = ไม่สั่ง
  assert.deepEqual(core.onBar('1-1', true), { down: true, b: 'admin', car: '', src: 'tb' });
});

test('เปิดทั้งคู่ = พฤติกรรมเดิม: cmd -> ลด + ตั้งเวลา 60 วิ -> ยก / รถออก -> ยก', async () => {
  const { core, rpcs, timers, fire } = mk({ userCmd: true, autoRaise: true });
  core.onBarrier(cmd(), NOW); await tick();
  assert.deepEqual(rpcs, [{ k: '1-0', down: true, why: 'ผู้ใช้สั่ง' }]);
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 60000);
  assert.deepEqual(core.onBar('1-0', true), { down: true, b: 'bk', car: 'P', src: 'tb' });
  fire(); await tick();                                // รถไม่เข้า -> ยก
  assert.deepEqual(rpcs[1], { k: '1-0', down: false, why: 'รถไม่เข้าภายในเวลา' });
  // รถเข้าแล้วออก
  const a = core.onSlot('1-0', true); core.afterSlot('1-0', true, a.was);
  core.onBar('1-0', false); core.onBar('1-0', true);
  const c = core.onSlot('1-0', false); core.afterSlot('1-0', false, c.was); await tick();
  assert.deepEqual(rpcs[2], { k: '1-0', down: false, why: 'รถออกจากช่อง' });
  // cmd เก่าเกิน 15 วิ ไม่ส่ง
  core.onBarrier({ '1-5': { cmd: { b: 'bk', t: NOW - 16000 } } }, NOW); await tick();
  assert.equal(rpcs.length, 3);
});

test('เปิดเฉพาะ autoRaise: รถเข้าแล้วเลิกนับเวลา, ไม่ยกถ้ายังมีรถ', async () => {
  const { core, rpcs, fire } = mk({ userCmd: true, autoRaise: true });
  core.onBarrier(cmd(), NOW); await tick();
  core.onBar('1-0', true);
  const a = core.onSlot('1-0', true); core.afterSlot('1-0', true, a.was);
  fire(); await tick();
  assert.equal(rpcs.length, 1);
});

test('ค่าเริ่มต้นใน bridge.js = ปิด (ไม่ตั้ง env = 0) และใช้ bridge-core', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../bridge.js'), 'utf8');
  assert.match(src, /env\('BRIDGE_USER_CMD', '0'\) === '1'/);
  assert.match(src, /env\('BRIDGE_AUTO_RAISE', '0'\) === '1'/);
  assert.match(src, /createCore\(\{ userCmd: CFG\.userCmd, autoRaise: CFG\.autoRaise/);
  assert.doesNotMatch(src, /armAutoRaise|raiseTimer/);
});
