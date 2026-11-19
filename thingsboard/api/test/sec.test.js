// M3 แก้ผลรีวิว security (docs/qa/2026-11-18-m3-security-review.md) F-1..F-4, F-7 บน mock-tb เท่านั้น
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run, sleep, STAFF, MEMBERS } = require('./harness');
const { longDigits } = require('../lib');

const rid = () => 'req-' + crypto.randomUUID();
const good = (o = {}) => ({ f: 1, i: 1, car: 'กข1234', pm: 'pp', reqId: rid(), ...o });
const code = r => r.body && r.body.error && r.body.error.code;
const ENV = { BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', BOOK_RATE_MAX: '1000', LEAVE_RATE_MAX: '1000', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0' };
const W = { writesEnabled: true };
const seed = s => {
  s.mock.setAttr('config', { floors: 2, slots: 12, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 });
  const t = { hb: 1 }; for (let i = 0; i < 12; i++) t['slot_1-' + i] = false; s.mock.setTel(t);
};
const user = async (s, email, cars = ['กข1234']) => {
  const u = await s.member(email);
  assert.equal((await s.call('PUT', '/api/me', { token: u.token, body: { cars: cars.map(plate => ({ plate })) } })).status, 200);
  return u;
};
const staffUser = async (s, email) => { const u = await s.member(email); s.mock.st.users.get(u.uid).customerId = { id: STAFF }; return u; };
const post = (s, u, body) => s.call('POST', '/api/bookings', { token: u.token, body });
const del = (s, u, id, body) => s.call('DELETE', '/api/bookings/' + id, { token: u.token, body });
const wr = s => s.mock.st.wr.length;

// ---------- F-1 ----------
test('F-1: ถอดสิทธิ์ staff แล้วยกเลิกทันที = 403 (ไม่รอ authCache 60 วิ) ไม่เขียน ไม่มีใบเสร็จคืนเงิน', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const st = await staffUser(s, 'st@t.dev');
  const b1 = (await post(s, a, good({ i: 1 }))).body.booking, b2 = (await post(s, a, good({ i: 2, car: 'กข1234' })));   // b2 = ซ้ำรถ -> 409
  assert.equal(b2.status, 409);
  // อุ่น cache ของ staff ให้เห็นเป็น staff (ผ่าน endpoint ที่ใช้ authUser ปกติ)
  assert.equal((await s.call('GET', '/api/me', { token: st.token })).body.role, 'staff');
  // ถอดสิทธิ์ใน ThingsBoard (ย้ายไป customer Members) แล้วยิงทันทีทั้งที่ cache ยังไม่หมดอายุ
  s.mock.st.users.get(st.uid).customerId = { id: MEMBERS };
  const w0 = wr(s), c0 = s.mock.st.authUserCalls;
  const r = await del(s, st, b1.id); assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN');
  assert.ok(s.mock.st.authUserCalls > c0, 'ต้องถาม ThingsBoard ใหม่');
  assert.equal(wr(s), w0);
  assert.equal(s.mock.st.assetAttrs['bk_1-1'].length, 1, 'การจองยังอยู่');
  // ออกจากแอปทั้งหมด (ย้ายไป customer อื่น) = 403 เช่นกัน
  const st2 = await staffUser(s, 'st2@t.dev');
  assert.equal((await s.call('GET', '/api/me', { token: st2.token })).status, 200);
  s.mock.st.users.get(st2.uid).customerId = { id: 'other' };
  const w1 = wr(s);
  assert.equal(code(await del(s, st2, b1.id)), 'FORBIDDEN'); assert.equal(wr(s), w1);
}, ENV, W));

test('F-1: staff ที่ยังมีสิทธิ์ยกเลิกได้ปกติ และถาม ThingsBoard สดทุกครั้ง; member ไม่ทำให้ถามเพิ่ม; เลื่อนขั้นเป็น staff ต้องรอ cache (ทางปลอดภัย)', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const st = await staffUser(s, 'st@t.dev');
  const b1 = (await post(s, a, good({ i: 1 }))).body.booking;
  await s.call('GET', '/api/me', { token: st.token });
  let c0 = s.mock.st.authUserCalls;
  const r = await del(s, st, b1.id); assert.equal(r.status, 200); assert.equal(r.body.booking.status, 'cancelled');
  assert.equal(s.mock.st.authUserCalls - c0, 1, 'cache hit + 1 ครั้งสด');
  c0 = s.mock.st.authUserCalls;
  await del(s, st, b1.id); await del(s, st, b1.id);
  assert.equal(s.mock.st.authUserCalls - c0, 2, 'ทุกคำขอ staff ถามสด');
  // member: 403 โดยไม่ถามเพิ่มหลัง cache อุ่น
  await s.call('GET', '/api/me', { token: a.token }); c0 = s.mock.st.authUserCalls;
  assert.equal(code(await del(s, a, b1.id)), 'FORBIDDEN'); assert.equal(s.mock.st.authUserCalls, c0);
}, ENV, W));

