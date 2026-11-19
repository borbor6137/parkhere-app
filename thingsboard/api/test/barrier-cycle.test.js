// ทดแทน m4b5.test.js (ซึ่งผูก bridge-core.js): วงจรเต็ม ลด -> ครบ 60 วิ ยก -> รถเข้า -> ออก -> ยก บน api/barrier.js ล้วน ๆ
// mock-tb เท่านั้น ไม่ require bridge.js/bridge-core.js ไม่ยิง ThingsBoard จริง; รายละเอียดแยกกรณีอยู่ใน m4b3.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run, until } = require('./harness');

const ENV = { BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', BOOK_RATE_MAX: '1000', LEAVE_RATE_MAX: '1000', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0', BARRIER_COOLDOWN_MS: '0', BARRIER_RATE_MAX: '1000' };
const seed = s => {
  s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 });
  s.mock.setTel({ hb: 1, 'slot_1-0': false, 'slot_1-1': false, 'bar_1-0': 0, 'bar_1-1': 0 }, Date.now());
  s.mock.st.rpcApply = true;
};
function fakeTimers() {
  let t = 0, id = 0; const q = new Map();
  return { set(fn, ms) { const h = ++id; q.set(h, { at: t + ms, fn }); return h; }, clear(h) { q.delete(h); }, advance(ms) { t += ms; for (const [h, e] of [...q]) if (e.at <= t) { q.delete(h); e.fn(); } } };
}
const rpcs = s => s.mock.st.rpc.map(r => [r.slot, r.down]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function member(s) {
  const u = await s.member('cycle@t.dev'); const plate = 'ขค9000';
  assert.equal((await s.call('PUT', '/api/me', { token: u.token, body: { cars: [{ plate }] } })).status, 200);
  const b = await s.call('POST', '/api/bookings', { token: u.token, body: { f: 1, i: 1, car: plate, pm: 'pp', reqId: 'req-' + crypto.randomUUID() } });
  assert.equal(b.status, 201, b.raw);
  return u;
}
const down = (s, u) => s.call('POST', '/api/barrier', { token: u.token, body: { f: 1, i: 1, down: true } });

test('วงจรเต็ม: ลด -> รถไม่เข้า 60 วิ ยก -> ลดอีก รถเข้าแล้วออก -> ยก (สั่งโดย api เท่านั้น)', async () => {
  const ft = fakeTimers();
  await run(async s => {
    seed(s); const u = await member(s);
    assert.equal((await down(s, u)).status, 200);
    ft.advance(60000); await until(() => s.mock.rpcCount() === 2);
    assert.deepEqual(rpcs(s), [['1-1', true], ['1-1', false]]);       // รถไม่เข้า -> ยก
    assert.equal((await down(s, u)).status, 200);                      // ลดใหม่
    s.mock.setTel({ 'slot_1-1': true, 'bar_1-1': 1 }); await s.routes.lot.fresh();   // รถเข้า
    ft.advance(60000); await sleep(50); assert.equal(s.mock.rpcCount(), 3, 'รถเข้าแล้ว ครบเวลาไม่ยก');
    s.mock.setTel({ 'slot_1-1': false }); await s.routes.lot.fresh();                  // รถออก
    await until(() => s.mock.rpcCount() === 4);
    assert.deepEqual(rpcs(s)[3], ['1-1', false]);
    for (let n = 0; n < 3; n++) await s.routes.lot.fresh();
    await sleep(50); assert.equal(s.mock.rpcCount(), 4, 'ไม่ยิงซ้ำ');
  }, ENV, { writesEnabled: true, barrierEnabled: true, barrierTimers: ft, barrierLog: () => {} })();
});

test('BARRIER_RPC ปิด: ลด/ตัวจับเวลา/รถออก ไม่ส่ง RPC ใด ๆ', async () => {
  const ft = fakeTimers();
  await run(async s => {
    seed(s); const u = await member(s);
    const r = await down(s, u); assert.equal(r.status, 503);
    ft.advance(120000); s.mock.setTel({ 'slot_1-1': true }); await s.routes.lot.fresh(); s.mock.setTel({ 'slot_1-1': false }); await s.routes.lot.fresh();
    await sleep(50); assert.equal(s.mock.rpcCount(), 0);
  }, ENV, { writesEnabled: true, barrierEnabled: false, barrierTimers: ft, barrierLog: () => {} })();
});
