// M4 B3: ตัวจับเวลายกเอง 60 วิ, hook รถออก, ยกหลังยกเลิก, log รายคำสั่ง, คูลดาวน์ร่วม (AC-M4-7, 8, 11, 12 + log ของ AC-M4-6) บน mock-tb เท่านั้น
// ใช้ fake timers: ตัวจับเวลาจำลองที่ฉีดเข้า routes (เวลาไม่ไหลจริง) และ node:test mock.timers กับ createBarrier ตรง ๆ
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run, until, STAFF } = require('./harness');
const { DEVICE_ID } = require('./mock-tb');
const { createBarrier } = require('../barrier');

const ENV = { BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', BOOK_RATE_MAX: '1000', LEAVE_RATE_MAX: '1000', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0', BARRIER_COOLDOWN_MS: '3000', BARRIER_RATE_MAX: '1000' };
const code = r => r.body && r.body.error && r.body.error.code;
const tel = (s, o = {}) => s.mock.setTel({ hb: 1, 'slot_1-0': false, 'slot_1-1': false, 'slot_1-2': false, 'bar_1-0': 0, 'bar_1-1': 0, 'bar_1-2': 0, ...o }, Date.now());
const seed = (s, over) => { s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 }); tel(s, over); s.mock.st.rpcApply = true; };
let UN = 0; const plateOf = (u, i) => 'ขค' + u.n + '00' + i;
const user = async (s, email) => { const u = await s.member(email); u.n = ++UN; assert.equal((await s.call('PUT', '/api/me', { token: u.token, body: { cars: [0, 1, 2].map(i => ({ plate: plateOf(u, i) })) } })).status, 200); return u; };
const book = async (s, u, i) => { const r = await s.call('POST', '/api/bookings', { token: u.token, body: { f: 1, i, car: plateOf(u, i), pm: 'pp', reqId: 'req-' + crypto.randomUUID() } }); assert.equal(r.status, 201, r.raw); };
const down = (s, u, i = 1) => s.call('POST', '/api/barrier', { token: u.token, body: { f: 1, i, down: true } });
const staffOf = async s => { const st = await s.member('staff@t.dev'); s.mock.st.users.get(st.uid).customerId = { id: STAFF }; return st; };

// ตัวจับเวลาจำลอง: set เก็บไว้ advance(ms) เดินเวลาแล้วยิงตัวที่ถึง (ไม่รอ async ให้จบ ใช้ until ตรวจผลต่อ)
function fakeTimers() {
  let t = 0, id = 0; const q = new Map();
  return { set(fn, ms) { const h = ++id; q.set(h, { at: t + ms, fn }); return h; }, clear(h) { q.delete(h); }, advance(ms) { t += ms; for (const [h, e] of [...q]) if (e.at <= t) { q.delete(h); e.fn(); } }, size: () => q.size };
}
const W = (ft, logs) => ({ writesEnabled: true, barrierEnabled: true, barrierTimers: ft, barrierLog: m => logs.push(m) });
const rpcs = s => s.mock.st.rpc.map(r => [r.slot, r.down]);

test('AC-M4-7 ลดแล้วรถไม่เข้า: ครบ 60 วิ ยกเอง 1 ครั้ง (ก่อนครบยังไม่ยก) และ log ไม่มีทะเบียน/อีเมล/id การจอง', async () => {
  const ft = fakeTimers(), logs = [];
  await run(async s => {
    seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
    assert.equal((await down(s, a)).status, 200); assert.equal(s.mock.rpcCount(), 1); assert.equal(s.routes.barrier.pendingTimers(), 1);
    ft.advance(59999); await new Promise(r => setTimeout(r, 50)); assert.equal(s.mock.rpcCount(), 1, 'ยังไม่ครบ 60 วิ');
    ft.advance(1); await until(() => s.mock.rpcCount() === 2);
    assert.deepEqual(rpcs(s), [['1-1', true], ['1-1', false]]);
    assert.deepEqual(s.mock.st.rpc[1].params, { slot: '1-1', down: false }); assert.equal('persistent' in s.mock.st.rpc[1].body, false);
    await until(() => logs.some(l => /why=auto-timer.*result=ok|result=ok.*why=auto-timer/.test(l)) && s.routes.barrier.pendingTimers() === 0);   // log เขียนหลัง RPC เสร็จ (timers.delete เกิดก่อน) จึงรอ log จริง ไม่ใช่แค่ตัวจับเวลา
    const all = logs.join('\n') + JSON.stringify(s.mock.st.rpc);
    assert.match(logs.find(l => /why=auto-timer/.test(l)), /result=ok/);
    for (const bad of [plateOf(a, 1), 'a@t.dev', a.uid]) assert.equal(all.includes(bad), false, 'ห้ามมี ' + bad);
    const bid = (await s.call('GET', '/api/me/bookings', { token: a.token })).body.books[0].id; assert.equal(all.includes(bid), false);
  }, ENV, W(ft, logs))();
});

