// M2: หลายอุปกรณ์ (ParkHere-Lot จริง 1 ตัว + ParkHere-Sim) — mock ThingsBoard เท่านั้น
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, run, sleep, slotOf } = require('./harness');
const { SIM_ID, DEVICE_ID: LOT } = require('./mock-tb');
const { loadConfig } = require('../config');

const MULTI = { TB_SIM_DEVICE_ID: SIM_ID };

test('ไม่ตั้ง TB_SIM_DEVICE_ID = ข้ามได้ไม่ error ไม่ยิงอุปกรณ์ sim (TB_SENSOR_DEVICE_ID เดิมอย่างเดียวยังทำงาน)', run(async s => {
  const u = await s.member('md0@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true' });
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.deepEqual(r.boards.map(b => b.id), ['lot']);
  assert.equal(slotOf(r, '1-1').source, 'lot');
  assert.equal(s.mock.st.devCalls[SIM_ID], undefined);
}));

test('ช่องบอกว่ามาจากอุปกรณ์ไหน/ออนไลน์ไหม; ช่องของ sim ที่ sim ไม่ส่งค่า = null', run(async s => {
  const u = await s.member('md1@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true', 'bar_1-1': '1' }, Date.now(), LOT);
  s.mock.setTel({ hb: 1, 'slot_1-0': 'false', 'slot_1-2': 'true', 'slot_2-0': 'true' }, Date.now(), SIM_ID);
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.deepEqual(r.boards.map(b => [b.id, b.status]), [['lot', 'online'], ['sim', 'online']]);
  assert.equal(r.board.status, 'online');
  const a = slotOf(r, '1-1'), b = slotOf(r, '1-2'), c = slotOf(r, '1-0'), d = slotOf(r, '1-5');
  assert.deepEqual([a.source, a.online, a.occ, a.barrier], ['lot', true, true, 'down']);
  assert.deepEqual([b.source, b.online, b.occ], ['sim', true, true]);
  assert.deepEqual([c.source, c.occ], ['sim', false]);
  assert.deepEqual([d.source, d.online, d.occ], ['sim', true, null]);   // 1-5 เป็นของ sim (ตามแมป) แต่ยังไม่มีค่า = ไม่ทราบสถานะ
}, MULTI));

test('ออนไลน์แยกรายอุปกรณ์: sim ออฟไลน์ -> ช่องของ sim เป็น null (ไม่ใช่ว่าง) แต่ช่องของบอร์ดจริงยังปกติ', run(async s => {
  const u = await s.member('md2@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true' }, Date.now(), LOT);
  s.mock.setTel({ hb: 1, 'slot_1-2': 'false', 'bar_1-2': '0' }, Date.now() - 200000, SIM_ID);
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.deepEqual(r.boards.map(b => [b.id, b.online]), [['lot', true], ['sim', false]]);
  assert.equal(r.board.online, true); assert.equal(r.board.status, 'online');
  const x = slotOf(r, '1-2');
  assert.deepEqual([x.source, x.online, x.occ, x.barrier], ['sim', false, null, null]);
  assert.equal(slotOf(r, '1-1').occ, true);
}, MULTI));

test('ทุกอุปกรณ์ไม่ออนไลน์: lot offline + sim never -> board.status offline และช่องเป็น null', run(async s => {
  const u = await s.member('md3@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true' }, Date.now() - 200000, LOT);
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.deepEqual(r.boards.map(b => [b.id, b.status]), [['lot', 'offline'], ['sim', 'never']]);
  assert.equal(r.board.status, 'offline'); assert.equal(slotOf(r, '1-1').occ, null);
}, MULTI));

