// M5 แก้ข้อพบ security/QA: S1 (member ไม่เรียก TB ซ้ำ), L1 (ไม้กั้น staff 403 ก่อน), L2 (shed), L3 (ไม่ log member), configEditable บน mock-tb เท่านั้น
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, STAFF } = require('./harness');

const ENV = { BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0', ADMIN_WRITE_RATE_MAX: '1000', ADMIN_LIST_RATE_MAX: '1000', ADMIN_LIST_CACHE_MS: '0', ME_RATE_MAX: '1000' };
const code = r => r.body && r.body.error && r.body.error.code;
const staffOf = async (s, email = 'staff@t.dev') => { const st = await s.member(email); s.mock.st.users.get(st.uid).customerId = { id: STAFF }; return st; };
const seed = s => { s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 }); s.mock.setTel({ hb: 1, 'slot_1-0': false }, Date.now()); };
const ROUTES = [['PUT', '/api/admin/closed', { set: { '1-0': true } }], ['PUT', '/api/admin/config', { rate: 30 }], ['GET', '/api/admin/bookings', undefined]];

test('S1 member 600 คำขอ (หลาย IP) ที่ 3 endpoint ของ admin ใช้ TB /api/auth/user <= 3 ครั้ง, 403 ไบต์เดียวกัน และ GET /api/me ของคนอื่นไม่ 503', async () => {
  await run(async s => {
    seed(s); const a = await s.member('a@t.dev'), b = await s.member('b@t.dev');
    const n0 = s.mock.st.authUserCalls; let first;
    for (let n = 0; n < 200; n++) for (const [m, p, body] of ROUTES) {
      const r = await s.call(m, p, { token: a.token, body });
      assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN');
      first = first || r.raw; assert.equal(r.raw, first, '403 ต้องไบต์เดียวกันทุกครั้ง');
    }
    assert.ok(s.mock.st.authUserCalls - n0 <= 3, 'TB auth calls = ' + (s.mock.st.authUserCalls - n0));
    assert.equal((await s.call('GET', '/api/me', { token: b.token })).status, 200);
  }, { ...ENV, TB_BUDGET: '100' })();
});

test('S1 staff ยังถูกตรวจสด (ถอดสิทธิ์มีผลทันที แม้ cache ยังเป็น staff) และ staff ทำงานได้ปกติ', async () => {
  await run(async s => {
    seed(s); const st = await staffOf(s);
    assert.equal((await s.call('GET', '/api/admin/bookings', { token: st.token })).status, 200);
    s.mock.st.users.get(st.uid).customerId = { id: 'members-cust' };
    const r = await s.call('GET', '/api/admin/bookings', { token: st.token });
    assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN');
  }, ENV, { writesEnabled: true })();
});

test('configEditable: member false, staff true (ปกติ), staff false เมื่อ CONFIG_MASTER_ONLY=1', async () => {
  await run(async s => {
    seed(s); const a = await s.member('a@t.dev'), st = await staffOf(s);
    assert.equal((await s.call('GET', '/api/me', { token: a.token })).body.configEditable, false);
    assert.equal((await s.call('GET', '/api/me', { token: st.token })).body.configEditable, true);
  }, ENV)();
  await run(async s => {
    seed(s); const st = await staffOf(s);
    assert.equal((await s.call('GET', '/api/me', { token: st.token })).body.configEditable, false);
  }, { ...ENV, CONFIG_MASTER_ONLY: '1' })();
});

test('L1 ไม้กั้นฝั่ง staff: member ได้ 403 ไบต์เดียวกันก่อน 400/404/503 ทุก body ทุกสถานะสวิตช์', async () => {
  for (const barrierEnabled of [true, false]) await run(async s => {
    seed(s); const a = await s.member('a@t.dev'); const seen = new Set();
    for (const body of [{}, { f: 99, i: 0, down: true }, { f: 1, i: 0, down: true }, { x: 1 }, undefined])
      for (const p of ['/api/admin/barrier', '/api/admin/barrier/raise-all']) {
        const r = await s.call('POST', p, { token: a.token, body }); assert.equal(r.status, 403, p + JSON.stringify(body)); seen.add(r.raw);
      }
    assert.equal(seen.size, 1); assert.equal(s.mock.rpcCount(), 0);
  }, ENV, { barrierEnabled })();
});

test('L3 member ถูกปฏิเสธ ไม่เขียน log (admin/ไม้กั้น); staff ที่ถูกปฏิเสธยัง log', async () => {
  const al = [], bl = [];
  await run(async s => {
    seed(s); const a = await s.member('a@t.dev'), st = await staffOf(s);
    for (const [m, p, body] of ROUTES) await s.call(m, p, { token: a.token, body });
    await s.call('POST', '/api/admin/barrier', { token: a.token, body: { f: 1, i: 0, down: true } });
    await s.call('POST', '/api/admin/barrier/raise-all', { token: a.token, body: {} });
    assert.equal(al.length, 0); assert.equal(bl.length, 0);
    await s.call('PUT', '/api/admin/closed', { token: st.token, body: { bad: 1 } });
    assert.equal(al.length, 1); assert.match(al[0], /rejected:/);
  }, ENV, { writesEnabled: true, barrierEnabled: true, adminLog: m => al.push(m), barrierLog: m => bl.push(m) })();
});

test('L2 GET /api/admin/bookings ผ่าน shed(): เกินงบ TB -> 503 BUSY (staff), member ยังได้ 403', async () => {
  await run(async s => {
    seed(s); const a = await s.member('a@t.dev'), st = await staffOf(s);
    assert.equal((await s.call('GET', '/api/admin/bookings', { token: st.token })).status, 503);
    assert.equal((await s.call('GET', '/api/admin/bookings', { token: a.token })).status, 403);
  }, { ...ENV, TB_BUDGET: '1' })();
});