test('AC-M4-7 รถเข้าก่อนครบ 60 วิ (occ:true) -> ไม่ยก; occ:null ตอนครบเวลา -> ไม่ยก (ไม่รู้ว่ามีรถหรือไม่)', async () => {
  for (const mode of ['occupied', 'null']) {
    const ft = fakeTimers(), logs = [];
    await run(async s => {
      seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
      assert.equal((await down(s, a)).status, 200);
      if (mode === 'occupied') s.mock.setTel({ 'slot_1-1': true }); else s.mock.setTel({ 'slot_1-1': undefined });
      ft.advance(60000); await until(() => logs.some(l => /why=auto-timer/.test(l)));
      assert.equal(s.mock.rpcCount(), 1); assert.match(logs.find(l => /why=auto-timer/.test(l)), mode === 'occupied' ? /result=skip-occupied/ : /result=skip/);
    }, ENV, W(ft, logs))();
  }
});

test('AC-M4-7 ผู้ดูแลลดเอง (ไม่ใช่ member) ไม่ตั้งตัวจับเวลา; ส่ง RPC ล้ม (504) ไม่ตั้งตัวจับเวลา', async () => {
  const ft = fakeTimers(), logs = [];
  await run(async s => {
    seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
    s.mock.st.rpcMode = () => ({ status: 504 });
    const r = await down(s, a); assert.equal(r.status, 502); assert.equal(code(r), 'BOARD_OFFLINE');
    assert.equal(s.routes.barrier.pendingTimers(), 0); assert.equal(ft.size(), 0); assert.equal(s.mock.rpcCount(), 1);
    ft.advance(120000); await new Promise(r2 => setTimeout(r2, 50)); assert.equal(s.mock.rpcCount(), 1, 'ไม่ลองซ้ำเอง');
  }, ENV, W(ft, logs))();
});

test('AC-M4-8 รถออก (occ true->false) ขณะลดอยู่ -> ยก 1 ครั้ง ยกเลิกตัวจับเวลา; occ เป็น null -> ไม่ยก; snapshot ซ้ำไม่ยิงซ้ำ', async () => {
  const ft = fakeTimers(), logs = [];
  await run(async s => {
    seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
    assert.equal((await down(s, a)).status, 200);
    s.mock.setTel({ 'slot_1-1': true }); await s.routes.lot.fresh();          // รถเข้า
    s.mock.setTel({ 'slot_1-1': undefined }); await s.routes.lot.fresh();     // สัญญาณหาย occ:null
    await new Promise(r => setTimeout(r, 50)); assert.equal(s.mock.rpcCount(), 1, 'occ null ห้ามยก');
    s.mock.setTel({ 'slot_1-1': true }); await s.routes.lot.fresh();
    s.mock.setTel({ 'slot_1-1': false }); await s.routes.lot.fresh();         // รถออก
    await until(() => s.mock.rpcCount() === 2); assert.deepEqual(rpcs(s)[1], ['1-1', false]);
    assert.equal(s.routes.barrier.pendingTimers(), 0, 'ล้างตัวจับเวลา');
    for (let n = 0; n < 3; n++) await s.routes.lot.fresh();
    await new Promise(r => setTimeout(r, 50)); assert.equal(s.mock.rpcCount(), 2, 'ไม่ซ้ำ');
    assert.match(logs.find(l => /why=auto-leave/.test(l)), /result=ok/);
  }, ENV, W(ft, logs))();
});

