// M4 B2: POST /api/barrier (member) บน mock-tb เท่านั้น ไม่แตะ ThingsBoard จริง ไม่สร้างบัญชีจริง (บัญชีทดสอบอยู่ใน mock)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run, sleep, STAFF } = require('./harness');
const { DEVICE_ID, SIM_ID } = require('./mock-tb');

const ENV = { BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', BOOK_RATE_MAX: '1000', LEAVE_RATE_MAX: '1000', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0', BARRIER_COOLDOWN_MS: '0', BARRIER_RATE_MAX: '1000' };
const W = { writesEnabled: true, barrierEnabled: true };
const code = r => r.body && r.body.error && r.body.error.code;
const tel = (s, o = {}) => s.mock.setTel({ hb: 1, 'slot_1-0': false, 'slot_1-1': false, 'slot_1-2': false, 'bar_1-0': 0, 'bar_1-1': 0, 'bar_1-2': 0, ...o }, Date.now());
const seed = (s, over) => { s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 }); tel(s, over); };
let UN = 0; const plateOf = (u, i) => 'กข' + u.n + '00' + i;
const user = async (s, email) => { const u = await s.member(email); u.n = ++UN; assert.equal((await s.call('PUT', '/api/me', { token: u.token, body: { cars: [1, 2].map(i => ({ plate: plateOf(u, i) })) } })).status, 200); return u; };
const book = async (s, u, i) => { const r = await s.call('POST', '/api/bookings', { token: u.token, body: { f: 1, i, car: plateOf(u, i), pm: 'pp', reqId: 'req-' + crypto.randomUUID() } }); assert.equal(r.status, 201, r.raw); };
const down = (s, u, body) => s.call('POST', '/api/barrier', { token: u.token, body });
const D = (i = 1, extra = {}) => ({ f: 1, i, down: true, ...extra });

test('AC-M4-1 สมาชิกที่มีการจองยังไม่มาถึง ช่องออนไลน์ว่าง ลด -> 200 sent:true และ mock ได้ RPC 1 ครั้งตรงตัว', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  const r = await down(s, a, D(1)); assert.equal(r.status, 200, r.raw);
  assert.deepEqual([r.body.sent, r.body.f, r.body.i, typeof r.body.serverNow], [true, 1, 1, 'number']);
  assert.equal(s.mock.rpcCount(), 1); assert.equal(s.mock.rpcCount(DEVICE_ID, '1-1'), 1);
  const x = s.mock.st.rpc[0];
  assert.deepEqual(x.params, { slot: '1-1', down: true }); assert.equal(x.method, 'setBarrier');
  assert.deepEqual(Object.keys(x.body).sort(), ['method', 'params', 'timeout']); assert.equal(x.body.timeout, 10000); assert.equal('persistent' in x.body, false);
}, ENV, W));

test('AC-M4-12 BARRIER_RPC ปิด (ค่าเริ่มต้น): ทุกคำขอ 503 BARRIER_DISABLED และ mock นับ RPC = 0 แม้เงื่อนไขอื่นครบ', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  assert.equal(s.routes.barrierEnabled, false);
  for (const b of [D(1), D(1, { down: false }), { f: 'x' }, undefined]) { const r = await down(s, a, b); assert.equal(r.status, 503); assert.equal(code(r), 'BARRIER_DISABLED'); }
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, { writesEnabled: true }));

