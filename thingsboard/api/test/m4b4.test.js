// M4 B4: POST /api/admin/barrier และ /api/admin/barrier/raise-all (staff/master) บน mock-tb เท่านั้น (AC-M4-4, 10, 12, 13, 14, 15)
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, STAFF, MEMBERS } = require('./harness');
const { DEVICE_ID } = require('./mock-tb');
const { loadConfig } = require('../config');
const { createBarrier } = require('../barrier');

const ENV = { BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0', BARRIER_COOLDOWN_MS: '0', BARRIER_RATE_MAX: '1000', BARRIER_ADMIN_RATE_MAX: '1000' };
const W = { writesEnabled: true, barrierEnabled: true };
const code = r => r.body && r.body.error && r.body.error.code;
const tel = (s, o = {}) => s.mock.setTel({ hb: 1, 'slot_1-0': false, 'slot_1-1': false, 'slot_1-2': false, 'bar_1-0': 0, 'bar_1-1': 0, 'bar_1-2': 0, ...o }, Date.now());
const seed = (s, over) => { s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 }); tel(s, over); };
const staffOf = async (s, email = 'staff@t.dev') => { const st = await s.member(email); s.mock.st.users.get(st.uid).customerId = { id: STAFF }; return st; };
const adm = (s, u, body) => s.call('POST', '/api/admin/barrier', { token: u.token, body });
const all = (s, u, body) => s.call('POST', '/api/admin/barrier/raise-all', { token: u.token, body });
const D = (i = 1, extra = {}) => ({ f: 1, i, down: true, ...extra });
const U = (i = 1, extra = {}) => ({ f: 1, i, down: false, ...extra });

test('AC-M4-13 staff ลด/ยกช่องที่ไม่มีการจอง: 200 RPC 1 ครั้งตรงตัว ไม่ตั้ง auto-raise', run(async s => {
  seed(s); const st = await staffOf(s);
  let r = await adm(s, st, D(1)); assert.equal(r.status, 200, r.raw);
  assert.deepEqual([r.body.sent, r.body.f, r.body.i, typeof r.body.serverNow], [true, 1, 1, 'number']);
  assert.equal(s.mock.rpcCount(), 1); assert.equal(s.mock.rpcCount(DEVICE_ID, '1-1'), 1);
  const x = s.mock.st.rpc[0]; assert.equal(x.method, 'setBarrier'); assert.deepEqual(x.params, { slot: '1-1', down: true });
  assert.deepEqual(Object.keys(x.body).sort(), ['method', 'params', 'timeout']); assert.equal('persistent' in x.body, false);
  assert.equal(s.routes.barrier.pendingTimers(), 0, 'staff ลดเองห้ามตั้งตัวจับเวลา 60 วิ');
  tel(s, { 'bar_1-1': 1 });
  r = await adm(s, st, U(1)); assert.equal(r.status, 200); assert.equal(r.body.sent, true);
  assert.deepEqual(s.mock.st.rpc[1].params, { slot: '1-1', down: false }); assert.equal(s.routes.barrier.pendingTimers(), 0);
}, ENV, W));

test('master (TENANT_ADMIN) สั่งได้เหมือน staff', run(async s => {
  seed(s); const m = await s.member('m@t.dev'); s.mock.st.users.get(m.uid).authority = 'TENANT_ADMIN';
  assert.equal((await adm(s, m, D(2))).status, 200); assert.equal(s.mock.rpcCount(), 1);
}, ENV, W));

