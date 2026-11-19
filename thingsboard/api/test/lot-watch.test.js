// สคริปต์ lot-watch.js (อ่านอย่างเดียว): ทดสอบกับ API จริงในโปรเซส + mock ThingsBoard เท่านั้น ไม่แตะของจริง
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, run } = require('./harness');
const { SIM_ID, DEVICE_ID: LOT } = require('./mock-tb');
const { renderLot, createWatcher } = require('../../scripts/lot-watch');

const MULTI = { TB_SIM_DEVICE_ID: SIM_ID };
const text = (lot, now, o) => renderLot(lot, now, o).join('\n');

test('lot-watch: พิมพ์ online/offline รายอุปกรณ์และ occ:null พร้อมเหตุผล (lot ออนไลน์, sim offline)', run(async s => {
  await s.member('w1@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true', 'bar_1-1': '1' }, Date.now(), LOT);
  s.mock.setTel({ hb: 1, 'slot_1-2': 'false' }, Date.now() - 200000, SIM_ID);
  const w = createWatcher({ base: s.base, email: 'w1@test.dev', password: 'Passw0rd!x' });
  const lot = await w.lot();
  const t = text(lot, Date.now());
  assert.match(t, /อุปกรณ์ lot\s+ONLINE/);
  assert.match(t, /อุปกรณ์ sim\s+OFFLINE/);
  assert.match(t, /มีรถ 1 \/ ว่าง 0 \/ occ:null 17/);        // 18 ช่อง: 1-1 มีรถ ที่เหลือ null (ช่องอื่นเป็นของ sim ที่ offline)
  assert.match(t, /occ:null เพราะ sim offline: 1-0,1-2/);
  assert.doesNotMatch(t, /ว่าง 1\b/);                        // ช่องของ sim ที่ offline ต้องไม่ถูกนับเป็นว่าง
}, MULTI));

test('lot-watch: ยังไม่เคยมี telemetry = never และทุกช่อง occ:null', async () => {
  const s = await setup(MULTI);
  try {
    await s.member('w2@test.dev');
    const w = createWatcher({ base: s.base, email: 'w2@test.dev', password: 'Passw0rd!x' });
    let t = text(await w.lot(), Date.now());
    assert.match(t, /อุปกรณ์ lot\s+NEVER/); assert.match(t, /ไม่เคยมีข้อมูล/); assert.match(t, /occ:null 18/);
  } finally { await s.close(); }
});

test('lot-watch: แสดงรายการที่เปลี่ยนเทียบรอบก่อน (true -> null เมื่ออุปกรณ์หลุด) และ --all แสดงรายช่อง', run(async s => {
  await s.member('w3@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true' }, Date.now(), LOT);
  const w = createWatcher({ base: s.base, email: 'w3@test.dev', password: 'Passw0rd!x' });
  const a = await w.lot();
  s.mock.setTel({ hb: 1, 'slot_1-1': 'true' }, Date.now() - 200000, LOT);   // บอร์ดเงียบเกินเกณฑ์
  await new Promise(r => setTimeout(r, 350));
  const b = await w.lot();
  const t = text(b, Date.now(), { prev: a, all: true });
  assert.match(t, /เปลี่ยน 1-1: มีรถ\/ไม้กั้น\? -> occ:null\/ไม้กั้น\?/);
  assert.match(t, /เปลี่ยน อุปกรณ์ lot: online -> offline/);
  assert.match(t, /1-1 +occ:null .*lot offline/);
}));

test('lot-watch: ล็อกอินผิด = ข้อความชัด ไม่หลุดรหัสผ่านใน error; ไม่ส่ง token ใน URL; ไม่มีคำขอเขียนไป ThingsBoard', run(async s => {
  await s.member('w4@test.dev');
  const bad = createWatcher({ base: s.base, email: 'w4@test.dev', password: 'WrongPass!99' });
  await assert.rejects(bad.lot(), e => /ล็อกอินไม่สำเร็จ/.test(e.message) && !e.message.includes('WrongPass'));
  const urls = [];
  const spy = (u, o) => { urls.push(String(u)); return fetch(u, o); };
  const w = createWatcher({ base: s.base, email: 'w4@test.dev', password: 'Passw0rd!x', fetchImpl: spy });
  s.mock.st.writes.length = 0;
  await w.lot(); await w.lot();
  assert.ok(urls.every(u => !/token|password/i.test(u)));
  assert.equal(s.mock.st.writes.length, 0);
}));

test('lot-watch: token หมดอายุ (401) -> ล็อกอินใหม่เองแล้วอ่านต่อ', run(async s => {
  await s.member('w5@test.dev');
  let n = 0;
  const flaky = async (u, o) => {
    if (String(u).endsWith('/api/lot') && ++n === 1) return new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED', message: 'x' } }), { status: 401 });
    return fetch(u, o);
  };
  const w = createWatcher({ base: s.base, email: 'w5@test.dev', password: 'Passw0rd!x', fetchImpl: flaky });
  const lot = await w.lot();
  assert.ok(Array.isArray(lot.slots) && lot.slots.length === 18);
}));