test('AC-M4-2 IDOR: ช่องของคนอื่น / ช่องไม่มีการจอง / การจองของตัวเองที่จบแล้ว = 403 NOT_YOUR_BOOKING เหมือนกันทุกไบต์ RPC 0', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev'); await book(s, a, 1);
  const r1 = await down(s, b, D(1)), r2 = await down(s, b, D(2));
  assert.equal(r1.status, 403); assert.equal(code(r1), 'NOT_YOUR_BOOKING'); assert.equal(r1.raw, r2.raw, 'ไม่บอกว่ามีการจองของคนอื่น');
  const mine = (await s.call('GET', '/api/me/bookings', { token: a.token })).body.books[0];
  assert.equal((await s.call('POST', `/api/bookings/${mine.id}/leave`, { token: a.token })).status, 200);
  const r3 = await down(s, a, D(1)); assert.equal(r3.raw, r1.raw);
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('AC-M4-3 หลังมาถึงห้ามลด: occ:true ที่ยังไม่มี arr และมี arr = 409 ALREADY_ARRIVED RPC 0', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  tel(s, { 'slot_1-1': true });
  let r = await down(s, a, D(1)); assert.equal(r.status, 409); assert.equal(code(r), 'ALREADY_ARRIVED');
  const bk = s.mock.st.assetAttrs['bk_1-1']; const arr = (typeof bk === 'string' ? JSON.parse(bk) : bk).map(x => ({ ...x, arr: Date.now() }));
  s.mock.setAttr('bk_1-1', arr); tel(s, { 'slot_1-1': false });
  r = await down(s, a, D(1)); assert.equal(code(r), 'ALREADY_ARRIVED');
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('AC-M4-3/D5 occ:null / บอร์ดออฟไลน์ -> 409 SLOT_UNKNOWN RPC 0', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  s.mock.setTel({ 'slot_1-1': undefined, 'bar_1-1': undefined }, Date.now());      // ช่องไม่มี telemetry: occ:null
  let r = await down(s, a, D(1)); assert.equal(r.status, 409); assert.equal(code(r), 'SLOT_UNKNOWN');
  tel(s); s.mock.setTel({ hb: 1, 'slot_1-1': false, 'bar_1-1': 0 }, Date.now() - 200000);   // ทุกค่าเก่า = ออฟไลน์
  r = await down(s, a, D(1)); assert.equal(code(r), 'SLOT_UNKNOWN');
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('ช่องปิดใช้งาน = 409 SLOT_CLOSED, slot_1-1 ที่ Sim ส่งมาถูกตัดทิ้ง (1-1 เป็นของ Lot) -> ยังลดได้ด้วยข้อมูลของ Lot', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  s.mock.setAttr('closed', { '1-1': true });
  assert.equal(code(await down(s, a, D(1))), 'SLOT_CLOSED');
  s.mock.setAttr('closed', {});
  s.mock.setTel({ hb: 1, 'slot_1-1': true, 'bar_1-1': 0 }, Date.now(), SIM_ID);   // Sim ออนไลน์ส่งคีย์ของ Lot: ต้องไม่มีผล
  const r = await down(s, a, D(1)); assert.equal(r.status, 200, r.raw);
  assert.equal(s.mock.rpcCount(), 1); assert.equal(s.mock.rpcCount(DEVICE_ID, '1-1'), 1); assert.equal(s.mock.rpcCount(SIM_ID), 0);
}, { ...ENV, TB_SIM_DEVICE_ID: SIM_ID }, W));

test('AC-M4-4 member: down:false / force / ช่องเกิน / ฟิลด์แปลกปลอม ถูกปฏิเสธ (role ก่อนค้นการจอง) RPC 0', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  for (const b of [D(1, { down: false }), D(1, { force: true }), D(1, { force: false })]) { const r = await down(s, a, b); assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN'); }
  for (const extra of [{ uid: 'x' }, { b: 'admin' }, { car: 'x' }, { id: 'x' }, { by: 'x' }, { role: 'staff' }, { authFresh: true }]) { const r = await down(s, a, D(1, extra)); assert.equal(r.status, 400); assert.equal(code(r), 'BAD_INPUT'); }
  for (const b of [D(9), { f: 5, i: 0, down: true }, D(4)]) { const r = await down(s, a, b); assert.equal(r.status, 404); assert.equal(code(r), 'NO_SLOT'); }
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('AC-M4-4 staff ใช้ endpoint นี้ไม่ได้ (เส้นทาง staff แยก path ใน B4): 403 FORBIDDEN', run(async s => {
  seed(s); const st = await s.member('st@t.dev'); s.mock.st.users.get(st.uid).customerId = { id: STAFF };
  const r = await down(s, st, D(1)); assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN');
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('AC-M4-5 รูปแบบข้อมูลผิด: 400/404 ไม่มี RPC ไม่เป็น 500', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  const bad = [undefined, null, [], 'x', 5, {}, { f: 1, i: 1 }, { f: 1, i: 1, down: 'true' }, { f: 1, i: 1, down: 1 }, { f: 1, i: 1, down: null },
    D(1, { f: [1] }), D(1, { i: [''] }), D(1, { i: '' }), D(1, { f: '1' }), D(1, { i: 1.5 }), D(1, { i: -1 }), D(1, { f: 0 }), D(1, { f: {} }), D(1, { i: null }), D(1, { i: 1e9 }),
    JSON.parse('{"f":1,"i":1,"down":true,"__proto__":{"x":1}}')];
  for (const b of bad) { const r = await down(s, a, b); assert.ok(r.status === 400 || r.status === 404, JSON.stringify(b) + ' -> ' + r.status); }
  assert.equal((await s.call('POST', '/api/barrier', { body: D(1) })).status, 401);
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('AC-M4-6 ไม่ส่งข้อมูลส่วนตัวให้บอร์ด: RPC/response ไม่มีทะเบียน uid id การจอง อีเมล', run(async s => {
  seed(s); const a = await user(s, 'priv@t.dev'); await book(s, a, 1);
  const id = (await s.call('GET', '/api/me/bookings', { token: a.token })).body.books[0].id;
  const r = await down(s, a, D(1)); assert.equal(r.status, 200);
  const blob = JSON.stringify(s.mock.st.rpc) + r.raw;
  for (const secret of [plateOf(a, 1), a.uid, id, 'priv@t.dev', a.token]) assert.equal(blob.includes(secret), false, 'รั่ว: ' + secret.slice(0, 6));
}, ENV, W));

test('AC-M4-9 ผลของ ThingsBoard: 504/409 -> 502 BOARD_OFFLINE, 500 -> 502 UPSTREAM; ไม่ลองซ้ำเอง ไม่ persistent', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  for (const [st, c] of [[504, 'BOARD_OFFLINE'], [409, 'BOARD_OFFLINE'], [500, 'UPSTREAM']]) {
    s.mock.st.rpcMode = () => ({ status: st }); const n = s.mock.rpcCount();
    const r = await down(s, a, D(1)); assert.equal(r.status, 502); assert.equal(code(r), c); assert.notEqual(r.body.sent, true); assert.equal(s.mock.rpcCount(), n + 1);
  }
  assert.ok(s.mock.st.rpc.every(x => !('persistent' in x.body)));
}, ENV, W));

test('AC-M4-10 เพดาน: ครั้งที่ 7 ใน 1 นาที = 429 RATE_LIMIT + Retry-After, RPC ไม่เพิ่ม, ผู้ใช้อื่นไม่ถูกกระทบ', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev'); await book(s, a, 1); await book(s, b, 2);
  for (let n = 0; n < 6; n++) assert.equal((await down(s, a, D(1))).status, 200, 'ครั้งที่ ' + (n + 1));
  const r = await down(s, a, D(1)); assert.equal(r.status, 429); assert.equal(code(r), 'RATE_LIMIT'); assert.ok(+r.headers.get('retry-after') >= 1); assert.ok(r.body.error.message.includes('วินาที'));
  assert.equal(s.mock.rpcCount(), 6);
  assert.equal((await down(s, b, D(2))).status, 200); assert.equal(s.mock.rpcCount(), 7);
}, { ...ENV, BARRIER_RATE_MAX: '6' }, W));

test('AC-M4-10 คูลดาวน์ต่อช่อง: ซ้ำใน 3 วิ = 429 COOLDOWN ไม่ยิง RPC; ช่องอื่นไม่ถูกกระทบ; พ้นเวลาส่งได้', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1); await book(s, a, 2);
  assert.equal((await down(s, a, D(1))).status, 200);
  const r = await down(s, a, D(1)); assert.equal(r.status, 429); assert.equal(code(r), 'COOLDOWN'); assert.ok(+r.headers.get('retry-after') >= 1);
  assert.equal(s.mock.rpcCount(), 1);
  assert.equal((await down(s, a, D(2))).status, 200); assert.equal(s.mock.rpcCount(), 2);
  await sleep(320); assert.equal((await down(s, a, D(1))).status, 200); assert.equal(s.mock.rpcCount(), 3);
}, { ...ENV, BARRIER_COOLDOWN_MS: '300' }, W));