test('AC-M4-13 ซ้ำสถานะเดิม (snapshot สด) = 200 already:true RPC 0', run(async s => {
  seed(s, { 'bar_1-1': 1 }); const st = await staffOf(s);
  const r = await adm(s, st, D(1)); assert.deepEqual([r.status, r.body.sent, r.body.already], [200, false, true]);
  const r2 = await adm(s, st, U(2)); assert.equal(r2.body.already, true);
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('AC-M4-13 occ:true ไม่ส่ง force = 409 SLOT_OCCUPIED RPC 0; force:true ทำได้ทั้งลดและยก', run(async s => {
  seed(s, { 'slot_1-1': true, 'bar_1-1': 1 }); const st = await staffOf(s);
  for (const b of [D(1), U(1), D(1, { force: false })]) { const r = await adm(s, st, b); assert.equal(r.status, 409); assert.equal(code(r), 'SLOT_OCCUPIED'); }
  assert.equal(s.mock.rpcCount(), 0);
  const r = await adm(s, st, U(1, { force: true })); assert.equal(r.status, 200); assert.equal(r.body.sent, true); assert.equal(s.mock.rpcCount(), 1);
}, ENV, W));

test('ยกเมื่อ occ ไม่ทราบ (null) ต้อง force; ลดไม่ต้อง; ช่องไม่มี telemetry (ไม่มีบอร์ดเจ้าของ) = 409 SLOT_UNKNOWN', run(async s => {
  seed(s, { 'slot_1-1': undefined, 'bar_1-1': undefined }); const st = await staffOf(s);
  let r = await adm(s, st, D(3)); assert.equal(r.status, 409); assert.equal(code(r), 'SLOT_UNKNOWN');   // 1-3 ไม่เคยมี telemetry
  r = await adm(s, st, U(1)); assert.equal(code(r), 'SLOT_OCCUPIED');                                    // 1-1 ของ Lot ออนไลน์แต่ occ null: ยกต้อง force
  r = await adm(s, st, U(3)); assert.equal(code(r), 'SLOT_UNKNOWN');                                     // 1-3 แมปไป sim ที่ไม่ได้ตั้งค่า = ไม่มีบอร์ดเจ้าของ
  assert.equal(s.mock.rpcCount(), 0);
}, { ...ENV, SLOT_DEVICE_DEFAULT: 'sim' }, W));

test('AC-M4-4 member: ใช้ endpoint staff = 403 FORBIDDEN ทุกแบบ RPC 0 (role ก่อนค้นข้อมูลช่อง)', run(async s => {
  seed(s); const a = await s.member('a@t.dev');
  for (const [fn, b] of [[adm, D(1)], [adm, U(1)], [adm, D(1, { force: true })], [all, {}], [all, { force: true }], [all, undefined]]) { const r = await fn(s, a, b); assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN'); }
  assert.equal((await s.call('POST', '/api/admin/barrier', { body: D(1) })).status, 401);
  assert.equal((await s.call('POST', '/api/admin/barrier/raise-all', { body: {} })).status, 401);
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('AC-M4-5/14 รูปแบบผิด/ฟิลด์ที่อ้างสิทธิ์ = 400 BAD_INPUT หรือ 404 ไม่มี RPC ไม่เป็น 500', run(async s => {
  seed(s); const st = await staffOf(s);
  for (const extra of [{ role: 'staff' }, { authFresh: true }, { uid: 'x' }, { b: 'admin' }, { by: 'x' }]) { const r = await adm(s, st, D(1, extra)); assert.equal(r.status, 400); assert.equal(code(r), 'BAD_INPUT'); }
  const bad = [undefined, null, [], 'x', {}, { f: 1, i: 1 }, { f: 1, i: 1, down: 'true' }, D(1, { force: 'yes' }), D(1, { f: [1] }), D(1, { i: [''] }), D(1, { i: 1.5 }), D(1, { i: -1 }), D(1, { f: '1' }), D(1, { i: null }),
    JSON.parse('{"f":1,"i":1,"down":true,"__proto__":{"x":1}}')];
  for (const b of bad) { const r = await adm(s, st, b); assert.ok(r.status === 400, JSON.stringify(b) + ' -> ' + r.status); }
  for (const b of [D(9), { f: 5, i: 0, down: true }, D(4)]) { const r = await adm(s, st, b); assert.equal(r.status, 404); assert.equal(code(r), 'NO_SLOT'); }
  for (const b of [{ role: 'staff' }, { force: 1 }, 5, 'x', [] ]) { const r = await all(s, st, b); assert.equal(r.status, 400, JSON.stringify(b)); }
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('AC-M4-12 BARRIER_RPC ปิด: ทั้งสอง endpoint ตอบ 503 BARRIER_DISABLED และ RPC = 0', run(async s => {
  seed(s); const st = await staffOf(s); assert.equal(s.routes.barrierEnabled, false);
  for (const b of [D(1), U(1), { f: 'x' }, undefined]) { const r = await adm(s, st, b); assert.equal(r.status, 503); assert.equal(code(r), 'BARRIER_DISABLED'); }
  for (const b of [{}, { force: true }, undefined]) { const r = await all(s, st, b); assert.equal(r.status, 503); assert.equal(code(r), 'BARRIER_DISABLED'); }
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, { writesEnabled: true }));

test('AC-M4-10 เพดาน staff 20/นาที/uid (ค่าเริ่มต้น) ครั้งที่ 21 = 429 RATE_LIMIT + Retry-After RPC ไม่เพิ่ม; staff อื่นไม่ถูกกระทบ', run(async s => {
  assert.equal(loadConfig({}).barrierAdminRateMax, 20); assert.equal(loadConfig({}).barrierRateMax, 6);
  seed(s); const a = await staffOf(s, 'a@t.dev'), b = await staffOf(s, 'b@t.dev');
  for (let n = 0; n < 20; n++) assert.equal((await adm(s, a, D(n % 3, { force: true }))).status, 200, 'ครั้งที่ ' + (n + 1));
  const r = await adm(s, a, D(1)); assert.equal(r.status, 429); assert.equal(code(r), 'RATE_LIMIT'); assert.ok(+r.headers.get('retry-after') >= 1); assert.ok(r.body.error.message.includes('วินาที'));
  assert.equal(s.mock.rpcCount(), 20);
  assert.equal((await all(s, a, {})).status, 429, 'raise-all ใช้เพดานเดียวกัน');
  assert.equal((await adm(s, b, D(1))).status, 200); assert.equal(s.mock.rpcCount(), 21);
}, { ...ENV, BARRIER_ADMIN_RATE_MAX: undefined }, W));

test('คูลดาวน์ต่อช่อง: staff สั่งซ้ำใน 3 วิ = 429 COOLDOWN (ช่องอื่นไม่ถูกกระทบ)', run(async s => {
  seed(s); const st = await staffOf(s);
  assert.equal((await adm(s, st, D(1))).status, 200);
  const r = await adm(s, st, D(1)); assert.equal(r.status, 429); assert.equal(code(r), 'COOLDOWN'); assert.ok(+r.headers.get('retry-after') >= 1);
  assert.equal((await adm(s, st, D(2))).status, 200); assert.equal(s.mock.rpcCount(), 2);
}, { ...ENV, BARRIER_COOLDOWN_MS: '3000' }, W));

test('ผลของ ThingsBoard: 504/409 -> 502 BOARD_OFFLINE, 500 -> 502 UPSTREAM ไม่ใช่ sent:true', run(async s => {
  seed(s); const st = await staffOf(s);
  for (const [stt, c] of [[504, 'BOARD_OFFLINE'], [409, 'BOARD_OFFLINE'], [500, 'UPSTREAM']]) {
    s.mock.st.rpcMode = () => ({ status: stt });
    const r = await adm(s, st, D(1)); assert.equal(r.status, 502); assert.equal(code(r), c); assert.notEqual(r.body.sent, true);
  }
}, ENV, W));

test('AC-M4-14 staff ถูกถอดสิทธิ์ขณะ authCache ยังจำ = 403 ทันที (authFresh) RPC 0, raise-all เช่นกัน', run(async s => {
  seed(s, { 'bar_1-1': 1 }); const st = await staffOf(s);
  assert.equal((await adm(s, st, U(1))).status, 200);                       // ผ่าน และ authCache จำ staff
  s.mock.st.users.get(st.uid).customerId = { id: MEMBERS };                   // ถอดสิทธิ์ใน TB
  const n = s.mock.rpcCount();
  let r = await adm(s, st, U(1)); assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN');
  r = await all(s, st, {}); assert.equal(r.status, 403);
  assert.equal(s.mock.rpcCount(), n);
}, ENV, W));

test('AC-M4-14 ถอดสิทธิ์ระหว่างรอคิวล็อก: ตรวจซ้ำในล็อก = 403 ไม่ส่ง RPC (ทั้งรายช่องและ raise-all)', run(async s => {
  seed(s, { 'bar_1-1': 1 }); const st = await staffOf(s);
  let release; const gate = new Promise(r => { release = r; });
  const hold = s.routes.bookings.mutex.run(() => gate);                    // ถือล็อกไว้
  const p1 = adm(s, st, U(1)), p2 = all(s, st, {});
  await new Promise(r => setTimeout(r, 150));                              // ให้ทั้งสองผ่าน authFresh รอคิวอยู่
  s.mock.st.users.get(st.uid).customerId = { id: MEMBERS };
  release(); await hold;
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 403); assert.equal(r2.status, 403); assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('AC-M4-15 raise-all: 3 ช่องลดอยู่ (1 มีรถ) ไม่ force -> ยก 2 ช่อง RPC 2 ครั้ง, ช่องมีรถ ok:false SLOT_OCCUPIED', run(async s => {
  seed(s, { 'bar_1-0': 1, 'bar_1-1': 1, 'bar_1-2': 1, 'slot_1-1': true }); const st = await staffOf(s);
  const r = await all(s, st, {}); assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.body.results, [{ f: 1, i: 0, ok: true }, { f: 1, i: 1, ok: false, code: 'SLOT_OCCUPIED' }, { f: 1, i: 2, ok: true }]);
  assert.equal(s.mock.rpcCount(), 2);
  assert.deepEqual(s.mock.st.rpc.map(x => [x.slot, x.down]).sort(), [['1-0', false], ['1-2', false]]);
  assert.ok(s.mock.st.rpc.every(x => !('persistent' in x.body) && Object.keys(x.params).sort().join() === 'down,slot'));
  assert.equal(s.routes.barrier.pendingTimers(), 0);
}, ENV, W));

test('raise-all force:true ยกช่องมีรถด้วย; body ว่าง/undefined = ไม่ force; ช่องที่ยกอยู่แล้วหรือไม่รู้ ไม่ถูกยิง', run(async s => {
  seed(s, { 'bar_1-0': 1, 'bar_1-1': 1, 'slot_1-1': true, 'bar_1-2': 0 }); const st = await staffOf(s);
  let r = await all(s, st, undefined); assert.equal(r.status, 200); assert.equal(s.mock.rpcCount(), 1);
  r = await all(s, st, { force: true }); assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, [{ f: 1, i: 0, ok: true }, { f: 1, i: 1, ok: true }]); assert.equal(s.mock.rpcCount(), 3);
}, ENV, W));

test('raise-all: ช่อง occ:null (ไม่ทราบ) ไม่ยกถ้าไม่ force; RPC ล้มรายช่อง = ok:false พร้อมรหัส ไม่ล้มทั้งคำขอ', run(async s => {
  seed(s, { 'bar_1-0': 1, 'bar_1-1': 1, 'slot_1-1': undefined }); const st = await staffOf(s);
  let r = await all(s, st, {}); assert.deepEqual(r.body.results, [{ f: 1, i: 0, ok: true }, { f: 1, i: 1, ok: false, code: 'SLOT_UNKNOWN' }]); assert.equal(s.mock.rpcCount(), 1);
  s.mock.st.rpcMode = () => ({ status: 504 });
  r = await all(s, st, { force: true }); assert.equal(r.status, 200); assert.deepEqual(r.body.results.map(x => [x.i, x.ok, x.code]), [[0, false, 'BOARD_OFFLINE'], [1, false, 'BOARD_OFFLINE']]);
}, ENV, W));

test('raise-all: ไม่มีช่องลดอยู่ = 200 results ว่าง RPC 0; snapshot ไม่สด = 409 SLOT_UNKNOWN', run(async s => {
  seed(s); const st = await staffOf(s);
  const r = await all(s, st, {}); assert.deepEqual([r.status, r.body.results], [200, []]); assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('log รายคำสั่ง (staff): มี why=staff / staff-raise-all, uid ย่อ, ไม่มีอีเมล/uid เต็ม; ส่งออก mark/line จาก createBarrier', async () => {
  const logs = [];
  await run(async s => {
    seed(s, { 'bar_1-0': 1 }); const st = await staffOf(s, 'priv@t.dev');
    await adm(s, st, D(1)); await adm(s, st, D(1, { force: 'x' })); await all(s, st, {});
    const t = logs.join('\n');
    assert.match(t, /role=staff .*result=ok why=staff\b/); assert.match(t, /why=staff-raise-all/); assert.match(t, /result=rejected:BAD_INPUT why=staff/);
    for (const bad of ['priv@t.dev', st.uid, st.token]) assert.equal(t.includes(bad), false, 'ห้ามมี ' + bad.slice(0, 6));
    assert.equal(typeof s.routes.barrier.mark, 'function'); assert.equal(typeof s.routes.barrier.line, 'function');
  }, ENV, { ...W, barrierLog: m => logs.push(m) });
});

test('createBarrier ส่งออก staffSet/staffRaiseAll/mark/line', () => {
  const b = createBarrier({ cfg: { barrierCooldownMs: 0 }, tb: { barrierEnabled: false }, lot: { onCarLeave: () => () => {}, observe: () => () => {} }, mutex: { run: f => f() } }, { log: () => {} });
  for (const k of ['memberDown', 'staffSet', 'staffRaiseAll', 'mark', 'line', 'release', 'stop']) assert.equal(typeof b[k], 'function', k);
});
