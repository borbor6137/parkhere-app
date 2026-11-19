// M5 B2: GET /api/admin/bookings บน mock-tb เท่านั้น (AC-M5-1 ส่วนอ่าน, 10, 11, 12, 14, 15 ส่วน API)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run, STAFF, MEMBERS } = require('./harness');
const P = require('../pricing');

const ENV = { BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0', BARRIER_COOLDOWN_MS: '0', ADMIN_WRITE_RATE_MAX: '1000', ADMIN_LIST_RATE_MAX: '1000', ADMIN_LIST_CACHE_MS: '0', LEAVE_RATE_MAX: '1000' };
const W = { writesEnabled: true };
const code = r => r.body && r.body.error && r.body.error.code;
const rid = () => 'req-' + crypto.randomUUID();
const CFG = { floors: 2, slots: 8, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 };
const seed = s => {
  s.mock.setAttr('config', CFG);
  const t = { hb: 1 }; for (let f = 1; f <= 2; f++) for (let i = 0; i < 8; i++) t[`slot_${f}-${i}`] = false;
  s.mock.setTel(t, Date.now());
};
const staffOf = async (s, email = 'staff@t.dev') => { const st = await s.member(email); s.mock.st.users.get(st.uid).customerId = { id: STAFF }; return st; };
const carUser = async (s, email, plate) => { const u = await s.member(email); assert.equal((await s.call('PUT', '/api/me', { token: u.token, body: { cars: [{ plate }] } })).status, 200); u.email = email; u.plate = plate; return u; };
const book = async (s, u, f, i) => { const r = await s.call('POST', '/api/bookings', { token: u.token, body: { f, i, car: u.plate, pm: 'pp', reqId: rid() } }); assert.equal(r.status, 201, r.raw); return r.body.booking; };
const list = (s, u, q = '') => s.call('GET', '/api/admin/bookings' + q, { token: u.token });
const KEYS = ['amt', 'by', 'car', 'e', 'f', 'i', 'id', 'out', 'ownerName', 'park', 'reason', 's', 'stale', 'status'];

// u1: active 1-1 + cancelled โดย staff 1-3 ; u2: done 1-2 (ออกเอง) + active 2-0
async function world(s) {
  seed(s);
  const st = await staffOf(s), u1 = await carUser(s, 'one@t.dev', 'กข1111'), u2 = await carUser(s, 'two@t.dev', 'กข2222');
  const done = await book(s, u2, 1, 2);
  const lv = await s.call('POST', `/api/bookings/${done.id}/leave`, { token: u2.token }); assert.equal(lv.status, 200, lv.raw);
  const canc = await book(s, u1, 1, 3);
  const cn = await s.call('DELETE', `/api/bookings/${canc.id}`, { token: st.token, body: { reason: 'ทดสอบยกเลิก' } }); assert.equal(cn.status, 200, cn.raw);
  const a1 = await book(s, u1, 1, 1), a2 = await book(s, u2, 2, 0);
  return { st, u1, u2, done, canc, a1, a2 };
}

test('AC-M5-1 member = 403 FORBIDDEN ไบต์เดียวกันทุกกรณี (แม้ query ผิด) ก่อนค้นข้อมูล mock ไม่ถูกถามรายชื่อผู้ใช้; ไม่มีโทเคน = 401', run(async s => {
  seed(s); const a = await s.member('a@t.dev');
  const outs = [];
  for (const q of ['', '?status=zzz', '?limit=0', '?x=1', '?q=' + 'ก'.repeat(99)]) { const r = await list(s, a, q); assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN'); outs.push(r.raw); }
  assert.equal(new Set(outs).size, 1); assert.ok(!s.mock.st.userListCalls);
  assert.equal((await s.call('GET', '/api/admin/bookings')).status, 401);
  assert.equal((await s.call('POST', '/api/admin/bookings', { token: a.token, body: {} })).status, 405);
}, ENV, W));

test('AC-M5-2 ถอดสิทธิ์ staff แล้วอ่านรายการไม่ได้ทันที (authFresh ไม่ใช้ cache 60 วิ)', run(async s => {
  seed(s); const st = await staffOf(s);
  assert.equal((await list(s, st)).status, 200);
  s.mock.st.users.get(st.uid).customerId = { id: MEMBERS };
  const r = await list(s, st); assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN');
}, ENV, W));

test('AC-M5-10 รายการจองทั้งระบบ: ทุกรายการ ใหม่สุดก่อน กรอง status/f/q/limit; ฟิลด์ตาม allowlist; ไม่มีอีเมล uid rq pays ยอดรวม', run(async s => {
  const w = await world(s);
  const r = await list(s, w.st); assert.equal(r.status, 200, r.raw);
  const b = r.body; assert.equal(typeof b.serverNow, 'number'); assert.equal(b.total, 4); assert.equal(b.truncated, false); assert.equal(b.bookings.length, 4);
  assert.deepEqual(b.bookings.map(x => x.id), [w.a2.id, w.a1.id, w.canc.id, w.done.id], 'ใหม่สุดก่อน (ตามเวลาเริ่มจอง)');
  const by = Object.fromEntries(b.bookings.map(x => [x.id, x]));
  assert.deepEqual([by[w.a1.id].status, by[w.a1.id].f, by[w.a1.id].i, by[w.a1.id].car, by[w.a1.id].amt, by[w.a1.id].ownerName], ['active', 1, 1, 'กข1111', 20, 'ทดสอบ']);
  assert.equal(by[w.canc.id].status, 'cancelled'); assert.equal(by[w.canc.id].by, 'admin'); assert.equal(by[w.canc.id].reason, 'ทดสอบยกเลิก');
  assert.equal(by[w.done.id].status, 'done'); assert.equal(typeof by[w.done.id].out, 'number'); assert.equal(by[w.done.id].park, 0);   // ออกภายใน freemin = ฟรี
  for (const x of b.bookings) { for (const k of Object.keys(x)) assert.ok(KEYS.includes(k), 'ฟิลด์นอก allowlist: ' + k); assert.equal(x.stale, undefined); }
  for (const secret of ['one@t.dev', 'two@t.dev', 'staff@t.dev', w.u1.uid, w.u2.uid, w.st.uid, '"rq"', '"rno"', '"pays"', '"uid"', '"pm"', 'password', w.u1.token.slice(0, 20)]) assert.ok(!r.raw.includes(secret), 'รั่ว: ' + secret);
  assert.ok(!/total(Amount|Revenue|Income)|sum|revenue|รายได้/i.test(Object.keys(b).join(',')), 'ต้องไม่มียอดรวมรายได้');
  // กรอง
  let x = await list(s, w.st, '?status=active'); assert.deepEqual(x.body.bookings.map(y => y.id).sort(), [w.a1.id, w.a2.id].sort());
  x = await list(s, w.st, '?status=cancelled'); assert.deepEqual(x.body.bookings.map(y => y.id), [w.canc.id]);
  x = await list(s, w.st, '?f=2'); assert.deepEqual(x.body.bookings.map(y => y.id), [w.a2.id]);
  x = await list(s, w.st, '?q=1111'); assert.deepEqual(x.body.bookings.map(y => y.id).sort(), [w.a1.id, w.canc.id].sort());
  x = await list(s, w.st, '?q=' + encodeURIComponent('กข 2222')); assert.equal(x.body.total, 2);
  x = await list(s, w.st, '?q=' + encodeURIComponent('ทด')); assert.equal(x.body.total, 4, 'ค้นด้วยชื่อเจ้าของ');
  x = await list(s, w.st, '?limit=2'); assert.equal(x.body.bookings.length, 2); assert.equal(x.body.total, 4); assert.equal(x.body.truncated, true);
  x = await list(s, w.st, '?status=active&f=1&q=1111&limit=5'); assert.deepEqual(x.body.bookings.map(y => y.id), [w.a1.id]);
  x = await list(s, w.st, '?status=noshow'); assert.equal(x.body.total, 0);
}, ENV, W));

test('AC-M5-10 master ดูได้; ค่าเริ่มต้น limit 100, สูงสุด 200', run(async s => {
  seed(s); const m = await s.member('m@t.dev'); s.mock.st.users.get(m.uid).authority = 'TENANT_ADMIN';
  const u = await carUser(s, 'u@t.dev', 'กข3333');
  // books 120 รายการ (ประวัติ) สร้างตรงใน mock
  const mk = n => ({ id: 'bh' + n, f: 1, i: 0, car: 'กข3333', s: 1000 + n, e: 5000000 + n, status: 'done', amt: 20, pm: 'pp', out: 2000 + n, min: 1, park: 0, rno: 'PH' + String(10000000 + n) });
  s.mock.st.attrs.set(u.uid, { ...(s.mock.st.attrs.get(u.uid) || {}), books: Array.from({ length: 60 }, (_, n) => mk(n)) });
  let r = await list(s, m); assert.equal(r.status, 200); assert.equal(r.body.bookings.length, 60); assert.equal(r.body.bookings[0].id, 'bh59');
  for (const q of ['?limit=201', '?limit=0', '?limit=-1', '?limit=1.5', '?limit=abc', '?limit=']) assert.equal((await list(s, m, q)).status, 400, q);
}, ENV, W));

test('AC-M5-10 query ผิดรูป = 400 BAD_INPUT ไม่เป็น 500; ส่งซ้ำ/ช่องเกิน/คำค้นยาวหรือมีอักขระควบคุม', run(async s => {
  seed(s); const st = await staffOf(s);
  for (const q of ['?status=zzz', '?status=', '?status=active&status=done', '?f=0', '?f=abc', '?f=100', '?f=1.5', '?x=1', '?role=staff', '?q=', '?q=%20', '?q=' + 'a'.repeat(31), '?q=%00', '?limit=999', '?uid=x']) {
    const r = await list(s, st, q); assert.equal(r.status, 400, q + ' -> ' + r.status); assert.equal(code(r), 'BAD_INPUT');
  }
  assert.ok(!s.mock.st.userListCalls, 'query ผิดไม่ถึง ThingsBoard');
}, ENV, W));

test('AC-M5-11 bk_ ชนะ books: books ล้าหลัง/ขัดกัน -> แถวตาม bk_ + stale:true; books active แต่ bk_ ไม่มี = void + stale; staleCount', run(async s => {
  const w = await world(s);
  // (1) books ของ a1 บอกว่า done ทั้งที่ bk_ ยัง active
  const bs1 = s.mock.st.attrs.get(w.u1.uid).books.map(b => (b.id === w.a1.id ? { ...b, status: 'done', out: b.s + 1000, min: 1, park: 0 } : b));
  s.mock.st.attrs.set(w.u1.uid, { ...s.mock.st.attrs.get(w.u1.uid), books: bs1 });
  // (2) books ของ a2 ไม่มีรายการนั้นเลย (ล้าหลัง)
  s.mock.st.attrs.set(w.u2.uid, { ...s.mock.st.attrs.get(w.u2.uid), books: s.mock.st.attrs.get(w.u2.uid).books.filter(b => b.id !== w.a2.id) });
  // (3) books active แต่ bk_ ไม่มี
  const ghost = { id: 'bghost1', f: 1, i: 6, car: 'กข1111', s: Date.now() - 5000, e: Date.now() + 1e9, status: 'active', amt: 20, pm: 'pp', rno: 'PH12345678' };
  s.mock.st.attrs.set(w.u1.uid, { ...s.mock.st.attrs.get(w.u1.uid), books: [ghost, ...bs1] });
  const r = await list(s, w.st); assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.bookings.map(x => [x.id, x]));
  assert.deepEqual([by[w.a1.id].status, by[w.a1.id].stale], ['active', true]);
  assert.deepEqual([by[w.a2.id].status, by[w.a2.id].stale, by[w.a2.id].ownerName], ['active', true, 'ทดสอบ']);
  assert.deepEqual([by.bghost1.status, by.bghost1.stale], ['void', true]);
  assert.equal(by[w.done.id].stale, undefined); assert.equal(by[w.canc.id].stale, undefined);
  assert.equal(r.body.staleCount, 3);
  assert.equal(JSON.stringify(s.mock.st.assetAttrs['bk_1-1']).includes('"done"'), false, 'GET ไม่แก้ข้อมูล');
}, ENV, W));

test('AC-M5-11 ThingsBoard อ่านไม่ได้ = 502 UPSTREAM ไม่ตอบรายการว่างเงียบๆ (รายชื่อผู้ใช้ / attribute ลาน / telemetry)', run(async s => {
  const w = await world(s);
  s.mock.st.failUserList = 500; let r = await list(s, w.st); assert.equal(r.status, 502); assert.equal(code(r), 'UPSTREAM'); s.mock.st.failUserList = 0;
  s.mock.st.failAttr = 500; r = await list(s, w.st); assert.equal(r.status, 502); assert.equal(code(r), 'UPSTREAM'); s.mock.st.failAttr = 0;
  s.mock.st.failTel = 500; r = await list(s, w.st); assert.equal(r.status, 502); assert.equal(code(r), 'UPSTREAM'); s.mock.st.failTel = 0;
  r = await list(s, w.st); assert.equal(r.status, 200); assert.equal(r.body.total, 4);
}, ENV, W));

test('AC-M5-12 แคช 10 วิ: เรียกซ้ำไม่ถามผู้ใช้ซ้ำ; เกิน 12/นาที/uid = 429 RATE_LIMIT + Retry-After; ผู้ใช้อื่นไม่โดน', run(async s => {
  const w = await world(s); const m = await s.member('m@t.dev'); s.mock.st.users.get(m.uid).authority = 'TENANT_ADMIN';
  const l0 = s.mock.st.userListCalls || 0, a0 = s.mock.st.userAttrReads;
  for (let n = 0; n < 12; n++) { const r = await list(s, w.st); assert.equal(r.status, 200, 'n=' + n); }
  assert.equal(s.mock.st.userListCalls - l0, 2, 'ถามรายชื่อผู้ใช้รอบเดียว (Members + Staff)');
  assert.ok(s.mock.st.userAttrReads - a0 <= 5, 'อ่าน books รอบเดียว ' + (s.mock.st.userAttrReads - a0));
  const r = await list(s, w.st); assert.equal(r.status, 429); assert.equal(code(r), 'RATE_LIMIT'); assert.ok(+r.headers.get('retry-after') >= 1);
  assert.equal((await list(s, m)).status, 200);
}, { ...ENV, ADMIN_LIST_RATE_MAX: '12', ADMIN_LIST_CACHE_MS: '10000' }, W));

test('แคชถูกล้างเมื่อมีการยกเลิก/จบ/จอง: รายการเปลี่ยนทันที ไม่ค้าง 10 วิ', run(async s => {
  const w = await world(s);
  let r = await list(s, w.st); assert.equal(r.body.bookings.find(x => x.id === w.a1.id).status, 'active');
  const cn = await s.call('DELETE', `/api/bookings/${w.a1.id}`, { token: w.st.token, body: { reason: 'x' } }); assert.equal(cn.status, 200, cn.raw);
  r = await list(s, w.st); assert.deepEqual([r.body.bookings.find(x => x.id === w.a1.id).status, r.body.bookings.find(x => x.id === w.a1.id).by], ['cancelled', 'admin']);
  const nb = await book(s, w.u1, 1, 5);
  r = await list(s, w.st); assert.equal(r.body.bookings[0].id, nb.id);
}, { ...ENV, ADMIN_LIST_CACHE_MS: '10000' }, W));

test('AC-M5-14 staff ยกเลิกการจองของคนอื่น: 200 cancelled by admin เหตุผลตามที่ส่ง; member ยกเลิกของคนอื่น = 403 ไม่รั่ว', run(async s => {
  const w = await world(s);
  let r = await s.call('DELETE', `/api/bookings/${w.a2.id}`, { token: w.u1.token, body: {} }); assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN');
  r = await s.call('DELETE', `/api/bookings/nonexistent1`, { token: w.u1.token, body: {} }); assert.equal(r.status, 403, 'id ที่ไม่มีก็ 403 เหมือนกัน');
  r = await s.call('DELETE', `/api/bookings/${w.a2.id}`, { token: w.st.token, body: { reason: 'ซ่อมพื้น' } }); assert.equal(r.status, 200);
  assert.equal(r.body.booking.status, 'cancelled'); assert.equal(r.body.booking.by, 'admin'); assert.equal(r.body.booking.reason, 'ซ่อมพื้น'); assert.ok('barrier' in r.body, 'ชี้ผลไม้กั้นให้หน้า admin');
  const l = await list(s, w.st); assert.equal(l.body.bookings.find(x => x.id === w.a2.id).reason, 'ซ่อมพื้น');
}, ENV, W));

test('AC-M5-15 ยอดเงินจากฟังก์ชันเดียว: amt/park ตรงกันใน response จอง, /api/me/bookings, รายการ admin และ pricing.js หลังเปลี่ยน config', run(async s => {
  seed(s); const st = await staffOf(s), u = await carUser(s, 'u@t.dev', 'กข4444');
  assert.equal((await s.call('PUT', '/api/admin/config', { token: st.token, body: { rate: 36, bookfee: 45, freemin: 0 } })).status, 200);
  const b = await book(s, u, 1, 4); assert.equal(b.amt, P.bookFee({ bookfee: 45 })); assert.equal(b.amt, 45);
  const real = Date.now(); s.mock.st.attrs.get(u.uid); // ออกหลังเริ่ม: park คิดจาก pricing
  const lv = await s.call('POST', `/api/bookings/${b.id}/leave`, { token: u.token }); assert.equal(lv.status, 200, lv.raw);
  const out = lv.body.booking, mine = (await s.call('GET', '/api/me/bookings', { token: u.token })).body.books.find(x => x.id === b.id);
  const adm = (await list(s, st)).body.bookings.find(x => x.id === b.id);
  assert.equal(out.park, P.parkFee({ rate: 36, freemin: 0, bookfee: 45 }, out.s, out.out)); assert.ok(out.park > 0);
  assert.deepEqual([adm.amt, adm.park, adm.out], [out.amt, out.park, out.out]); assert.deepEqual([mine.amt, mine.park], [out.amt, out.park]);
  assert.ok(real > 0);
}, ENV, W));