// ---------- F-7 ----------
test('F-7: bookingId = b + hex 24 ตัว (12 ไบต์) และ id รูปแบบเก่า (16 ตัว) ยังใช้กับ leave/DELETE ได้ (ตรวจรูปแบบรับถึง 64)', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const r = await post(s, a, good());
  assert.equal(r.status, 201); assert.match(r.body.booking.id, /^b[0-9a-f]{24}$/);
  const old = await s.call('POST', '/api/bookings/b0123456789abcdef/leave', { token: a.token }); assert.equal(old.status, 404);   // รูปแบบผ่าน ไม่พบ
}, ENV, W));


// ---------- F-2 ----------
const CARD = '4111111111111111';
const put = (s, u, body) => s.call('PUT', '/api/me', { token: u.token, body });
// สแกนทุกสตริงที่ผู้ใช้ควบคุมได้ซึ่งถูกเขียนเข้า mock (ไม่นับ id ที่เซิร์ฟเวอร์สุ่ม/ตัวเลขเวลา)
const USER_TEXT = new Set(['label', 'brand', 'car', 'plate', 'name', 'pm', 'reason', 'last4']);
const scan = (o, hits = [], key = '') => {
  if (typeof o === 'string') { if (USER_TEXT.has(key) && longDigits(o)) hits.push(key + '=' + o); }
  else if (Array.isArray(o)) o.forEach(x => scan(x, hits, key));
  else if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) scan(x, hits, k);
  return hits;
};
const scanMock = s => { const hits = [];
  for (const m of s.mock.st.attrs.values()) scan(m, hits);
  scan(s.mock.st.assetAttrs, hits); for (const w of s.mock.st.wr) scan(w.body || w.value || w, hits);
  return hits; };

test('F-2: เลข 16 หลักใน pays.id / cars.label / name / pm ถูกปฏิเสธหรือถูกแทนที่ ไม่ถูกเขียนลง mock', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev');
  const w0 = wr(s);
  for (const body of [
    { cars: [{ plate: 'กข1234', label: CARD }] }, { cars: [{ plate: 'กข1234', label: '4111 1111 1111 1111' }] }, { cars: [{ plate: 'กข1234', label: '4111-1111-1111-1111' }] },
    { name: CARD }, { name: 'สมชาย 4111 1111 1111 1111' },
    { pays: [{ label: CARD, brand: 'visa', last4: '4242' }] }, { pays: [{ label: 'x', brand: CARD, last4: '4242' }] },
  ]) { const r = await put(s, a, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(code(r), 'BAD_INPUT'); }
  assert.equal(wr(s), w0, 'ไม่เขียนอะไรเมื่อถูกปฏิเสธ');
  // id ที่ client ส่งมาและไม่เคยมี = เซิร์ฟเวอร์สร้างใหม่ (ไม่เก็บเลข 16 หลัก)
  const r = await put(s, a, { pays: [{ id: CARD, label: 'เดโม', brand: 'visa', last4: '4242' }, { id: 'evil-id', label: 'เดโม2', brand: 'visa', last4: '1111' }] });
  assert.equal(r.status, 200); const ids = r.body.pays.map(p => p.id);
  assert.ok(!ids.includes(CARD) && !ids.includes('evil-id')); assert.ok(ids.every(x => /^[0-9a-f]{12}$/.test(x))); assert.equal(new Set(ids).size, 2);
  assert.equal((await put(s, a, { pays: [{ id: 5, label: 'x', brand: 'v', last4: '4242' }] })).status, 400);
  // id เดิมของตัวเองส่งกลับมาได้ (คงเดิม) ใช้เป็น pm ได้
  const keep = await put(s, a, { pays: [{ id: ids[1], label: 'เดโม2', brand: 'visa', last4: '1111' }, { label: 'ใหม่', brand: 'visa', last4: '2222' }] });
  assert.equal(keep.status, 200); assert.equal(keep.body.pays[0].id, ids[1]); assert.notEqual(keep.body.pays[1].id, ids[1]);
  // จองด้วย pm เลข 16 หลัก = 400 (BAD_INPUT) ไม่ใช่ 201 เหมือน PROBE-C
  const w1 = wr(s);
  const bad = await post(s, a, good({ pm: CARD })); assert.equal(bad.status, 400); assert.equal(code(bad), 'BAD_INPUT'); assert.equal(wr(s), w1);
  assert.equal(code(await post(s, a, good({ pm: 'unknown-id' }))), 'PAY_UNKNOWN');
  assert.equal((await post(s, a, good({ pm: keep.body.pays[0].id }))).status, 201);
  // สมัครด้วยชื่อเป็นเลขบัตร = 400
  const su = await s.call('POST', '/api/signup', { body: { email: 'z@t.dev', password: 'Passw0rd!x', name: CARD } }); assert.equal(su.status, 400);
}, { ...ENV, PUT_RATE_MAX: '1000' }, W));

