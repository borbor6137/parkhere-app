// M6 แผนใหม่: ผัง 3 ชั้น x 6 ช่อง, ชื่อช่อง 2 คอลัมน์, แมปช่อง->อุปกรณ์ (1-1=Lot ที่เหลือ=Sim), RPC ไปถูกอุปกรณ์, D5 ยังอยู่ บน mock-tb เท่านั้น
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, STAFF } = require('./harness');
const { DEVICE_ID: LOT, SIM_ID } = require('./mock-tb');
const { slotName } = require('../store');

const ENV = { TB_SIM_DEVICE_ID: SIM_ID, BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0', BARRIER_COOLDOWN_MS: '0', BARRIER_RATE_MAX: '1000', BARRIER_ADMIN_RATE_MAX: '1000' };
const W = { writesEnabled: true, barrierEnabled: true };
const code = r => r.body && r.body.error && r.body.error.code;
const staffOf = async (s, email = 'st@t.dev') => { const st = await s.member(email); s.mock.st.users.get(st.uid).customerId = { id: STAFF }; return st; };
const adm = (s, u, body) => s.call('POST', '/api/admin/barrier', { token: u.token, body });
const both = (s, o) => { s.mock.setTel({ hb: 1, ...o.lot }, Date.now(), LOT); s.mock.setTel({ hb: 1, ...o.sim }, Date.now(), SIM_ID); };

test('ชื่อช่อง 2 คอลัมน์ x 3 แถว: i0=A1 i1=A2 i2=B1 i3=B2 i4=C1 i5=C2', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(slotName), ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
});

test('ไม่มี config ใน TB = ค่าเริ่มต้น 3 ชั้น x 6 ช่อง (คีย์ {f}-{i}, i=0..5) 18 ช่อง และไม่มีช่อง i>=6', run(async s => {
  const u = await s.member('c1@t.dev');
  both(s, { lot: {}, sim: {} });
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.equal(r.config.floors, 3); assert.equal(r.config.slots, 6); assert.equal(r.configSource, 'default');
  assert.deepEqual(r.slots.map(x => x.k), [1, 2, 3].flatMap(f => [0, 1, 2, 3, 4, 5].map(i => f + '-' + i)));
}, ENV));

test('Lot ส่ง 1-2,1-5,1-6 มา ถูกตัดทิ้งทั้ง slot_ และ bar_; อ่านเฉพาะ slot_1-1/bar_1-1 จาก Lot', run(async s => {
  const u = await s.member('c2@t.dev');
  both(s, { lot: { 'slot_1-1': true, 'bar_1-1': 1, 'slot_1-2': true, 'bar_1-2': 1, 'slot_1-5': true, 'slot_1-6': true, 'bar_1-6': 1 }, sim: { 'slot_1-2': false, 'bar_1-2': 0 } });
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  const g = k => r.slots.find(x => x.k === k);
  assert.deepEqual([g('1-1').source, g('1-1').occ, g('1-1').barrier], ['lot', true, 'down']);
  assert.deepEqual([g('1-2').source, g('1-2').occ, g('1-2').barrier], ['sim', false, 'up']);
  assert.deepEqual([g('1-5').source, g('1-5').occ, g('1-5').barrier], ['sim', null, null]);
  assert.ok(!r.slots.some(x => x.k === '1-6'));
}, ENV));

test('RPC ไม้กั้น: 1-1 -> Lot, ช่องอื่น (1-2, 2-3) -> Sim; ไม่มีข้ามอุปกรณ์', run(async s => {
  const st = await staffOf(s);
  both(s, { lot: { 'slot_1-1': false, 'bar_1-1': 0, 'slot_1-2': false }, sim: { 'slot_1-2': false, 'bar_1-2': 0, 'slot_2-3': false, 'bar_2-3': 0, 'slot_1-1': false } });
  for (const [f, i] of [[1, 1], [1, 2], [2, 3]]) { const r = await adm(s, st, { f, i, down: true }); assert.equal(r.status, 200, r.raw); }
  assert.equal(s.mock.rpcCount(LOT), 1); assert.equal(s.mock.rpcCount(LOT, '1-1'), 1);
  assert.equal(s.mock.rpcCount(SIM_ID), 2); assert.equal(s.mock.rpcCount(SIM_ID, '1-2'), 1); assert.equal(s.mock.rpcCount(SIM_ID, '2-3'), 1);
  assert.deepEqual(s.mock.st.rpc.map(x => x.params), [{ slot: '1-1', down: true }, { slot: '1-2', down: true }, { slot: '2-3', down: true }]);
}, ENV, W));

test('ออนไลน์รายอุปกรณ์กับไม้กั้น: Lot ไม่มา -> 1-1 สั่งลดไม่ได้ (SLOT_UNKNOWN) แต่ช่อง Sim สั่งได้', run(async s => {
  const st = await staffOf(s);
  s.mock.setTel({ hb: 1, 'slot_1-1': false, 'bar_1-1': 0 }, Date.now() - 200000, LOT);
  s.mock.setTel({ hb: 1, 'slot_1-2': false, 'bar_1-2': 0 }, Date.now(), SIM_ID);
  assert.equal(code(await adm(s, st, { f: 1, i: 1, down: true })), 'SLOT_UNKNOWN');
  assert.equal(s.mock.rpcCount(), 0);
  assert.equal((await adm(s, st, { f: 1, i: 2, down: true })).status, 200); assert.equal(s.mock.rpcCount(SIM_ID, '1-2'), 1);
}, ENV, W));

test('D5 ยังอยู่กับช่อง Sim: occ===null ห้ามลดแม้ force; ยกต้อง force; ไม่มีรถ/มีรถ ตามปกติ', run(async s => {
  const st = await staffOf(s);
  both(s, { lot: { 'slot_1-1': false, 'bar_1-1': 0 }, sim: { 'bar_1-2': 0, 'slot_1-3': true, 'bar_1-3': 0 } });   // 1-2 ไม่มี slot_ = occ null
  let r = await adm(s, st, { f: 1, i: 2, down: true, force: true }); assert.equal(code(r), 'SLOT_UNKNOWN');
  r = await adm(s, st, { f: 1, i: 2, down: false }); assert.equal(code(r), 'SLOT_OCCUPIED');
  r = await adm(s, st, { f: 1, i: 3, down: true }); assert.equal(code(r), 'SLOT_OCCUPIED');
  assert.equal(s.mock.rpcCount(), 0);
  r = await adm(s, st, { f: 1, i: 3, down: true, force: true }); assert.equal(r.status, 200); assert.equal(s.mock.rpcCount(SIM_ID, '1-3'), 1);
}, ENV, W));
