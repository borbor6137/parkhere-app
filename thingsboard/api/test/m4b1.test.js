// M4 B1: tb.rpcOneway + ตัวป้องกันชั้นล่าง, lot.activeBookingOf, hook รถออก, mock-tb (RPC/นับ/ช้า/now) บน mock เท่านั้น ไม่แตะ ThingsBoard จริง
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./harness');
const { createMockTb, DEVICE_ID, SIM_ID } = require('./mock-tb');
const { createTb } = require('../tb');
const { loadConfig } = require('../config');

const cmd = (slot, down) => ({ method: 'setBarrier', params: { slot, down } });
const ENV = { LOT_CACHE_MS: '0', LOT_ATTR_MS: '0' };
const seed = (s, t = Date.now()) => {
  s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, penalty: 20 });
  s.mock.setTel({ hb: 1, 'slot_1-0': false, 'slot_1-1': false, 'bar_1-0': 0, 'bar_1-1': 0 }, t);
};

test('BARRIER_RPC ปิด (ค่าเริ่มต้น): rpcOneway โยน BARRIER_DISABLED ก่อน fetch และ mock เห็น RPC 0 ครั้ง', run(async s => {
  assert.equal(s.cfg.barrierRpc, false); assert.equal(s.routes.barrierEnabled, false);
  const before = s.mock.st.calls.length;
  for (let n = 0; n < 5; n++) await assert.rejects(s.routes.tb.rpcOneway(DEVICE_ID, cmd('1-0', true)), e => e.status === 503 && e.code === 'BARRIER_DISABLED');
  assert.equal(s.mock.rpcCount(), 0); assert.equal(s.mock.st.rpc.length, 0);
  assert.equal(s.mock.st.calls.length, before, 'ไม่มีคำขอใดถึง ThingsBoard (fetch ไม่ถูกเรียก)');
}));

test('ตัวป้องกันตรวจที่ชั้น tb เอง: fetch ที่นับได้ต้องถูกเรียก 0 ครั้งเมื่อปิด (ใช้ fetch ปลอมแทน host ที่ไม่ใช่ mock)', async () => {
  let fetched = 0; const f = async () => { fetched++; return { status: 200, ok: true, text: async () => '' }; };
  const cfg = loadConfig({ TB_HOST: 'https://eu.thingsboard.cloud', TB_API_KEY: 'k' });
  const off = createTb(cfg, f); await assert.rejects(off.rpcOneway('dev-1', cmd('1-0', true)), e => e.code === 'BARRIER_DISABLED'); assert.equal(fetched, 0);
  const envOn = createTb(loadConfig({ TB_HOST: 'https://eu.thingsboard.cloud', TB_API_KEY: 'k', BARRIER_RPC: '1' }), f); await envOn.rpcOneway('dev-1', cmd('1-0', true)); assert.equal(fetched, 1);
  assert.equal(createTb(loadConfig({ BARRIER_RPC: '1' }), f, { barrierEnabled: false }).barrierEnabled, false, 'opts ชนะ env');
  for (const v of ['0', 'true', 'yes', '']) assert.equal(loadConfig({ BARRIER_RPC: v }).barrierRpc, false, 'มีแค่ "1" ที่เปิด: ' + v);
});