test('F-2: เลขยาวใน reason ของ staff ถูกปฏิเสธ และสแกนทุกสตริงของผู้ใช้ที่เขียนเข้า mock ตลอดวงจร (จอง/ยกเลิก) ไม่พบเลขยาว', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const st = await staffUser(s, 'st@t.dev');
  await put(s, a, { name: 'สมชาย', cars: [{ plate: 'กข1234', label: 'รถเรา' }], pays: [{ label: 'บัตร', brand: 'card', last4: '4242' }] });
  const pid = (await s.call('GET', '/api/me', { token: a.token })).body.pays[0].id;
  const b = (await post(s, a, good({ pm: pid }))); assert.equal(b.status, 201);
  assert.equal((await del(s, st, b.body.booking.id, { reason: 'คืน ' + CARD })).status, 400);
  assert.equal((await del(s, st, b.body.booking.id, { reason: 'ปิดซ่อม' })).status, 200);
  assert.deepEqual(scanMock(s), []);
  assert.ok(scanMock({ mock: { st: { attrs: new Map([['x', { pays: [{ id: CARD }], car: CARD }]]), assetAttrs: {}, wr: [] } } }).length > 0, 'ตัวสแกนจับของจริงได้');
}, ENV, W));

// ---------- F-3 (PROBE-B) ----------
const MIN = 60000;
const lifeT = (fn, env = {}) => async () => {
  const clock = { t: Date.now() };
  await run(async s => { seed(s); s.mock.setTel({ hb: 1 }, clock.t); await fn(s, clock); }, { ...ENV, ...env }, { writesEnabled: true, now: () => clock.t })();
};
const tick = (s, clock, ms, tel = {}) => { clock.t += ms; s.mock.setTel({ hb: 1, ...tel }, clock.t); };
const settle = async s => { for (let n = 0; n < 3; n++) { await sleep(15); await s.routes.bookings.idle(2000); } };
const mine = async (s, u) => { const r = await s.call('GET', '/api/me/bookings', { token: u.token }); assert.equal(r.status, 200, r.raw); await settle(s); return (await s.call('GET', '/api/me/bookings', { token: u.token })).body; };

test('F-3: ปลอม books เป็น done/park:0 หลังรถมาถึง ตัวซ่อม R2 ไม่ปล่อย bk_ และไม่หลบค่าจอด; ค่าจอดคิดจากเซิร์ฟเวอร์ตอนรถออก', lifeT(async (s, clock) => {
  const a = await user(s, 'a@t.dev'); const bkd = (await post(s, a, good())).body.booking;
  tick(s, clock, 1000, { 'slot_1-1': true }); await mine(s, a);                      // มาถึง
  tick(s, clock, 100 * MIN, { 'slot_1-1': true }); await mine(s, a);                 // จอดมา 100 นาที
  const entry = s.mock.st.assetAttrs['bk_1-1'][0]; assert.ok(entry.arr);
  // ผู้ใช้ปลอม books ตรง ๆ (ถ้า P10d = 200): done, out = ตอนนี้, park 0
  const mine0 = s.mock.st.attrs.get(a.uid).books[0];
  s.mock.st.attrs.set(a.uid, { ...s.mock.st.attrs.get(a.uid), books: [{ ...mine0, status: 'done', out: clock.t, min: 1, park: 0 }] });
  tick(s, clock, 61000, { 'slot_1-1': true }); await mine(s, a); await mine(s, a);   // เกินรอบตรวจซ้ำ 60 วิ
  assert.equal(s.mock.st.assetAttrs['bk_1-1'].length, 1, 'bk_ ยังอยู่ ไม่ถูกปล่อยตาม books');
  const bo = s.mock.st.attrs.get(a.uid).books.find(b => b.id === bkd.id);
  assert.equal(bo.status, 'active', 'สำเนาใน books ถูกสร้างใหม่จาก bk_'); assert.equal(bo.arr, entry.arr); assert.equal(bo.park, undefined);
  assert.equal(code(await post(s, (await user(s, 'b@t.dev', ['ขค99'])), good({ car: 'ขค99' }))), 'SLOT_TAKEN');
  // รถออกจริง: ค่าจอดคิดจากเซิร์ฟเวอร์ (> 0 เพราะเกิน 30 นาทีฟรี)
  tick(s, clock, 1000, { 'slot_1-1': false }); await mine(s, a); tick(s, clock, 15000, { 'slot_1-1': false });
  const m = await mine(s, a); const done = m.books.find(b => b.id === bkd.id);
  assert.equal(done.status, 'done'); assert.ok(done.park > 0, 'ค่าจอดไม่เป็น 0'); assert.deepEqual(s.mock.st.assetAttrs['bk_1-1'], []);
  assert.equal(m.rcp.filter(r => r.kind === 'park').length, 1);
  // ซ้ำผลเท่าเดิม
  const snap = JSON.stringify(s.mock.st.attrs.get(a.uid)); await mine(s, a); assert.equal(JSON.stringify(s.mock.st.attrs.get(a.uid)), snap);
}));