test('Lot ส่ง slot_/bar_ ของช่องอื่น (1-2, 1-5, 1-6) มา = ถูกตัดทิ้ง; Sim ส่ง 1-1 มา = ถูกตัดทิ้ง; conflict ไม่เกิดอีก', run(async s => {
  const u = await s.member('md4@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'false', 'bar_1-1': '1', 'slot_1-2': 'true', 'slot_1-5': 'true', 'bar_1-5': '1', 'slot_1-6': 'true' }, Date.now(), LOT);
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true', 'bar_1-1': '0', 'slot_1-2': 'false', 'bar_1-2': '0' }, Date.now(), SIM_ID);
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  const a = slotOf(r, '1-1'), b = slotOf(r, '1-2'), c = slotOf(r, '1-5');
  assert.deepEqual([a.source, a.occ, a.barrier, a.conflict], ['lot', false, 'down', false]);   // 1-1 ใช้ค่าของ Lot เท่านั้น
  assert.deepEqual([b.source, b.occ, b.barrier, b.conflict], ['sim', false, 'up', false]);     // 1-2 ใช้ค่าของ Sim เท่านั้น (true ของ Lot ถูกทิ้ง)
  assert.deepEqual([c.source, c.occ, c.barrier], ['sim', null, null]);                           // 1-5: Lot ส่ง true/bar 1 แต่ตัดทิ้ง; Sim ไม่ส่ง = ไม่ทราบ
  assert.ok(r.slots.every(x => x.conflict === false));
  assert.equal(r.slots.length, 18);
}, MULTI));

test('ออนไลน์รายอุปกรณ์: Lot ไม่มา (offline) -> เฉพาะ 1-1 เป็น null ช่อง Sim ปกติ; Sim หลุด -> ช่อง Sim null ไม่กระทบ 1-1', run(async s => {
  const u = await s.member('md4b@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true', 'slot_1-2': 'true' }, Date.now() - 200000, LOT);
  s.mock.setTel({ hb: 1, 'slot_1-2': 'false', 'slot_2-3': 'true' }, Date.now(), SIM_ID);
  let r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.deepEqual([slotOf(r, '1-1').occ, slotOf(r, '1-1').online], [null, false]);
  assert.deepEqual([slotOf(r, '1-2').occ, slotOf(r, '1-2').online, slotOf(r, '2-3').occ], [false, true, true]);
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true' }, Date.now(), LOT);
  s.mock.setTel({ hb: 1 }, Date.now() - 200000, SIM_ID);
  await sleep(350);
  r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.deepEqual([slotOf(r, '1-1').occ, slotOf(r, '1-1').online], [true, true]);
  assert.deepEqual([slotOf(r, '1-2').occ, slotOf(r, '2-3').occ, slotOf(r, '2-3').online], [null, null, false]);
}, MULTI));

test('ไม่มีอุปกรณ์เจ้าของใน config (ตั้งแต่ Lot อย่างเดียวแต่แมปไป sim) = source null ไม่ทราบสถานะ; ไม่ตั้ง sim = โหมดอุปกรณ์เดียวเดิม (ทุกช่องเป็นของ Lot)', async () => {
  let s = await setup({ SLOT_DEVICE_DEFAULT: 'sim' });
  try {
    const u = await s.member('md4c@test.dev');
    s.mock.setTel({ hb: 1, 'slot_1-1': 'true', 'slot_1-2': 'true' }, Date.now(), LOT);
    const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
    assert.deepEqual([slotOf(r, '1-1').occ, slotOf(r, '1-1').source], [true, 'lot']);
    assert.deepEqual([slotOf(r, '1-2').occ, slotOf(r, '1-2').source, slotOf(r, '1-2').online], [null, null, null]);
  } finally { await s.close(); }
  s = await setup({});
  try {
    const u = await s.member('md4d@test.dev');
    s.mock.setTel({ hb: 1, 'slot_1-1': 'true', 'slot_1-2': 'true' }, Date.now(), LOT);
    const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
    assert.deepEqual([slotOf(r, '1-1').occ, slotOf(r, '1-2').occ, slotOf(r, '1-2').source], [true, true, 'lot']);
  } finally { await s.close(); }
});

test('config: SLOT_DEVICE_MAP / SLOT_DEVICE_DEFAULT (ค่าเริ่ม 1-1=lot, ที่เหลือ=sim ถ้ามี TB_SIM_DEVICE_ID) ผิดรูป = ข้าม', () => {
  let c = loadConfig({ TB_SENSOR_DEVICE_ID: 'a', TB_SIM_DEVICE_ID: 'b' });
  assert.deepEqual([c.slotMap, c.slotDefault], [{ '1-1': 'lot' }, 'sim']);
  c = loadConfig({ TB_SENSOR_DEVICE_ID: 'a' }); assert.equal(c.slotDefault, 'lot');
  c = loadConfig({ SLOT_DEVICE_MAP: '1-1=lot, 2-0=sim', SLOT_DEVICE_DEFAULT: 'dev2' });
  assert.deepEqual([c.slotMap, c.slotDefault], [{ '1-1': 'lot', '2-0': 'sim' }, 'dev2']);
});