test('เปิดแล้ว: ส่ง RPC oneway รูปแบบถูก (setBarrier {slot,down}, timeout, ApiKey) ไปอุปกรณ์ที่ระบุ และนับแยกอุปกรณ์/ช่อง', run(async s => {
  assert.equal(s.routes.barrierEnabled, true);
  await s.routes.tb.rpcOneway(DEVICE_ID, cmd('1-2', true)); await s.routes.tb.rpcOneway(DEVICE_ID, cmd('1-2', false)); await s.routes.tb.rpcOneway(SIM_ID, cmd('1-3', true));
  const r = s.mock.st.rpc[0];
  assert.deepEqual([r.dev, r.method, r.slot, r.down, r.auth, r.body.timeout], [DEVICE_ID, 'setBarrier', '1-2', true, 'ApiKey', 10000]);
  assert.deepEqual(Object.keys(r.body).sort(), ['method', 'params', 'timeout'], 'ไม่ส่งข้อมูลอื่นไปบอร์ด');
  assert.deepEqual(Object.keys(r.params).sort(), ['down', 'slot']);
  assert.equal(s.mock.rpcCount(), 3); assert.equal(s.mock.rpcCount(DEVICE_ID), 2); assert.equal(s.mock.rpcCount(SIM_ID), 1);
  assert.equal(s.mock.rpcCount(DEVICE_ID, '1-2'), 2); assert.equal(s.mock.rpcCount(SIM_ID, '1-2'), 0); assert.equal(s.mock.rpcCount(SIM_ID, '1-3'), 1);
}, ENV, { barrierEnabled: true }));

test('ผลของ ThingsBoard: 504/409 = BOARD_OFFLINE 502, 500 = UPSTREAM 502, 404 อุปกรณ์ไม่มี = UPSTREAM, ช้าเกิน timeout = UPSTREAM (ไม่มี error.code = ไม่ทราบผล)', run(async s => {
  const tb = s.routes.tb;
  for (const st of [504, 409]) { s.mock.st.rpcMode = () => ({ status: st }); await assert.rejects(tb.rpcOneway(DEVICE_ID, cmd('1-0', true)), e => e.status === 502 && e.code === 'BOARD_OFFLINE'); }
  s.mock.st.rpcMode = () => ({ status: 500 }); await assert.rejects(tb.rpcOneway(DEVICE_ID, cmd('1-0', true)), e => e.status === 502 && e.code === 'UPSTREAM');
  s.mock.st.rpcMode = null; await assert.rejects(tb.rpcOneway('no-such-dev', cmd('1-0', true)), e => e.code === 'UPSTREAM');
  s.mock.st.rpcMode = () => ({ delay: 400 }); const t0 = Date.now();
  await assert.rejects(tb.rpcOneway(DEVICE_ID, cmd('1-0', true)), e => e.code === 'UPSTREAM'); assert.ok(Date.now() - t0 < 1500, 'timeout ตาม TB_TIMEOUT_MS');
  assert.equal(s.mock.rpcCount(DEVICE_ID, '1-0'), 4, 'mock นับทุกครั้งที่ถึง รวมที่ตอบ error/ช้า');
  s.mock.st.rpcMode = () => ({ delay: 50 }); const t1 = Date.now(); await tb.rpcOneway(DEVICE_ID, cmd('1-1', true)); assert.ok(Date.now() - t1 >= 45, 'ช้าแต่ไม่เกิน timeout = สำเร็จ');
}, { ...ENV, TB_TIMEOUT_MS: '200' }, { barrierEnabled: true }));