test('F-3: ปลอม books เป็น cancelled/noshow เมื่อ "ยังไม่มาถึง" ยังปล่อยช่องได้ (ไม่มีค่าจอดให้หลบ) แต่เมื่อมี arr ไม่ปล่อยทุกสถานะ', lifeT(async (s, clock) => {
  const a = await user(s, 'a@t.dev', ['กข1', 'กข2', 'กข3']);
  const x = (await post(s, a, good({ i: 1, car: 'กข1' }))).body.booking, y = (await post(s, a, good({ i: 2, car: 'กข2' }))).body.booking;
  tick(s, clock, 1000, { 'slot_1-2': true }); await mine(s, a);                      // y มาถึง
  tick(s, clock, 130000, { 'slot_1-2': true });                                      // อายุเกิน 120 วิ ตัวซ่อมแตะได้
  const bs = s.mock.st.attrs.get(a.uid).books;
  s.mock.st.attrs.set(a.uid, { ...s.mock.st.attrs.get(a.uid), books: bs.map(b => ({ ...b, status: b.id === x.id ? 'cancelled' : 'noshow', out: clock.t })) });
  await mine(s, a); await mine(s, a);
  assert.equal(s.mock.st.assetAttrs['bk_1-2'].length, 1, 'มี arr = ไม่ปล่อย'); assert.equal(s.mock.st.attrs.get(a.uid).books.find(b => b.id === y.id).status, 'active');
  assert.deepEqual(s.mock.st.assetAttrs['bk_1-1'], [], 'ยังไม่มาถึง = ปล่อยได้ ไม่มีค่าจอดให้หลบ');
}, { BOOK_SWEEP_DELAY_MS: '0' }));

// ---------- F-4 ----------
test('F-4: GET /api/me, /api/me/bookings, เปิด SSE เกิน 30/นาที/uid = 429 + Retry-After (แยกชนิด, แยกผู้ใช้); ไม่กระทบการจอง', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev');
  for (let n = 0; n < 30; n++) assert.equal((await s.call('GET', '/api/me', { token: a.token })).status, 200);
  const r = await s.call('GET', '/api/me', { token: a.token }); assert.equal(r.status, 429); assert.equal(code(r), 'RATE_LIMIT'); assert.ok(r.headers.get('retry-after'));
  assert.equal((await s.call('GET', '/api/me', { token: b.token })).status, 200, 'อีกคนไม่โดน');
  for (let n = 0; n < 30; n++) assert.equal((await s.call('GET', '/api/me/bookings', { token: a.token })).status, 200);
  assert.equal(code(await s.call('GET', '/api/me/bookings', { token: a.token })), 'RATE_LIMIT');
  assert.equal((await post(s, a, good())).status, 201, 'จองยังทำได้');
  for (let n = 0; n < 30; n++) { const c = await s.sse(a.token); assert.equal(c.status, 200); c.close(); }
  const over = await s.sse(a.token); assert.equal(over.status, 429); assert.equal(over.body.error.code, 'RATE_LIMIT');
}, { ...ENV, LIVE_MAX_PER_USER: '100' }, W));

test('F-4: งบ ThingsBoard รวมเกิน = การอ่านของผู้ใช้ได้ 503 BUSY + Retry-After แต่จอง/ยกเลิกยังผ่าน', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), st = await staffUser(s, 'st@t.dev');
  const b1 = (await post(s, a, good())).body.booking;        // งบ 1 คำขอ/นาที เกินไปแล้ว
  for (const r of [await s.call('GET', '/api/me', { token: a.token }), await s.call('GET', '/api/me/bookings', { token: a.token }), await s.sse(a.token).then(c => ({ status: c.status, body: c.body, headers: c.headers }))]) {
    assert.equal(r.status, 503); assert.equal(code(r), 'BUSY'); assert.ok(r.headers.get('retry-after'));
  }
  assert.equal((await post(s, a, good({ i: 2, car: 'กข1234' }))).status, 409, 'การจองยังถูกประมวลผล (ไม่ถูกตัดงบ)');
  const c = await del(s, st, b1.id); assert.equal(c.status, 200);
}, { ...ENV, TB_BUDGET: '1' }, W));

