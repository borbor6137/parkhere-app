// เดโม: SLOT_DEVICE_MAP "1-1=sim" (Wokwi Sim จำลองครบ 18 ช่องรวม 1-1) บน mock-tb เท่านั้น
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run, sleep, slotOf } = require('./harness');
const { DEVICE_ID: LOT, SIM_ID } = require('./mock-tb');
const { loadConfig } = require('../config');

const ENV = { TB_SIM_DEVICE_ID: SIM_ID, SLOT_DEVICE_MAP: '1-1=sim', BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', BOOK_RATE_MAX: '1000', LEAVE_RATE_MAX: '1000', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0', BARRIER_COOLDOWN_MS: '0', BARRIER_RATE_MAX: '1000' };
const W = { writesEnabled: true, barrierEnabled: true };

test('config: SLOT_DEVICE_MAP=1-1=sim ถูกต้อง ไม่เตือน ไม่ถูกเติม 1-1=lot ทับ (ตัวพิมพ์/อัญประกาศ/ช่องว่างรับได้)', () => {
  for (const v of ['1-1=sim', '"1-1=Sim"', ' 1-1 = SIM ']) {
    const c = loadConfig({ TB_SENSOR_DEVICE_ID: 'a', TB_SIM_DEVICE_ID: 'b', SLOT_DEVICE_MAP: v });
    assert.deepEqual(c.slotMap, { '1-1': 'sim' }, v); assert.equal(c.slotWarn.length, 0, v);
  }
  assert.deepEqual(loadConfig({ TB_SENSOR_DEVICE_ID: 'a', TB_SIM_DEVICE_ID: 'b' }).slotMap, { '1-1': 'lot' }, 'ค่าเริ่มต้นไม่เปลี่ยน');
});

test('1-1=sim: รับ slot_1-1/bar_1-1 จาก Sim, ตัด slot_1-1/bar_1-1 ที่ Lot ส่งมา, ครบ 18 ช่องเป็นของ Sim', run(async s => {
  const u = await s.member('sim11a@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'false', 'bar_1-1': '0' }, Date.now(), LOT);
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true', 'bar_1-1': '1', 'slot_3-5': 'true' }, Date.now(), SIM_ID);
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body, a = slotOf(r, '1-1');
  assert.deepEqual([a.source, a.online, a.occ, a.barrier, a.conflict], ['sim', true, true, 'down', false]);
  assert.equal(slotOf(r, '3-5').occ, true);
  assert.equal(r.slots.length, 18); assert.ok(r.slots.every(x => x.source === 'sim' && x.conflict === false));
}, ENV));

test('1-1=sim: offline รายอุปกรณ์ Lot เงียบ -> Sim ทุกช่องรวม 1-1 ยังปกติ; Sim เงียบ -> 1-1 เป็น null', run(async s => {
  const u = await s.member('sim11b@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true' }, Date.now() - 200000, LOT);   // Lot ไม่ส่งสัญญาณแล้ว
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true', 'slot_1-2': 'false' }, Date.now(), SIM_ID);
  let r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.deepEqual([slotOf(r, '1-1').occ, slotOf(r, '1-1').online, slotOf(r, '1-2').occ, slotOf(r, '1-2').online], [true, true, false, true]);
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true' }, Date.now(), LOT);
  s.mock.setTel({ hb: 1 }, Date.now() - 200000, SIM_ID);
  await sleep(50);
  r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.deepEqual([slotOf(r, '1-1').occ, slotOf(r, '1-1').online], [null, false]);
}, ENV));

const lower = async (s, name) => {
  s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 });
  const t = { hb: 1, 'slot_1-0': false, 'slot_1-1': false, 'bar_1-1': 0 };
  s.mock.setTel(t, Date.now(), LOT); s.mock.setTel(t, Date.now(), SIM_ID);
  const u = await s.member(name), plate = 'กข1234';
  assert.equal((await s.call('PUT', '/api/me', { token: u.token, body: { cars: [{ plate }] } })).status, 200);
  const b = await s.call('POST', '/api/bookings', { token: u.token, body: { f: 1, i: 1, car: plate, pm: 'pp', reqId: 'req-' + crypto.randomUUID() } });
  assert.equal(b.status, 201, b.raw);
  const r = await s.call('POST', '/api/barrier', { token: u.token, body: { f: 1, i: 1, down: true } });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(s.mock.st.rpc[0].params, { slot: '1-1', down: true });
};

test('1-1=sim: RPC setBarrier ของ 1-1 ไปที่ Sim ไม่ไป Lot', run(async s => {
  await lower(s, 'sim11c@test.dev');
  assert.equal(s.mock.rpcCount(SIM_ID, '1-1'), 1); assert.equal(s.mock.rpcCount(LOT), 0); assert.equal(s.mock.rpcCount(), 1);
}, ENV, W));

test('ค่าเริ่มต้น (ไม่ตั้ง SLOT_DEVICE_MAP): RPC ของ 1-1 ไป Lot ไม่ไป Sim (พฤติกรรมเดิมไม่เปลี่ยน)', run(async s => {
  await lower(s, 'sim11d@test.dev');
  assert.equal(s.mock.rpcCount(LOT, '1-1'), 1); assert.equal(s.mock.rpcCount(SIM_ID), 0);
}, { ...ENV, SLOT_DEVICE_MAP: undefined }, W));