test('rpcOneway ตรวจอินพุต: deviceId/method ผิดรูป (path injection) = 400 ก่อน fetch', run(async s => {
  for (const d of ['../x', 'a/b', '', 'a b', 5, null, undefined, 'x'.repeat(65)]) await assert.rejects(s.routes.tb.rpcOneway(d, cmd('1-0', true)), e => e.status === 400 && e.code === 'BAD_INPUT');
  for (const m of ['', 'a/b', 'set barrier', 7, undefined]) await assert.rejects(s.routes.tb.rpcOneway(DEVICE_ID, { method: m, params: {} }), e => e.status === 400);
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, { barrierEnabled: true }));

test('mock: rpcApply สะท้อนเป็น bar_ ของอุปกรณ์นั้น, เส้นทางเดิม /api/plugins/rpc/oneway ก็รับ, ไม่ใช่ admin = 401 (นับด้วย)', run(async s => {
  s.mock.st.rpcApply = true; await s.routes.tb.rpcOneway(DEVICE_ID, cmd('1-0', true));
  assert.equal(s.mock.st.devs[DEVICE_ID]['bar_1-0'][0].value, '1'); assert.equal(s.mock.st.devs[SIM_ID]['bar_1-0'], undefined);
  const old = await fetch(s.cfg.tbHost + '/api/plugins/rpc/oneway/' + DEVICE_ID, { method: 'POST', headers: { 'X-Authorization': 'ApiKey mock-admin-key', 'Content-Type': 'application/json' }, body: JSON.stringify(cmd('1-1', true)) });
  assert.equal(old.status, 200);
  const bad = await fetch(s.cfg.tbHost + '/api/rpc/oneway/' + DEVICE_ID, { method: 'POST', headers: { 'X-Authorization': 'ApiKey wrong', 'Content-Type': 'application/json' }, body: JSON.stringify(cmd('1-1', true)) });
  assert.equal(bad.status, 401); assert.equal(s.mock.rpcCount(DEVICE_ID, '1-1'), 2);
}, ENV, { barrierEnabled: true }));

test('mock: now ฉีดได้ (setTel และเวลาบันทึก RPC ใช้นาฬิกาที่ฉีด)', async () => {
  const clock = { t: 5_000_000 }; const m = createMockTb({ membersId: 'm', staffId: 's', now: () => clock.t });
  m.setTel({ hb: 1 }); assert.equal(m.st.devs[DEVICE_ID].hb[0].ts, 5_000_000);
  const port = await m.listen(); try {
    clock.t = 7_000_000;
    const cfg = loadConfig({ TB_HOST: 'http://127.0.0.1:' + port, TB_API_KEY: 'mock-admin-key' });
    await createTb(cfg, undefined, { barrierEnabled: true }).rpcOneway(DEVICE_ID, cmd('1-0', false));
    assert.equal(m.st.rpc[0].at, 7_000_000);
  } finally { await m.close(); }
});

// ---------- lot.activeBookingOf ----------
const bk = (o = {}) => ({ id: 'b1', uid: 'u1', car: 'กข1234', s: Date.now() - 1000, e: Date.now() + 3600000, status: 'active', ...o });

test('lot.activeBookingOf: คืนเฉพาะรายการ active ของช่องนั้น (สำเนา) ไม่คืนสถานะจบ/ช่องอื่น/คีย์ผิดรูป/ก่อนมี snapshot', run(async s => {
  const lot = s.routes.lot; seed(s);
  assert.equal(lot.activeBookingOf('1-0'), null, 'ก่อนมี snapshot');
  s.mock.setAttr('bk_1-0', [bk({ id: 'done1', status: 'done' }), bk({ id: 'act1', s: 5000, e: 99999999999999 }), bk({ id: 'act2', s: 4000, e: 99999999999999 })]);
  s.mock.setAttr('bk_1-1', [bk({ id: 'x', status: 'cancelled' })]);
  await lot.fresh();
  const a = lot.activeBookingOf('1-0'); assert.equal(a.id, 'act2', 'หลายรายการ = เริ่มเร็วสุด'); assert.equal(a.uid, 'u1');
  a.uid = 'hacked'; assert.equal(lot.activeBookingOf('1-0').uid, 'u1', 'ได้สำเนา แก้แล้วไม่กระทบ snapshot');
  assert.equal(lot.activeBookingOf('1-1'), null); assert.equal(lot.activeBookingOf('1-2'), null);
  for (const bad of ['__proto__', 'constructor', '1-0; x', '', null, undefined, 5, {}, '1_0']) assert.equal(lot.activeBookingOf(bad), null);
  assert.equal(JSON.stringify(Object.keys(s.routes)).includes('activeBookingOf'), false);
  const r = await s.call('GET', '/api/lot', { token: (await s.member('a@x.co')).token });
  assert.equal(r.status, 200); assert.ok(!('activeBookingOf' in r.body), 'ไม่เปิดเป็น HTTP');
}, ENV));

// ---------- hook รถออก ----------
test('hook รถออก: occ true->false ขณะไม้กั้นลด = แจ้ง 1 ครั้ง; ไม่แจ้งเมื่อไม้ยกอยู่/occ null/ช่องอื่น/ซ้ำ snapshot เดิม; ตัวฟังพังไม่ล้มระบบ; ยกเลิกการฟังได้; hook ไม่ยิง RPC เอง', run(async s => {
  const lot = s.routes.lot, t = () => Date.now(); seed(s);
  const got = []; const off = lot.onCarLeave(ev => got.push(ev.k));
  lot.onCarLeave(() => { throw new Error('boom'); }); lot.onCarLeave(async () => { throw new Error('async boom'); });
  await lot.fresh(); assert.deepEqual(got, [], 'snapshot แรกไม่ใช่การเปลี่ยน');
  s.mock.setTel({ 'slot_1-0': true, 'bar_1-0': 1, 'slot_1-1': true, 'bar_1-1': 0 }, t()); await lot.fresh(); assert.deepEqual(got, []);
  s.mock.setTel({ 'slot_1-0': false, 'slot_1-1': false }, t()); await lot.fresh(); await lot.fresh();
  assert.deepEqual(got, ['1-0'], '1-0 ไม้ลดอยู่ = แจ้งครั้งเดียว; 1-1 ไม้ยกอยู่ = ไม่แจ้ง');
  s.mock.setTel({ 'slot_1-0': true }, t()); await lot.fresh(); assert.deepEqual(got, ['1-0'], 'false->true ไม่แจ้ง');
  s.mock.setTel({ 'slot_1-0': undefined }, t()); await lot.fresh();   // occ กลายเป็น null (ไม่มีค่า)
  s.mock.setTel({ 'slot_1-0': false }, t()); await lot.fresh(); assert.deepEqual(got, ['1-0'], 'null->false ไม่แจ้ง');
  s.mock.setTel({ 'slot_1-0': true }, t()); await lot.fresh(); off();
  s.mock.setTel({ 'slot_1-0': false }, t()); await lot.fresh(); assert.deepEqual(got, ['1-0'], 'ยกเลิกการฟังแล้ว');
  await new Promise(r => setTimeout(r, 50));   // M4 B3: ตัวรับ hook ของ barrier ยกให้ช่อง 1-0 ครั้งเดียว (รถออกขณะลดอยู่); lot เองไม่ยิง RPC
  assert.equal(s.mock.rpcCount(), 2, 'เฉพาะการยกอัตโนมัติของ barrier ที่ 1-0 ต่อการออกจริงแต่ละครั้ง (2 ครั้ง; ไม่ใช่ต่อ snapshot ซ้ำ)'); assert.equal(s.mock.rpcCount(DEVICE_ID, '1-0'), 2);
}, ENV, { barrierEnabled: true }));

test('hook รถออก: slot_/bar_ ของช่องที่ไม่ใช่ของอุปกรณ์นั้น (Lot ส่ง 1-0) ถูกตัดทิ้ง ไม่ทำให้เกิดรถออก', run(async s => {
  const lot = s.routes.lot, clock = { t: Date.now() }; seed(s, clock.t);
  const got = []; lot.onCarLeave(ev => got.push(ev.k));
  s.mock.setTel({ 'slot_1-0': true, 'bar_1-0': 1 }, clock.t); await lot.fresh();   // 1-0 เป็นของ sim: ค่าจาก Lot ถูกตัดทิ้ง
  s.mock.setTel({ 'slot_1-0': false }, clock.t); await lot.fresh();
  s.mock.setTel({ 'slot_1-0': true, 'bar_1-0': 1, hb: 1 }, clock.t, SIM_ID); await lot.fresh();
  s.mock.setTel({ 'slot_1-0': false, 'bar_1-0': 1, hb: 1 }, clock.t, SIM_ID); await lot.fresh();
  assert.deepEqual(got, ['1-0'], 'รถออกนับจากค่าของ sim (เจ้าของช่อง) เท่านั้น ครั้งเดียว');
}, { ...ENV, TB_SIM_DEVICE_ID: SIM_ID }, { barrierEnabled: true }));