// ---------- CORS expose Retry-After ----------
test('CORS: ทุกคำตอบข้าม origin มี Access-Control-Expose-Headers: Retry-After (429, 503, preflight, ผลสำเร็จ); origin แปลกไม่ได้', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const { WEB } = require('./harness'); const h = { Origin: WEB };
  const ok = await s.call('GET', '/api/me', { token: a.token, headers: h }); assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-expose-headers'), 'Retry-After');
  const pre = await s.call('OPTIONS', '/api/me', { headers: h }); assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-expose-headers'), 'Retry-After');
  for (let n = 0; n < 30; n++) await s.call('GET', '/api/me', { token: a.token, headers: h });
  const lim = await s.call('GET', '/api/me', { token: a.token, headers: h }); assert.equal(lim.status, 429);
  assert.ok(lim.headers.get('retry-after')); assert.equal(lim.headers.get('access-control-expose-headers'), 'Retry-After');
  const bad = await s.call('GET', '/api/me', { token: a.token, headers: { Origin: 'https://evil.example' } }); assert.equal(bad.status, 403); assert.equal(bad.headers.get('access-control-expose-headers'), null);
}, ENV, W));
test('CORS: 503 BUSY (งบ TB) ข้าม origin ก็มี Retry-After และ Expose-Headers', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const { WEB } = require('./harness');
  const r = await s.call('GET', '/api/me', { token: a.token, headers: { Origin: WEB } }); assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '5'); assert.equal(r.headers.get('access-control-expose-headers'), 'Retry-After');
}, { ...ENV, TB_BUDGET: '1' }, W));

// ---------- N-3 ----------
test('N-3: longDigits ทนการเลี่ยง (ตัวคั่น . _ / , เว้นวรรคสองตัว ZWSP เลขเต็มความกว้าง เลขไทย อารบิกอินดิก ตัวอักษรคั่น) ไม่ปฏิเสธข้อความปกติ', () => {
  for (const x of ['4111.1111.1111.1111', '4111_1111_1111_1111', '4111/1111/1111/1111', '4111,1111,1111,1111', '4111  1111  1111  1111', '4111 - 1111 - 1111 - 1111', '4111​1111​1111​1111', '４１１１１１１１１１１１１１１１', '๔๑๑๑๑๑๑๑๑๑๑๑๑๑๑๑', '٤١١١١١١١١١١١١١١١', '4111a1111a1111a1111', CARD, '4111 1111 1111 1111'])
    assert.equal(longDigits(x), true, x);
  for (const x of ['กข1234', 'สมชาย ใจดี', 'รถเรา 2', '1234567890', '081-234-5678', 'ปิดซ่อมช่อง A2 วันที่ 18/11/2026 เวลา 10:30'])
    assert.equal(longDigits(x), false, x);
});

test('N-3: ฟิลด์ข้อความที่เลี่ยงด้วยตัวคั่นแปลก ๆ ถูกปฏิเสธ 400 ไม่เขียน; id บัตรซ้ำสองใบในรายการเดียว ได้ id คนละตัว', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const w0 = wr(s);
  for (const x of ['4111.1111.1111.1111', '４１１１１１１１１１１１１１１１', '๔๑๑๑๑๑๑๑๑๑๑๑๑๑๑๑', '4111a1111a1111a1111', '4111​1111​1111​1111']) {
    for (const body of [{ name: x }, { cars: [{ plate: 'กข1234', label: x }] }, { pays: [{ label: x, brand: 'v', last4: '4242' }] }, { pays: [{ label: 'x', brand: x, last4: '4242' }] }])
      assert.equal((await put(s, a, body)).status, 400, JSON.stringify(body));
    assert.equal(code(await post(s, a, good({ pm: x }))), 'BAD_INPUT');
  }
  assert.equal(wr(s), w0);
  const r1 = await put(s, a, { pays: [{ label: 'a', brand: 'v', last4: '1111' }] }); const id = r1.body.pays[0].id;
  const r2 = await put(s, a, { pays: [{ id, label: 'a', brand: 'v', last4: '1111' }, { id, label: 'b', brand: 'v', last4: '2222' }] });
  assert.equal(r2.status, 200); assert.equal(r2.body.pays[0].id, id); assert.notEqual(r2.body.pays[1].id, id); assert.equal(new Set(r2.body.pays.map(p => p.id)).size, 2);
}, { ...ENV, PUT_RATE_MAX: '1000' }, W));

// ---------- N-1 ----------
const { ipKey } = require('../lib');
const { createTb } = require('../tb');