test('AC-M4-8 รถออกแต่ไม้กั้นยกอยู่แล้ว -> ไม่ยิง RPC', async () => {
  const ft = fakeTimers(), logs = [];
  await run(async s => {
    seed(s, { 'slot_1-1': true }); s.mock.st.rpcApply = true;
    await s.routes.lot.fresh(); s.mock.setTel({ 'slot_1-1': false }); await s.routes.lot.fresh();
    await new Promise(r => setTimeout(r, 50)); assert.equal(s.mock.rpcCount(), 0);
  }, ENV, W(ft, logs))();
});

test('AC-M4-11 ยกเลิกการจองโดย staff ขณะไม้กั้นลดอยู่ occ:false -> ยก 1 ครั้ง barrier:"released"; ซ้ำ (replay) ไม่ยกอีก', async () => {
  const ft = fakeTimers(), logs = [];
  await run(async s => {
    seed(s); const a = await user(s, 'a@t.dev'), st = await staffOf(s); await book(s, a, 1);
    assert.equal((await down(s, a)).status, 200);
    const bid = (await s.call('GET', '/api/me/bookings', { token: a.token })).body.books[0].id;
    const r = await s.call('DELETE', '/api/bookings/' + bid, { token: st.token, body: { reason: 'ทดสอบ' } });
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.barrier, 'released');
    assert.deepEqual(rpcs(s), [['1-1', true], ['1-1', false]]); assert.equal(s.routes.barrier.pendingTimers(), 0);
    const r2 = await s.call('DELETE', '/api/bookings/' + bid, { token: st.token, body: { reason: 'ทดสอบ' } });
    assert.equal(r2.status, 200); assert.equal(s.mock.rpcCount(), 2);
    assert.match(logs.find(l => /why=cancel-release/.test(l)), /result=ok/);
  }, ENV, W(ft, logs))();
});

test('AC-M4-11 ยกเลิกตอน occ:true -> ไม่ยก barrier:"unchanged"; ไม้กั้นยกอยู่แล้ว -> unchanged; RPC ล้ม -> ยกเลิกสำเร็จ barrier:"failed"', async () => {
  const ft = fakeTimers(), logs = [];
  await run(async s => {
    seed(s); const a = await user(s, 'a@t.dev'), c = await user(s, 'c@t.dev'), d = await user(s, 'd@t.dev'), st = await staffOf(s);
    await book(s, a, 1); await book(s, c, 2); await book(s, d, 0);
    const id = async u => (await s.call('GET', '/api/me/bookings', { token: u.token })).body.books[0].id;
    const del = async u => s.call('DELETE', '/api/bookings/' + await id(u), { token: st.token, body: { reason: 'ทดสอบ' } });
    // ช่อง 1-0: ไม้กั้นยกอยู่ -> unchanged
    let r = await del(d); assert.equal(r.status, 200); assert.equal(r.body.barrier, 'unchanged'); assert.equal(s.mock.rpcCount(), 0);
    // ช่อง 1-1: ลดแล้วรถเข้า (occ:true) -> ยกเลิกได้แต่ไม่ยก
    assert.equal((await down(s, a, 1)).status, 200); s.mock.setTel({ 'slot_1-1': true });
    r = await del(a); assert.equal(r.status, 200); assert.equal(r.body.barrier, 'unchanged'); assert.equal(s.mock.rpcCount(), 1);
    // ช่อง 1-2: ลดอยู่ แต่ RPC ยกล้ม (504) -> ยกเลิกสำเร็จ barrier failed
    s.mock.st.rpcMode = null; assert.equal((await down(s, c, 2)).status, 200); assert.equal(s.mock.rpcCount(), 2);
    s.mock.st.rpcMode = () => ({ status: 504 });
    r = await del(c); assert.equal(r.status, 200, r.raw); assert.equal(r.body.barrier, 'failed');
    assert.equal(s.mock.rpcCount(), 3);
  }, ENV, W(ft, logs))();
});