// D1-1: ค่าพิมพ์ผิดต้อง fail-closed = 1-1=lot เสมอ (ไม่ใช่แมปว่างที่ทำให้ Sim ได้ 1-1) + เตือน + ไม่หลุดค่า env
test('D1-1 SLOT_DEVICE_MAP พิมพ์ผิดทุกแบบ -> ตกกลับ 1-1=lot + คำเตือน (ไม่ใช่แมปว่าง)', () => {
  const base = { TB_SENSOR_DEVICE_ID: 'a', TB_SIM_DEVICE_ID: 'b' };
  const bad = ['1-1=lot;', '"1-1=lot,2-0=bogus', '1-1=lot,xx=lot', '1-1=lot,1-3=bad', '1-1', '=lot', '1-1=', '1-1=lot=sim', '1-1=lot;2-0=sim', 'Lot', '1_1=lot', '1-1=l0t', '१-1=lot', '1-1=dev', ',,,', '  ', '""', "''"];
  for (const v of bad) {
    const c = loadConfig({ ...base, SLOT_DEVICE_MAP: v }), key = JSON.stringify(v);
    assert.deepEqual(c.slotMap, { '1-1': 'lot' }, 'map ' + key);
    assert.equal(c.slotMap['1-1'], 'lot', key);
    assert.equal(c.slotDefault, 'sim', key);
    const empty = v.replace(/["'\s]/g, '') === '';
    assert.equal(c.slotWarn.length, empty ? 0 : 1, 'warn ' + key);
  }
  assert.ok(!loadConfig({ ...base, SLOT_DEVICE_MAP: '1-1=ZZSECRETZZ' }).slotWarn.join('').includes('ZZSECRETZZ'), 'ไม่พิมพ์ค่า env ลงคำเตือน');
  const ok = ['"1-1=Lot"', " '1-1 = LOT , 2-0 = Sim' ", '1-1=lot,', ' 2-0=sim '];
  for (const v of ok) {
    const c = loadConfig({ ...base, SLOT_DEVICE_MAP: v });
    assert.equal(c.slotMap['1-1'], 'lot', v); assert.equal(c.slotWarn.length, 0, v);
  }
  assert.deepEqual(loadConfig({ ...base, SLOT_DEVICE_MAP: '"1-1 = Lot , 2-0 = SIM"' }).slotMap, { '1-1': 'lot', '2-0': 'sim' });
  assert.deepEqual(loadConfig({ ...base, SLOT_DEVICE_MAP: '2-0=sim' }).slotMap, { '2-0': 'sim', '1-1': 'lot' }, 'ไม่มี 1-1 = เติม lot');
});

test('D1-1 SLOT_DEVICE_DEFAULT พิมพ์ผิด -> ค่าเริ่มต้น + เตือน; "Sim" / ครอบอัญประกาศ รับได้', () => {
  const base = { TB_SENSOR_DEVICE_ID: 'a', TB_SIM_DEVICE_ID: 'b' };
  for (const v of ['"sim', 'sim;', 'si m', 'robot']) { const c = loadConfig({ ...base, SLOT_DEVICE_DEFAULT: v }); assert.equal(c.slotDefault, 'sim'); assert.equal(c.slotWarn.length, 1, v); }
  assert.equal(loadConfig({ TB_SENSOR_DEVICE_ID: 'a', SLOT_DEVICE_DEFAULT: 'x;' }).slotDefault, 'lot');
  assert.equal(loadConfig({ ...base, SLOT_DEVICE_DEFAULT: ' "LOT" ' }).slotDefault, 'lot');
  assert.equal(loadConfig({ ...base, SLOT_DEVICE_DEFAULT: "'Sim'" }).slotWarn.length, 0);
});

test('D1-1 startupSummary: แมป, default, มี SIM ไหม, สวิตช์ 4 ตัว, คำเตือน; ไม่มี ID/key', () => {
  const { startupSummary } = require('../config');
  const c = loadConfig({ TB_SENSOR_DEVICE_ID: 'LOT-SECRET-ID', TB_SIM_DEVICE_ID: 'SIM-SECRET-ID', TB_API_KEY: 'KEY-SECRET', ALLOW_LOCALHOST: '0', CONFIG_MASTER_ONLY: '1', SLOT_DEVICE_MAP: '"1-1=lot;' });
  const t = startupSummary(c).join('\n');
  assert.match(t, /คำเตือน config: SLOT_DEVICE_MAP/);
  assert.match(t, /แมปช่อง->อุปกรณ์: 1-1=lot \| SLOT_DEVICE_DEFAULT=sim \| มี TB_SIM_DEVICE_ID=ใช่/);
  assert.match(t, /ALLOW_LOCALHOST=0 CONFIG_MASTER_ONLY=1 BOOKINGS_WRITE=0 BARRIER_RPC=0/);
  assert.ok(!/SECRET/.test(t));
  assert.match(startupSummary(loadConfig({ TB_SENSOR_DEVICE_ID: 'a' })).join('\n'), /มี TB_SIM_DEVICE_ID=ไม่/);
});

test('D1-1 ผ่าน /api/lot: SLOT_DEVICE_MAP พิมพ์ผิด + Sim ส่ง slot_1-1=false -> 1-1 ยังเป็นของ Lot ไม่ใช่ Sim', run(async s => {
  const u = await s.member('d11@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true', 'bar_1-1': '1' }, Date.now(), LOT);
  s.mock.setTel({ hb: 1, 'slot_1-1': 'false', 'bar_1-1': '0' }, Date.now(), SIM_ID);
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body, c = slotOf(r, '1-1');
  assert.deepEqual([c.source, c.occ, c.barrier], ['lot', true, 'down']);
}, { ...MULTI, SLOT_DEVICE_MAP: '"1-1=lot;' }));

test('แมปจาก env: SLOT_DEVICE_MAP="1-1=lot,1-2=lot" ย้าย 1-2 ไปอ่านจาก Lot', run(async s => {
  const u = await s.member('md4e@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-2': 'true' }, Date.now(), LOT); s.mock.setTel({ hb: 1, 'slot_1-2': 'false' }, Date.now(), SIM_ID);
  const x = slotOf((await s.call('GET', '/api/lot', { token: u.token })).body, '1-2');
  assert.deepEqual([x.source, x.occ], ['lot', true]);
}, { ...MULTI, SLOT_DEVICE_MAP: '1-1=lot,1-2=lot' }));