test('N-1: ipKey: IPv4 เดิม, IPv4-mapped เป็น IPv4, IPv6 ทุกที่อยู่ใน /64 เดียวกันได้คีย์เดียว', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7'); assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  const k = ipKey('2001:db8:1:2::1');
  for (const x of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:DB8:1:2:0:0:0:9', '2001:db8:1:2:abcd::', '2001:db8:0001:0002::5']) assert.equal(ipKey(x), k, x);
  assert.notEqual(ipKey('2001:db8:1:3::1'), k); assert.notEqual(ipKey('2001:db8:2:2::1'), k);
  assert.equal(ipKey('::1'), '0:0:0:0::/64'); assert.equal(ipKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(ipKey('junk::::x'), 'junk::::x'); assert.equal(ipKey('?'), '?');
});

test('N-1: คำขอที่ TB ตอบ 401 ไม่นับเข้างบ TB (load) แต่ 200/500/ล้มเหลวเครือข่ายนับ', async () => {
  const mk = status => async () => ({ status, ok: status < 400, text: async () => '{}' });
  const cfg = { tbHost: 'http://x', tbTimeoutMs: 1000, tbApiKey: 'k' };
  const t401 = createTb(cfg, mk(401)); for (let n = 0; n < 50; n++) await t401.anon('/x'); assert.equal(t401.load(), 0);
  const t200 = createTb(cfg, mk(200)); for (let n = 0; n < 5; n++) await t200.anon('/x'); assert.equal(t200.load(), 5);
  const t500 = createTb(cfg, mk(500)); await t500.anon('/x'); assert.equal(t500.load(), 1);
  const tErr = createTb(cfg, async () => { throw new Error('down'); }); await assert.rejects(tErr.anon('/x')); assert.equal(tErr.load(), 1);
  const realNow = Date.now; try { const t0 = realNow(); Date.now = () => t0; await t200.anon('/x'); Date.now = () => t0 + 61000; await t200.anon('/x'); assert.equal(t200.load(), 1, 'ของเก่าเกิน 60 วิถูกตัดตอน push'); } finally { Date.now = realNow; }
});

test('N-1: ยิง JWT ปลอม 600 ครั้งจากหลาย IP แล้วผู้ใช้จริงต้องไม่ได้ 503; เพดานโทเคนถูกปฏิเสธต่อ IP = 20/นาที (เกินแล้วไม่ยิง TB)', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev');
  const forged = n => s.mock.makeToken('forged' + n, 900);
  const c0 = s.mock.st.authUserCalls; let n = 0, ok401 = 0, limited = 0;
  for (let ipn = 1; ipn <= 10; ipn++) for (let k = 0; k < 60; k++, n++) {
    const r = await s.call('GET', '/api/lot', { token: forged(n), headers: { 'X-Forwarded-For': '198.51.100.' + ipn } });
    if (r.status === 401) ok401++; else { assert.equal(r.status, 429); assert.equal(code(r), 'RATE_LIMIT'); assert.ok(r.headers.get('retry-after')); limited++; }
  }
  assert.equal(n, 600); assert.equal(ok401, 200, 'IP ละ 20 ครั้งถึง TB'); assert.equal(limited, 400);
  assert.equal(s.mock.st.authUserCalls - c0, 200);
  // งบ TB (50 ในเทสต์นี้) ไม่ถูกกินโดยคำขอที่ได้ 401: ผู้ใช้จริงอ่านได้
  for (const p of ['/api/me', '/api/me/bookings']) assert.equal((await s.call('GET', p, { token: a.token })).status, 200, p);
  const c = await s.sse(a.token); assert.equal(c.status, 200); c.close();
  // IP ที่เต็มแล้ว: โทเคนจริงของผู้ใช้ที่อยู่ใน cache ยังใช้ได้ (ไม่ถาม TB) แต่โทเคนใหม่ที่ไม่เคยเห็นถูก 429
  assert.equal((await s.call('GET', '/api/lot', { token: a.token, headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 200);
}, { ...ENV, TB_BUDGET: '60', API_IP_LIMIT: '1000', LIVE_POLL_MS: '5000', LOT_ATTR_MS: '60000', LOT_CACHE_MS: '600000' }, W));

test('N-1: เพดาน IP ใช้ /64 ของ IPv6: หมุนที่อยู่ใน /64 เดียวกันไม่หลบเพดาน, /64 อื่นและ IPv4 ไม่ถูกกระทบ', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev');
  const get = ip => s.call('GET', '/healthz', { headers: { 'X-Forwarded-For': ip } });
  const lot = ip => s.call('GET', '/api/lot', { token: a.token, headers: { 'X-Forwarded-For': ip } });
  for (let n = 0; n < 5; n++) assert.equal((await lot('2001:db8:1:2:0:0:0:' + (n + 1).toString(16))).status, 200);
  const r = await lot('2001:db8:1:2:dead:beef::1'); assert.equal(r.status, 429); assert.equal(code(r), 'RATE_LIMIT');
  assert.equal((await lot('2001:db8:1:3::1')).status, 200, '/64 อื่นปกติ'); assert.equal((await lot('203.0.113.9')).status, 200);
  assert.equal((await lot('::ffff:203.0.113.9')).status, 200); void get;
}, { ...ENV, API_IP_LIMIT: '5' }, W));