test('AC-M4-12 BARRIER_RPC ปิด: ยกเลิก/hook/ตัวจับเวลา ไม่ยิง RPC (mock นับ 0) และ response ยกเลิกบอก unchanged', async () => {
  const ft = fakeTimers(), logs = [];
  await run(async s => {
    seed(s); const a = await user(s, 'a@t.dev'), st = await staffOf(s); await book(s, a, 1);
    s.mock.setTel({ 'slot_1-1': true, 'bar_1-1': 1 });                                    // ไม้กั้นลดอยู่ (บอร์ดรายงาน)
    await s.routes.lot.fresh(); s.mock.setTel({ 'slot_1-1': false }); await s.routes.lot.fresh();   // รถออก: hook เงียบ
    ft.advance(120000); assert.equal(s.routes.barrier.pendingTimers(), 0);
    const bid = (await s.call('GET', '/api/me/bookings', { token: a.token })).body.books[0].id;
    const r = await s.call('DELETE', '/api/bookings/' + bid, { token: st.token, body: { reason: 'ทดสอบ' } });
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.barrier, 'unchanged');
    assert.equal(s.mock.rpcCount(), 0);
  }, ENV, { writesEnabled: true, barrierTimers: ft, barrierLog: m => logs.push(m) })();
});

test('log รายคำสั่ง: ทุกคำสั่งมีบรรทัดเดียว (สำเร็จ/ปฏิเสธ) ไม่มีอีเมล ทะเบียน id; uid เป็น hash 8 ตัว', async () => {
  const ft = fakeTimers(), logs = [];
  await run(async s => {
    seed(s); const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev'); await book(s, a, 1);
    assert.equal(code(await down(s, b, 1)), 'NOT_YOUR_BOOKING');
    assert.equal((await down(s, a, 1)).status, 200);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /^\[barrier\] t=\d{4}-\d\d-\d\dT[\d:.]+Z slot=1-1 down=true role=member uid=[0-9a-f]{8} result=rejected:NOT_YOUR_BOOKING why=user$/);
    assert.match(logs[1], /result=ok why=user$/);
    const all = logs.join('\n'); for (const bad of ['a@t.dev', 'b@t.dev', a.uid, b.uid, plateOf(a, 1)]) assert.equal(all.includes(bad), false);
  }, ENV, W(ft, logs))();
});

test('คูลดาวน์ร่วม: ยกอัตโนมัติบันทึกเวลาช่อง -> สมาชิกสั่งลดซ้ำช่องเดิมทันทีได้ 429 COOLDOWN (ไม่ใช่ยิงสลับถี่)', async () => {
  const ft = fakeTimers(), logs = [];
  await run(async s => {
    seed(s); const a = await user(s, 'a@t.dev'), st = await staffOf(s); await book(s, a, 1);
    assert.equal((await down(s, a)).status, 200);
    const bid = (await s.call('GET', '/api/me/bookings', { token: a.token })).body.books[0].id;
    assert.equal((await s.call('DELETE', '/api/bookings/' + bid, { token: st.token, body: { reason: 'ทดสอบ' } })).body.barrier, 'released');
    await book(s, a, 1);
    const r = await down(s, a); assert.equal(r.status, 429); assert.equal(code(r), 'COOLDOWN');
    assert.equal(s.mock.rpcCount(), 2);
  }, ENV, W(ft, logs))();
});

test('รีสตาร์ต: snapshot แรกเจอช่องลดอยู่+ไม่มีรถ+มีการจองยังไม่มาถึง -> เริ่มนับ 60 วิแล้วยก; ช่องไม่มีการจอง (staff ลด) ไม่ถูกยก', async () => {
  const ft = fakeTimers(), logs = [];
  await run(async s => {
    s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 });
    tel(s, { 'bar_1-1': 1, 'bar_1-2': 1 }); s.mock.st.rpcApply = true;
    s.mock.setAttr('bk_1-1', [{ id: 'b1', uid: 'u1', car: 'กก1', s: Date.now() - 1000, e: Date.now() + 3600000, status: 'active' }]);
    await s.routes.lot.get();
    assert.equal(s.routes.barrier.pendingTimers(), 1);
    ft.advance(60000); await until(() => s.mock.rpcCount() === 1);
    assert.deepEqual(rpcs(s), [['1-1', false]]);
  }, ENV, W(ft, logs))();
});