test('AC-M4-10 ลดอยู่แล้ว (snapshot สด) = 200 already:true sent:false RPC 0; ออฟไลน์ไม่ใช้ตัดสินนี้', run(async s => {
  seed(s, { 'bar_1-1': 1 }); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  const r = await down(s, a, D(1)); assert.equal(r.status, 200); assert.deepEqual([r.body.sent, r.body.already], [false, true]); assert.equal(s.mock.rpcCount(), 0);
  s.mock.setTel({ hb: 1, 'slot_1-1': false, 'bar_1-1': 1 }, Date.now() - 200000);
  assert.equal(code(await down(s, a, D(1))), 'SLOT_UNKNOWN'); assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('คำขอที่ไม่ผ่านการตรวจไม่ติดคูลดาวน์ และเมื่อบอร์ดตอบ bar_=1 คำสั่งซ้ำ = already ไม่ยิงซ้ำ', run(async s => {
  seed(s); s.mock.st.rpcApply = true; const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  assert.equal(code(await down(s, a, D(1, { force: true }))), 'FORBIDDEN');
  assert.equal((await down(s, a, D(1))).body.sent, true);
  const r = await down(s, a, D(1)); assert.equal(r.status, 200); assert.equal(r.body.already, true); assert.equal(s.mock.rpcCount(), 1);
}, { ...ENV, BARRIER_COOLDOWN_MS: '3000' }, W));

test('หลายคำขอพร้อมกัน (ล็อกเดียว) ช่องเดิม: ยิง RPC ได้ครั้งเดียว ที่เหลือโดนคูลดาวน์', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); await book(s, a, 1);
  const rs = await Promise.all(Array.from({ length: 4 }, () => down(s, a, D(1))));
  assert.equal(rs.filter(r => r.status === 200).length, 1); assert.equal(rs.filter(r => code(r) === 'COOLDOWN').length, 3); assert.equal(s.mock.rpcCount(), 1);
}, { ...ENV, BARRIER_COOLDOWN_MS: '3000' }, W));