test('N-1: limiter ทุกตัวใช้คีย์ /64: โทเคนที่ TB ปฏิเสธ (badTok) และ forgot ต่อ IP หมุนที่อยู่ใน /64 เดียวกันไม่หลบ', run(async s => {
  seed(s);
  // badTok: 20/นาที/IP ผ่าน X-Forwarded-For IPv6 หมุนทุกคำขอ (ทั้งหมดอยู่ใน /64 เดียว)
  const c0 = s.mock.st.authUserCalls; let lim = 0, bad = 0;
  for (let n = 0; n < 60; n++) {
    const r = await s.call('GET', '/api/lot', { token: s.mock.makeToken('v6forged' + n, 900), headers: { 'X-Forwarded-For': '2001:db8:9:9:' + (n + 1).toString(16) + '::' + (n + 7).toString(16) } });
    if (r.status === 401) bad++; else { assert.equal(r.status, 429); lim++; }
  }
  assert.equal(bad, 20); assert.equal(lim, 40); assert.equal(s.mock.st.authUserCalls - c0, 20, 'เกิน 20 ไม่ถึง TB');
  // /64 อื่นยังถึง TB ได้ตามปกติ
  assert.equal((await s.call('GET', '/api/lot', { token: s.mock.makeToken('other', 900), headers: { 'X-Forwarded-For': '2001:db8:9:a::1' } })).status, 401);
  // forgot: 5/นาที/IP หมุนที่อยู่ใน /64 เดียว ครั้งที่ 6 = 429; IPv4 ไม่ถูกกระทบ
  const fg = ip => s.call('POST', '/api/forgot', { body: { email: 'x@t.dev' }, headers: { 'X-Forwarded-For': ip } });
  for (let n = 1; n <= 5; n++) assert.equal((await fg('2001:db8:7:7:' + n.toString(16) + '::1')).status, 200);
  const r6 = await fg('2001:db8:7:7:ffff::2'); assert.equal(r6.status, 429); assert.equal(code(r6), 'RATE_LIMIT');
  assert.equal((await fg('203.0.113.50')).status, 200);
}, { ...ENV, API_IP_LIMIT: '1000' }, W));

// ---------- N-2 ----------
test('N-2: PUT /api/me เกิน 10/นาที/uid = 429 + Retry-After; PUT ที่รูปร่างผิดไม่ถึง ThingsBoard เลย; ผู้ใช้อื่นไม่โดน', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev');   // user() ใช้ PUT ไปแล้ว 1 ครั้ง
  const c0 = s.mock.st.calls.length;
  for (const body of [{ pays: [{ label: 'x', brand: 'v', last4: 'zz' }] }, { pays: 'x' }, { pays: [{ label: 'x', brand: 'v', last4: '1111', number: CARD }] }, { pays: [{ label: CARD, brand: 'v', last4: '1111' }] }])
    assert.equal((await put(s, a, body)).status, 400);
  assert.equal(s.mock.st.calls.length, c0, 'ผิดรูป = ไม่เรียก ThingsBoard');
  for (let n = 0; n < 5; n++) assert.equal((await put(s, a, { name: 'ชื่อ' + n })).status, 200);
  const r = await put(s, a, { name: 'เกิน' }); assert.equal(r.status, 429); assert.equal(code(r), 'RATE_LIMIT'); assert.ok(r.headers.get('retry-after'));
  assert.equal((await put(s, b, { name: 'อีกคน' })).status, 200);
  assert.equal((await s.call('GET', '/api/me', { token: a.token })).body.name, 'ชื่อ4', 'คำขอที่ถูกปฏิเสธไม่เขียน');
}, ENV, W));

// ---------- N-4 ----------
test('N-4: ถอดสิทธิ์ staff ระหว่างรอคิว mutex แล้วยกเลิกไม่รอด = 403 ไม่เขียน (ตรวจซ้ำในล็อก); staff ที่ยังมีสิทธิ์ผ่านปกติ', run(async s => {
  const { until } = require('./harness');
  seed(s); const a = await user(s, 'a@t.dev'); const st = await staffUser(s, 'st@t.dev');
  const b1 = (await post(s, a, good())).body.booking;
  await s.call('GET', '/api/me', { token: st.token });
  const mx = s.routes.bookings.mutex; let release; const gate = new Promise(r => (release = r));
  const holder = mx.run(() => gate);                                              // ถือล็อกไว้
  const w0 = wr(s);
  const pending = del(s, st, b1.id);                                              // ผ่านตรวจ role จาก cache แล้วเข้าคิวรอ
  await until(() => mx.stats().waiting === 1);
  s.mock.st.users.get(st.uid).customerId = { id: MEMBERS };                       // ถอดสิทธิ์ระหว่างรอ
  release(); await holder;
  const r = await pending; assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN');
  assert.equal(wr(s), w0, 'ไม่เขียนอะไร'); assert.equal(s.mock.st.assetAttrs['bk_1-1'].length, 1);
  // ยังมีสิทธิ์ = ผ่าน
  const st2 = await staffUser(s, 'st2@t.dev'); await s.call('GET', '/api/me', { token: st2.token });
  const ok = await del(s, st2, b1.id); assert.equal(ok.status, 200); assert.equal(ok.body.booking.status, 'cancelled');
}, ENV, W));