test('createBarrier ตรง ๆ + node:test mock.timers: timer ระบบเดินด้วยเวลาจำลอง, stop() ล้างตัวจับเวลา, ปิดสวิตช์ = ไม่ตั้ง/ไม่ยิง', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = []; let hook, occ = false;
  const tb = { barrierEnabled: true, rpcOneway: async (id, b) => { calls.push([id, b.params.slot, b.params.down]); return { status: 200 }; } };
  const slot = () => ({ occ, barrier: 'down', source: 'ParkHere-Lot', online: true, conflict: false });
  const lot = { onCarLeave: fn => { hook = fn; return () => {}; }, observe: () => () => {}, fresh: async () => ({ slots: { '1-1': slot() }, bkAll: {} }) };
  const mutex = { run: fn => fn() };
  const cfg = { devices: [{ name: 'ParkHere-Lot', id: 'dev1' }], barrierCooldownMs: 0, barrierAutoRaiseMs: 60000 };
  const b = createBarrier({ cfg, tb, lot, mutex }, { log: () => {} });
  assert.equal(await b.release('1-1'), 'released'); assert.deepEqual(calls, [['dev1', '1-1', false]]);
  occ = null; assert.equal(await b.release('1-1'), 'unchanged'); occ = true; assert.equal(await b.release('1-1'), 'unchanged'); assert.equal(calls.length, 1, 'occ null/true ห้ามยก');
  occ = false; await hook({ k: '1-1', source: 'ParkHere-Lot', snap: { slots: { '1-1': slot() } } }); assert.equal(calls.length, 2);
  occ = null; await hook({ k: '1-1', source: 'ParkHere-Lot', snap: { slots: { '1-1': slot() } } }); assert.equal(calls.length, 2, 'hook ห้ามยกเมื่อ occ null');
  b.stop();
  const off = createBarrier({ cfg, tb: { ...tb, barrierEnabled: false }, lot, mutex }, { log: () => {} });
  assert.equal(await off.release('1-1'), 'unchanged'); assert.equal(calls.length, 2);
});

test('mock.timers: จับเวลา 60 วิของระบบจริงผ่าน setTimeout ที่ถูก mock (tick 59999 ไม่ยิง, tick 1 ยิง)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const bl = { slots: { '1-1': { occ: false, barrier: 'up', source: 'ParkHere-Lot', online: true, conflict: false } }, closed: {}, stale: false, bkAll: { '1-1': [{ id: 'b', uid: 'u', status: 'active', s: 1, e: 2 }] } };
  const tb = { barrierEnabled: true, rpcOneway: async (id, b) => { calls.push(b.params.down); bl.slots['1-1'].barrier = b.params.down ? 'down' : 'up'; return { status: 200 }; } };
  const lot = { onCarLeave: () => () => {}, observe: () => () => {}, fresh: async () => bl, get: async () => ({ config: { floors: 1, slots: 4 } }) };
  const cfg = { devices: [{ name: 'ParkHere-Lot', id: 'dev1' }], barrierCooldownMs: 0, barrierAutoRaiseMs: 60000 };
  const b = createBarrier({ cfg, tb, lot, mutex: { run: fn => fn() } }, { log: () => {} });
  const r = await b.memberDown({ uid: 'u', role: 'member' }, { f: 1, i: 1, down: true });
  assert.equal(r.body.sent, true); assert.deepEqual(calls, [true]); assert.equal(b.pendingTimers(), 1);
  t.mock.timers.tick(59999); await new Promise(r2 => setImmediate(r2)); assert.deepEqual(calls, [true]);
  t.mock.timers.tick(1); for (let n = 0; n < 50 && calls.length < 2; n++) await new Promise(r2 => setImmediate(r2)); assert.deepEqual(calls, [true, false]);
});