test('อุปกรณ์ sim อ่านไม่ได้ (404) ไม่ทำให้ลานล้ม บอร์ดจริงยังตอบ; sim แสดง error', async () => {
  const s = await setup({ TB_SIM_DEVICE_ID: 'no-such-device' });
  try {
    const u = await s.member('md5@test.dev');
    s.mock.setTel({ hb: 1, 'slot_1-1': 'true' }, Date.now(), LOT);
    const rr = await s.call('GET', '/api/lot', { token: u.token });
    assert.equal(rr.status, 200);
    assert.deepEqual(rr.body.boards.map(b => [b.id, b.status]), [['lot', 'online'], ['sim', 'error']]);
    assert.equal(slotOf(rr.body, '1-1').occ, true);
  } finally { await s.close(); }
});

test('ทุกอุปกรณ์อ่านไม่ได้และไม่มี cache = 502', run(async s => {
  const u = await s.member('md6@test.dev');
  s.mock.st.failDev[LOT] = 500; s.mock.st.failDev[SIM_ID] = 500;
  assert.equal((await s.call('GET', '/api/lot', { token: u.token })).status, 502);
}, MULTI));

test('live: slot event มี source/online ของอุปกรณ์; board event เมื่อ sim หลุด; ช่องของ lot ที่ไม่เปลี่ยนไม่มี event', run(async s => {
  const u = await s.member('md7@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'false' }, Date.now(), LOT);
  s.mock.setTel({ hb: 1, 'slot_1-2': 'false' }, Date.now(), SIM_ID);
  const c = await s.sse(u.token); const snap = await c.wait('snapshot');
  assert.equal(snap.data.boards.length, 2);
  s.mock.setTel({ 'slot_1-2': 'true' }, Date.now(), SIM_ID);
  assert.deepEqual((await c.wait('slot', d => d.k === '1-2')).data, { k: '1-2', occ: true, barrier: null, source: 'sim', online: true, conflict: false });
  assert.equal(c.of('slot').filter(e => e.data.k === '1-1').length, 0);
  s.mock.setTel({ hb: 1, 'slot_1-2': 'true' }, Date.now() - 200000, SIM_ID);
  const b = await c.wait('board', d => d.boards.find(x => x.id === 'sim').status === 'offline');
  assert.equal(b.data.board.online, true);   // lot ยังออนไลน์
  assert.equal((await c.wait('slot', d => d.k === '1-2' && d.occ === null)).data.online, false);
  c.close();
}, MULTI));

test('config: TB_SENSOR_DEVICE_IDS คั่นจุลภาค + ตัวเดิม + SIM รวมกันไม่ซ้ำ ไม่ตั้ง = []', () => {
  assert.deepEqual(loadConfig({ TB_SENSOR_DEVICE_ID: 'a', TB_SIM_DEVICE_ID: 'b', TB_SENSOR_DEVICE_IDS: 'a, c,,b' }).devices, [{ name: 'lot', id: 'a' }, { name: 'sim', id: 'b' }, { name: 'dev2', id: 'c' }]);
  assert.deepEqual(loadConfig({}).devices, []);
  assert.deepEqual(loadConfig({ TB_SENSOR_DEVICE_ID: 'a' }).devices, [{ name: 'lot', id: 'a' }]);
});

test('เกณฑ์ไม่มีสัญญาณรายอุปกรณ์: sim เงียบ 120 วิ ยังออนไลน์ (เกณฑ์ 150) แต่ lot เงียบ 120 วิ = offline (เกณฑ์ 90); sim 160 วิ = offline', run(async s => {
  const u = await s.member('md8@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true' }, Date.now() - 120000, LOT);
  s.mock.setTel({ hb: 1, 'slot_1-2': 'true' }, Date.now() - 120000, SIM_ID);
  let r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.deepEqual(r.boards.map(b => [b.id, b.status]), [['lot', 'offline'], ['sim', 'online']]);
  assert.equal(slotOf(r, '1-1').occ, null); assert.equal(slotOf(r, '1-2').occ, true);
  s.mock.setTel({ hb: 1 }, Date.now() - 160000, SIM_ID);
  await sleep(350);
  r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.equal(r.boards.find(b => b.id === 'sim').status, 'offline'); assert.equal(slotOf(r, '1-2').occ, null);
}, MULTI));

test('เกณฑ์ไม่มีสัญญาณตั้งได้ด้วย env TB_SIM_OFFLINE_S / TB_LOT_OFFLINE_S; ค่าผิด = default; ไม่ตั้ง = sim 150 / lot 90', async () => {
  assert.deepEqual(loadConfig({}).offlineMs, { lot: 90000, sim: 150000, other: 90000 });
  assert.deepEqual(loadConfig({ TB_SIM_OFFLINE_S: '200', TB_LOT_OFFLINE_S: '60' }).offlineMs, { lot: 60000, sim: 200000, other: 60000 });
  assert.deepEqual(loadConfig({ TB_SIM_OFFLINE_S: 'abc', TB_LOT_OFFLINE_S: '-3' }).offlineMs, { lot: 90000, sim: 150000, other: 90000 });
  const s = await setup({ ...MULTI, TB_SIM_OFFLINE_S: '300' });
  try {
    const u = await s.member('md9@test.dev');
    s.mock.setTel({ hb: 1, 'slot_1-2': 'true' }, Date.now() - 200000, SIM_ID);
    const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
    assert.equal(r.boards.find(b => b.id === 'sim').status, 'online');
  } finally { await s.close(); }
});