// ---------- leave ก่อนรถมาถึง (เหมือนเว็บเดิม finish()) ----------
const P = require('../pricing');
test('leave ก่อน arr: ภายใน freemin = ฟรี (ไม่มีใบเสร็จ) ไม่คืนค่าจอง ปล่อยช่อง; ซ้ำได้ผลเดิม; ไม่มี NOT_ARRIVED', lifeT(async (s, clock) => {
  const a = await user(s, 'a@t.dev'); const b0 = (await post(s, a, good())).body.booking;
  tick(s, clock, 10 * MIN);                                                       // ยังไม่มีรถ (occ:false) นาทีที่ 10
  const L = () => s.call('POST', '/api/bookings/' + b0.id + '/leave', { token: a.token, body: {} });
  const w0 = wr(s); const r = await L(); assert.equal(r.status, 200, r.raw);
  const bo = r.body.booking; assert.equal(bo.status, 'done'); assert.equal(bo.out, clock.t); assert.equal(bo.min, 10); assert.equal(bo.park, 0);
  assert.equal(r.body.receipt, null); assert.equal(wr(s) - w0, 2); assert.deepEqual(s.mock.st.assetAttrs['bk_1-1'], []);
  const m = await mine(s, a); assert.ok(!m.rcp.some(x => x.kind === 'refund'), 'ไม่คืนค่าจอง'); assert.equal(m.rcp.filter(x => x.kind === 'book').length, 1);
  const w1 = wr(s); const r2 = await L(); assert.equal(r2.status, 200); assert.equal(r2.body.booking.out, bo.out); assert.equal(wr(s), w1);
  assert.equal((await post(s, a, good())).status, 201, 'ช่องว่างจองใหม่ได้');
}));

test('leave ก่อน arr: เกิน freemin = มีค่าจอด สูตรเดียวกับเว็บเดิม (นาทีนับจากเริ่มจอง ปัดขึ้น ขั้นต่ำ 1, ราคา(max(0, นาที-30))) ยอดตรง pricing/golden; offline (occ:null) ก็ออกได้; เจ้าของเท่านั้น', lifeT(async (s, clock) => {
  const a = await user(s, 'a@t.dev', ['กข1', 'กข2', 'กข3']), b = await user(s, 'b@t.dev', ['ขค9']);
  const cfg = { rate: 20, freemin: 30 };
  const run1 = async (i, car, plus, off) => {
    const bk0 = (await post(s, a, good({ i, car }))).body.booking;
    if (off) clock.t += plus; else tick(s, clock, plus);                          // off = บอร์ดหลุด ไม่ต่อ hb
    return s.call('POST', '/api/bookings/' + bk0.id + '/leave', { token: a.token, body: {} }).then(r => ({ r, bk0 }));
  };
  // 30 นาทีพอดี = ยังฟรี (min 30), 30 นาที 1 มิลลิวินาที = นาทีที่ 31 -> 1 นาทีที่คิดเงิน
  let { r, bk0 } = await run1(1, 'กข1', 30 * MIN); assert.equal(r.body.booking.min, 30); assert.equal(r.body.booking.park, 0); assert.equal(r.body.receipt, null);
  ({ r, bk0 } = await run1(2, 'กข2', 45 * MIN + 1));                              // 46 นาที (ปัดขึ้น) -> 16 นาทีที่คิดเงิน
  assert.equal(r.status, 200); const bo = r.body.booking;
  assert.equal(bo.min, 46); assert.equal(bo.park, P.parkFee(cfg, bo.s, bo.out)); assert.equal(bo.park, Math.ceil(16 / 60 * 20)); assert.equal(bo.park, 6);
  assert.equal(r.body.receipt.kind, 'park'); assert.equal(r.body.receipt.amt, 6); assert.equal(r.body.receipt.min, 46);
  assert.equal(P.price(cfg, 16), 6);
  assert.equal((await mine(s, a)).rcp.filter(x => x.kind === 'park' && x.bid === bo.id).length, 1); assert.deepEqual(s.mock.st.assetAttrs['bk_1-2'], []);
  ({ r, bk0 } = await run1(3, 'กข3', 35 * MIN, true));                           // บอร์ดหลุด occ:null ก่อนมี arr ก็ออกได้
  assert.equal(r.status, 200); assert.equal(r.body.booking.park, Math.ceil(5 / 60 * 20)); assert.equal(r.body.booking.min, 35);
  // คนอื่นออกแทนไม่ได้ (404 เหมือน id ปลอม)
  tick(s, clock, 1000); const mine1 = (await post(s, a, good({ i: 4, car: 'กข1' }))).body.booking;
  const x = await s.call('POST', '/api/bookings/' + mine1.id + '/leave', { token: b.token, body: {} }); assert.equal(x.status, 404); assert.equal(code(x), 'NOT_FOUND');
  assert.equal(s.mock.st.assetAttrs['bk_1-4'].length, 1);
}));
