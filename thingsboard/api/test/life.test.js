// M3 B3/B4/B5: วงจรชีวิต (มาถึง/no-show/ออก), leave, ผู้ดูแลยกเลิก, ตัวซ่อม, รายการของฉัน, SSE mine, อัตรา/IP บน mock-tb เท่านั้น
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run, sleep, until, STAFF, WEB } = require('./harness');
const { decide } = require('../bookings');

const MIN = 60000;
const slots = (f = 1, n = 12) => Array.from({ length: n }, (_, i) => f + '-' + i);
const rid = () => 'req-' + crypto.randomUUID();
const good = (o = {}) => ({ f: 1, i: 1, car: 'กข1234', pm: 'pp', reqId: rid(), ...o });
const code = r => r.body && r.body.error && r.body.error.code;
const ENV = { BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', BOOK_RATE_MAX: '1000', LEAVE_RATE_MAX: '1000', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0' };

// เทสต์ที่ควบคุมเวลา: clock.t เป็นนาฬิกาของเซิร์ฟเวอร์ (ฉีดเข้า API) tick() เลื่อนเวลาและต่อ hb ให้บอร์ดยังออนไลน์
const life = (fn, env = {}, wopts = {}) => async () => {
  const clock = { t: Date.now() };
  await run(async s => {
    s.mock.setAttr('config', { floors: 2, slots: 12, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 });
    const t = { hb: 1 }; for (const k of [...slots(1), ...slots(2)]) t['slot_' + k] = false; s.mock.setTel(t, clock.t);
    await fn(s, clock);
  }, { ...ENV, ...env }, { writesEnabled: true, now: () => clock.t, ...wopts })();
};
const tick = (s, clock, ms, tel = {}) => { clock.t += ms; s.mock.setTel({ hb: 1, ...tel }, clock.t); };
const offline = (s, clock, ms) => { clock.t += ms; };     // ไม่ต่อ hb = บอร์ดหลุด
const settle = async s => { for (let n = 0; n < 3; n++) { await sleep(15); await s.routes.bookings.idle(2000); } };
const user = async (s, email, cars = ['กข1234']) => {
  const u = await s.member(email);
  assert.equal((await s.call('PUT', '/api/me', { token: u.token, body: { cars: cars.map(plate => ({ plate })) } })).status, 200);
  return u;
};
const staffUser = async (s, email) => { const u = await s.member(email); s.mock.st.users.get(u.uid).customerId = { id: STAFF }; return u; };
const post = (s, u, body) => s.call('POST', '/api/bookings', { token: u.token, body });
const mine = async (s, u) => { const r = await s.call('GET', '/api/me/bookings', { token: u.token }); assert.equal(r.status, 200, r.raw); await settle(s); return (await s.call('GET', '/api/me/bookings', { token: u.token })).body; };
const bk = (s, k) => s.mock.st.assetAttrs['bk_' + k];
const wr = s => s.mock.st.wr.length;
const books = (s, u) => s.mock.st.attrs.get(u.uid).books;
const book = async (s, u, o = {}) => { const r = await post(s, u, good(o)); assert.equal(r.status, 201, r.raw); return r.body; };

// ---------- decide (ฟังก์ชันล้วน) ----------
test('decide: arrive / noshow ที่ขอบ 29:59.999 / done ต้องครบ 15 วิ / occ:null ไม่ตัดสินอะไรเลย', () => {
  const snap = { stale: false, config: { noshow: 30 } }, up = { occ: true }, dn = { occ: false }, nu = { occ: null };
  const b = { s: 1000 };
  assert.equal(decide(b, up, snap, 5000).kind, 'arrive');
  assert.equal(decide(b, dn, snap, 1000 + 30 * MIN - 1), null);
  assert.equal(decide(b, dn, snap, 1000 + 30 * MIN).kind, 'noshow');
  assert.equal(decide(b, up, snap, 1000 + 99 * MIN).kind, 'arrive');           // มีรถก่อนครบเวลาหรือหลังครบ = มาถึง ไม่ใช่ no-show
  assert.equal(decide(b, nu, snap, 1000 + 99 * MIN), null);                      // offline ไม่ตีเป็น no-show
  const a = { s: 1000, arr: 2000 };
  assert.equal(decide(a, dn, snap, 19999, 5000), null); assert.equal(decide(a, dn, snap, 20000, 5001), null);
  assert.deepEqual(decide(a, dn, snap, 20000, 5000), { kind: 'done', out: 5000 });
  assert.equal(decide(a, up, snap, 99999, 5000), null); assert.equal(decide(a, nu, snap, 99999, 5000), null); assert.equal(decide(a, dn, snap, 99999, undefined), null);
  assert.equal(decide(b, dn, { ...snap, stale: true }, 1000 + 99 * MIN), null);
  assert.equal(decide(b, { occ: false, conflict: true }, snap, 1000 + 99 * MIN), null);
});

// ---------- AC-10 มาถึง ----------
test('วงจรชีวิต: รถมาถึง = ตั้ง arr ครั้งเดียว (เวลาที่เห็น occ:true) ทั้ง bk_ และ books เขียน 2 ครั้ง หลายคำขอไม่เขียนซ้ำ', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev'); await book(s, a); const w0 = wr(s);
  tick(s, clock, 5000, { 'slot_1-1': true }); const seen = clock.t;
  const m = await mine(s, a); assert.equal(m.books[0].arr, seen); assert.equal(m.books[0].status, 'active');
  assert.equal(bk(s, '1-1')[0].arr, seen); assert.equal(books(s, a)[0].arr, seen); assert.equal(wr(s) - w0, 2);
  tick(s, clock, 3000); await mine(s, a); await mine(s, a); await s.call('GET', '/api/lot', { token: a.token }); await settle(s);
  assert.equal(wr(s) - w0, 2, 'ไม่เขียนซ้ำ'); assert.equal(bk(s, '1-1')[0].arr, seen);
}));

// ---------- AC-11 ออก ----------
test('วงจรชีวิต: รถออก = occ:false ต่อเนื่อง 15 วิ (14.9 วิยังไม่ออก, true/null คั่นรีเซ็ต) out = เวลาเห็น false ครั้งแรก, park ตามสูตร, ใบเสร็จค่าจอด, ปล่อยช่อง', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev'); const b0 = await book(s, a); const t0 = b0.booking.s;
  tick(s, clock, 1000, { 'slot_1-1': true }); await mine(s, a);
  tick(s, clock, 89 * MIN, { 'slot_1-1': true }); await mine(s, a);               // จอดมา ~90 นาที
  tick(s, clock, 1000, { 'slot_1-1': false }); const firstFalse = clock.t; await mine(s, a);
  tick(s, clock, 14900); let m = await mine(s, a); assert.equal(m.books[0].status, 'active', '14.9 วิยังไม่ออก');
  tick(s, clock, 100, { 'slot_1-1': true }); await mine(s, a);                     // true คั่น = รีเซ็ต
  tick(s, clock, 1000, { 'slot_1-1': false }); const second = clock.t; await mine(s, a);
  tick(s, clock, 5000, { 'slot_1-1': undefined }); await mine(s, a);               // null คั่น = รีเซ็ตอีก
  tick(s, clock, 1000, { 'slot_1-1': false }); const third = clock.t; await mine(s, a);
  tick(s, clock, 14999); m = await mine(s, a); assert.equal(m.books[0].status, 'active');
  tick(s, clock, 1); m = await mine(s, a);
  const bo = m.books[0]; assert.equal(bo.status, 'done'); assert.equal(bo.out, third, 'out = เวลาเห็น false ครั้งแรกของช่วงต่อเนื่อง (ไม่ใช่วินาทีที่ 15)');
  assert.equal(bo.min, Math.max(1, Math.ceil((third - t0) / MIN))); assert.equal(bo.park, Math.ceil(Math.max(0, bo.min - 30) / 60 * 20)); assert.ok(bo.park > 0);
  const rc = m.rcp.filter(r => r.kind === 'park'); assert.equal(rc.length, 1); assert.equal(rc[0].amt, bo.park); assert.equal(rc[0].min, bo.min); assert.equal(rc[0].t, bo.out);
  assert.deepEqual(bk(s, '1-1'), []); assert.ok(bo.out >= bo.s);
  assert.equal((await post(s, a, good())).status, 201, 'ช่องว่างให้จองใหม่ได้');
  assert.ok(firstFalse < second && second < third);
}));

// ---------- AC-12 no-show ----------
test('วงจรชีวิต: no-show เมื่อครบ 30 นาทีและช่องออนไลน์ว่าง (29:59.999 ยังไม่ใช่) ไม่คืนค่าจอง ไม่มีใบเสร็จใหม่; occ:true ก่อนครบ = มาถึง', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev', ['กข1', 'กข2']);
  const x = await book(s, a, { i: 1, car: 'กข1' }), y = await book(s, a, { i: 2, car: 'กข2' }); const nRc = (await mine(s, a)).rcp.length;
  tick(s, clock, 30 * MIN - 1 - (clock.t - x.booking.s) - 0 + 0, { 'slot_1-2': true });   // ช่อง 1-2 มีรถก่อนครบเวลา = มาถึง
  let m = await mine(s, a); assert.equal(m.books.find(b => b.id === x.booking.id).status, 'active'); assert.ok(m.books.find(b => b.id === y.booking.id).arr);
  assert.equal(clock.t - x.booking.s, 30 * MIN - 1); assert.equal(bk(s, '1-1').length, 1);
  tick(s, clock, 1); m = await mine(s, a);
  const nx = m.books.find(b => b.id === x.booking.id); assert.equal(nx.status, 'noshow'); assert.ok(nx.out >= nx.s); assert.deepEqual(bk(s, '1-1'), []);
  assert.equal(m.rcp.length, nRc, 'ไม่มีใบเสร็จใหม่ และไม่คืนค่าจอง'); assert.ok(!m.rcp.some(r => r.kind === 'refund'));
  assert.equal(m.books.find(b => b.id === y.booking.id).status, 'active');
  assert.equal((await post(s, a, good({ i: 1, car: 'กข1' }))).status, 201, 'ช่องว่างจองใหม่ได้');
}));

// ---------- AC-9 ----------
test('วงจรชีวิต: จองแล้วสัญญาณหาย = ยังเป็น "จองแล้ว" ไม่ถูกตีเป็น no-show/ออก; สัญญาณกลับต้องเห็น false ต่อเนื่องใหม่ครบ 15 วิ', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev', ['กข1', 'กข2']), o = await user(s, 'o@t.dev');
  await book(s, a, { i: 1, car: 'กข1' }); const y = await book(s, a, { i: 2, car: 'กข2' });
  tick(s, clock, 1000, { 'slot_1-2': true }); await mine(s, a);                  // 1-2 มาถึงแล้ว
  offline(s, clock, 100 * MIN);                                                  // บอร์ดหลุดนานเกินเวลา no-show
  let m = await mine(s, a); assert.deepEqual(m.books.map(b => b.status), ['active', 'active']);
  const lot = (await s.call('GET', '/api/lot', { token: o.token })).body;
  for (const k of ['1-1', '1-2']) { const sl = lot.slots.find(x => x.k === k); assert.equal(sl.occ, null); assert.equal(sl.bookings.length, 1); }
  assert.equal(code(await post(s, o, good({ i: 1, car: 'กข1234' }))), 'SLOT_TAKEN');
  tick(s, clock, 1000, { 'slot_1-2': false }); await mine(s, a);                 // กลับมา เห็น false ครั้งแรก
  tick(s, clock, 14000); m = await mine(s, a); assert.equal(m.books.find(b => b.id === y.booking.id).status, 'active', 'ไม่ตีเป็นออกย้อนหลัง');
  tick(s, clock, 1000); m = await mine(s, a); assert.equal(m.books.find(b => b.id === y.booking.id).status, 'done');
  // 1-1 ไม่มี arr ออนไลน์และว่างหลังเกินเวลา = no-show ทันทีที่เห็นค่าจริง
  assert.equal(m.books.find(b => b.car === 'กข1').status, 'noshow');
}));

// ---------- leave (AC-21) ----------
test('leave: มี arr และ occ:null = 200 out=เวลากด park ตามสูตร; ซ้ำ = ผลเดิม ใบเสร็จ 1 ใบ', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev'); const b0 = await book(s, a); const id = b0.booking.id;
  const L = () => s.call('POST', '/api/bookings/' + id + '/leave', { token: a.token, body: {} });
  let w;let r;
  tick(s, clock, 1000, { 'slot_1-1': true }); await mine(s, a);
  tick(s, clock, 94 * MIN); offline(s, clock, 1000);                             // จอดนาน แล้วบอร์ดหลุด (occ:null)
  r = await L(); assert.equal(r.status, 200, r.raw);
  const bo = r.body.booking; assert.equal(bo.status, 'done'); assert.equal(bo.out, clock.t); assert.equal(bo.min, Math.ceil((clock.t - bo.s) / MIN));
  assert.equal(bo.park, Math.ceil((bo.min - 30) / 60 * 20)); assert.equal(r.body.receipt.kind, 'park'); assert.equal(r.body.receipt.amt, bo.park);
  assert.equal(r.body.serverNow, clock.t); assert.deepEqual(bk(s, '1-1'), []);
  w = wr(s); const r2 = await L(); assert.equal(r2.status, 200); assert.equal(r2.body.booking.park, bo.park); assert.equal(r2.body.receipt.no, r.body.receipt.no); assert.equal(wr(s), w);
  const par = await Promise.all([L(), L()]); assert.ok(par.every(x => x.status === 200)); assert.equal((await mine(s, a)).rcp.filter(x => x.kind === 'park').length, 1);
}));

test('leave: ตอน occ:true ได้ แต่ช่องจองใหม่ไม่ได้ (SLOT_OCCUPIED) จนกว่า occ:false; park=0 ไม่มีใบเสร็จค่าจอด (receipt:null)', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev'); const b0 = await book(s, a);
  tick(s, clock, 1000, { 'slot_1-1': true }); await mine(s, a); tick(s, clock, 2 * MIN, { 'slot_1-1': true });
  const r = await s.call('POST', '/api/bookings/' + b0.booking.id + '/leave', { token: a.token }); assert.equal(r.status, 200); assert.equal(r.body.booking.park, 0); assert.equal(r.body.receipt, null);
  assert.equal(code(await post(s, b, good())), 'SLOT_OCCUPIED');
  tick(s, clock, 1000, { 'slot_1-1': false }); assert.equal((await post(s, b, good())).status, 201);
}));

test('leave: ของคนอื่น/ไม่มี id = 404 เหมือนกันทุกไบต์; รายการ noshow = NOT_ACTIVE; id ผิดรูป/มี body = 400; ปิดเขียน = 503', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev'); const b0 = await book(s, a);
  const other = await s.call('POST', '/api/bookings/' + b0.booking.id + '/leave', { token: b.token });
  const none = await s.call('POST', '/api/bookings/b00000000000000000/leave', { token: b.token });
  assert.equal(other.status, 404); assert.equal(code(other), 'NOT_FOUND'); assert.equal(other.raw, none.raw); assert.equal(other.status, none.status);
  assert.equal((await s.call('POST', '/api/bookings/' + 'x'.repeat(65) + '/leave', { token: a.token })).status, 400);
  assert.equal((await s.call('POST', '/api/bookings/bad%20id/leave', { token: a.token })).status, 400);
  assert.equal((await s.call('POST', '/api/bookings/' + b0.booking.id + '/leave', { token: a.token, body: { out: 1 } })).status, 400);
  tick(s, clock, 31 * MIN); await mine(s, a);
  const ns = await s.call('POST', '/api/bookings/' + b0.booking.id + '/leave', { token: a.token }); assert.equal(ns.status, 409); assert.equal(code(ns), 'NOT_ACTIVE');
  assert.equal((await s.call('POST', '/api/bookings/' + b0.booking.id + '/leave')).status, 401);
}));

// ---------- DELETE (AC-13) ----------
test('ผู้ดูแลยกเลิก: member 403 (id จริง/ปลอมเหมือนกัน), staff ยกเลิก = cancelled by admin + reason + ใบเสร็จติดลบ, ช่องว่าง, ซ้ำ/ขนานได้ใบเดียว, done/noshow = NOT_ACTIVE, ไม่มี id = 404', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev', ['กข1', 'กข2', 'กข3']), st = await staffUser(s, 'st@t.dev');
  const x = await book(s, a, { i: 1, car: 'กข1' }), y = await book(s, a, { i: 2, car: 'กข2' }), z = await book(s, a, { i: 3, car: 'กข3' });
  const D = (u, id, body) => s.call('DELETE', '/api/bookings/' + id, { token: u.token, body });
  const m1 = await D(a, x.booking.id), m2 = await D(a, 'b00000000000000000'); assert.equal(m1.status, 403); assert.equal(code(m1), 'FORBIDDEN'); assert.equal(m1.raw, m2.raw);
  assert.equal((await D(st, 'b00000000000000000')).status, 404);
  const r = await D(st, x.booking.id, { reason: 'ปิดซ่อมช่อง' }); assert.equal(r.status, 200, r.raw);
  assert.deepEqual({ st: r.body.booking.status, by: r.body.booking.by, reason: r.body.booking.reason }, { st: 'cancelled', by: 'admin', reason: 'ปิดซ่อมช่อง' });
  assert.ok(!('bu' in r.body.booking) && !('uid' in r.body.booking)); assert.equal(r.body.receipt.kind, 'refund'); assert.equal(r.body.receipt.amt, -20);
  assert.deepEqual(bk(s, '1-1'), []); assert.equal(books(s, a).find(b => b.id === x.booking.id).bu, st.uid);   // เก็บ uid ผู้ดูแลไว้ตรวจย้อนหลัง
  const m = await mine(s, a); assert.equal(m.books.find(b => b.id === x.booking.id).by, 'admin'); assert.ok(!JSON.stringify(m).includes(st.uid));
  assert.equal(m.rcp.filter(q => q.kind === 'refund').length, 1);
  // ซ้ำและขนาน = ผลเดิม ใบเสร็จติดลบใบเดียว
  const rep = await D(st, x.booking.id); assert.equal(rep.status, 200); assert.equal(rep.body.receipt.no, r.body.receipt.no);
  const par = await Promise.all([D(st, y.booking.id), D(st, y.booking.id)]); assert.deepEqual(par.map(q => q.status), [200, 200]); assert.equal(par[0].body.receipt.no, par[1].body.receipt.no);
  assert.equal((await mine(s, a)).rcp.filter(q => q.kind === 'refund').length, 2);
  // รถกำลังจอดก็ยกเลิกได้ ไม่คิดค่าจอด คืนเฉพาะค่าจอง
  tick(s, clock, 1000, { 'slot_1-3': true }); await mine(s, a); tick(s, clock, 40 * MIN, { 'slot_1-3': true });
  const park = await D(st, z.booking.id); assert.equal(park.status, 200); assert.equal(park.body.receipt.amt, -20); assert.ok(!('park' in park.body.booking));
  // done / noshow = 409 NOT_ACTIVE
  const c = await book(s, a, { i: 4, car: 'กข1' }); tick(s, clock, 31 * MIN); await mine(s, a);
  const ns = await D(st, c.booking.id); assert.equal(ns.status, 409); assert.equal(code(ns), 'NOT_ACTIVE');
  // reason ที่ไม่ผ่านตัวตรวจ = 400 ไม่เขียน
  const d = await book(s, a, { i: 5, car: 'กข1' }); const w = wr(s);
  for (const reason of ['<b>x</b>', 'ก'.repeat(101), 'บัตร 4111 1111 1111 1111', 5, ['x'], 'a\u0000b']) assert.equal((await D(st, d.booking.id, { reason })).status, 400, JSON.stringify(reason));
  assert.equal((await D(st, d.booking.id, { reason: 'x', extra: 1 })).status, 400); assert.equal(wr(s), w);
  assert.equal((await D(st, d.booking.id)).body.booking.reason, 'ผู้ดูแลยกเลิก');   // ไม่ส่ง = ข้อความเริ่มต้น
}));

test('ผู้ดูแลยกเลิก: bookfee=0 = ไม่มีใบเสร็จคืนเงิน (receipt:null); ยกเลิกตอนปิดเขียน = 503, member ได้ 403 ก่อนเสมอ', async () => {
  await life(async (s) => {
    s.mock.setAttr('config', { floors: 2, slots: 12, rate: 20, penalty: 20, bookfee: 0, freemin: 30, noshow: 30 });
    const a = await user(s, 'a@t.dev'), st = await staffUser(s, 'st@t.dev'); const b0 = await book(s, a); assert.equal(b0.receipt, null);
    const r = await s.call('DELETE', '/api/bookings/' + b0.booking.id, { token: st.token }); assert.equal(r.status, 200); assert.equal(r.body.receipt, null);
    assert.equal((await mine(s, a)).rcp.length, 0);
  })();
  await run(async s => {
    const a = await s.member('a@t.dev'), st = await staffUser(s, 'st@t.dev'); const w = wr(s);
    assert.equal((await s.call('DELETE', '/api/bookings/b00000000000000000', { token: st.token })).status, 503);
    assert.equal(code(await s.call('DELETE', '/api/bookings/b00000000000000000', { token: a.token })), 'FORBIDDEN');
    assert.equal(code(await s.call('POST', '/api/bookings/b00000000000000000/leave', { token: a.token })), 'WRITES_DISABLED'); assert.equal(wr(s), w);
  })();
});

// ---------- ปิดเขียน: sweep ไม่เขียน ----------
test('ปิดเขียน (ค่าเริ่มต้น): แม้เซนเซอร์เห็นรถมา/ครบ no-show ระบบไม่เขียนอะไรลง ThingsBoard เลย แต่ยังอ่านรายการได้', async () => {
  const clock = { t: Date.now() };
  await run(async s => {
    s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, bookfee: 20, freemin: 30, noshow: 30 });
    s.mock.setTel({ hb: 1, 'slot_1-1': false, 'slot_1-2': false }, clock.t);
    const a = await user(s, 'a@t.dev'); const w = wr(s);
    s.mock.setAttr('bk_1-1', [{ id: 'b00000000000000001', uid: a.uid, car: 'กข1234', s: clock.t, e: clock.t + 2592000000, status: 'active', amt: 20, pm: 'pp', rno: 'PH11111111', rq: 'abcdef012345' }]);
    s.mock.st.attrs.set(a.uid, { ...s.mock.st.attrs.get(a.uid), books: [{ id: 'b00000000000000001', f: 1, i: 1, car: 'กข1234', s: clock.t, e: clock.t + 2592000000, status: 'active', amt: 20, pm: 'pp', rno: 'PH11111111' }] });
    tick(s, clock, 2000, { 'slot_1-1': true }); await s.call('GET', '/api/lot', { token: a.token });
    await s.call('GET', '/api/me/bookings', { token: a.token }); await settle(s);
    tick(s, clock, 40 * MIN, { 'slot_1-1': false }); await s.call('GET', '/api/me/bookings', { token: a.token }); await settle(s);
    assert.equal(wr(s), w); assert.equal(bk(s, '1-1')[0].arr, undefined);
  }, { ...ENV, LOT_CACHE_MS: '0' }, { now: () => clock.t })();
});

test('sweep หลังเริ่มระบบต้องรอ (BOOK_SWEEP_DELAY_MS): ก่อนครบเวลาไม่เขียนอัตโนมัติ ครบแล้วเขียน', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev'); await book(s, a); const w = wr(s);
  tick(s, clock, 1000, { 'slot_1-1': true }); await mine(s, a); assert.equal(wr(s), w, 'ยังไม่ถึงเวลา sweep');
  tick(s, clock, 36000, { 'slot_1-1': true }); await mine(s, a); assert.ok(wr(s) > w);
}, { BOOK_SWEEP_DELAY_MS: '35000' }));

// ---------- ตัวซ่อม AC-16 ----------
const mkEntry = (uid, over = {}) => ({ id: 'b' + crypto.randomBytes(8).toString('hex'), uid, car: 'กข1234', s: Date.now(), e: Date.now() + 2592000000, status: 'active', amt: 20, pm: 'pp', rno: 'PH' + String(crypto.randomInt(1e7, 9e7)), rq: crypto.randomBytes(6).toString('hex'), ...over });
const asBook = (e, f, i, over = {}) => { const { uid, ...c } = e; return { ...c, f, i, ...over }; };

test('ตัวซ่อม R1: bk_ ไม่มีใน books และอายุ > 120 วิ = ปล่อยช่อง (อายุน้อยกว่านี้ไม่แตะ); ทำซ้ำผลเท่าเดิม', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev');
  s.mock.setAttr('bk_1-1', [mkEntry(a.uid, { s: clock.t - 100000 })]);
  assert.equal(code(await post(s, b, good({ i: 1 }))), 'SLOT_TAKEN'); assert.equal(bk(s, '1-1').length, 1, 'อายุ 100 วิ ยังไม่แตะ');
  tick(s, clock, 30000); const r = await post(s, b, good({ i: 1 })); assert.equal(r.status, 201, r.raw);   // อายุ 130 วิ -> ปล่อยแล้วจองได้
  assert.notEqual(bk(s, '1-1')[0].uid, a.uid);
  // ตัวซ่อมสองรอบ (sweep) ไม่เปลี่ยนผล
  s.mock.setAttr('bk_1-5', [mkEntry(a.uid, { s: clock.t - 500000 })]); await s.call('GET', '/api/lot', { token: a.token }); await settle(s); tick(s, clock, 1000); await mine(s, a); await mine(s, a);
  assert.deepEqual(bk(s, '1-5'), []); const snapshot = JSON.stringify(s.mock.st.assetAttrs); await mine(s, a); assert.equal(JSON.stringify(s.mock.st.assetAttrs), snapshot);
}));

test('ตัวซ่อม: R1 ไม่ปล่อยเมื่อมี arr (สร้างสำเนา books ใหม่ ไม่ให้ใครหลบค่าจอดด้วยการลบ books) / R2 books จบแล้วแต่ bk_ ค้าง = ปล่อย / R4 arr ไม่ตรง = คัดลอก', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev');
  const e1 = mkEntry(a.uid, { s: clock.t - 900000, arr: clock.t - 800000 }); s.mock.setAttr('bk_1-1', [e1]);
  const e2 = mkEntry(a.uid, { s: clock.t - 900000 }); s.mock.setAttr('bk_1-2', [e2]); s.mock.st.attrs.set(a.uid, { ...s.mock.st.attrs.get(a.uid), books: [asBook(e2, 1, 2, { status: 'done', out: clock.t - 100, min: 5, park: 0 })] });
  const e3 = mkEntry(a.uid, { s: clock.t - 900000, arr: clock.t - 5000 }); s.mock.setAttr('bk_1-3', [e3]);
  s.mock.st.attrs.set(a.uid, { ...s.mock.st.attrs.get(a.uid), books: [asBook(e2, 1, 2, { status: 'done', out: clock.t - 100, min: 5, park: 0 }), asBook(e3, 1, 3)] });
  tick(s, clock, 1000, { 'slot_1-1': true, 'slot_1-3': true }); await mine(s, a); await mine(s, a);
  const bs = books(s, a); const c1 = bs.find(b => b.id === e1.id); assert.ok(c1 && c1.arr === e1.arr && c1.status === 'active', 'สร้างสำเนาจาก bk_'); assert.equal(bk(s, '1-1').length, 1);
  assert.deepEqual(bk(s, '1-2'), []);
  assert.equal(bs.find(b => b.id === e3.id).arr, e3.arr);
  const again = JSON.stringify(s.mock.st.attrs.get(a.uid)); await mine(s, a); assert.equal(JSON.stringify(s.mock.st.attrs.get(a.uid)), again);
}));

test('ตัวซ่อม R3: books active แต่ไม่มี bk_ และอายุ > 120 วิ = void (ผู้ใช้ไม่เห็น ไม่มีใบเสร็จ); อายุน้อยกว่านั้นไม่แตะ', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev');
  const old = mkEntry(a.uid, { s: clock.t - 300000 }), fresh = mkEntry(a.uid, { s: clock.t - 30000 });
  s.mock.st.attrs.set(a.uid, { ...s.mock.st.attrs.get(a.uid), books: [asBook(fresh, 1, 6), asBook(old, 1, 7)] });
  const m = await mine(s, a); assert.deepEqual(m.books.map(b => b.id), [fresh.id]); assert.ok(!m.rcp.some(r => r.bid === old.id));
  assert.equal(books(s, a).find(b => b.id === old.id).status, 'void'); assert.equal(books(s, a).find(b => b.id === fresh.id).status, 'active');
}));

// ---------- รายการของฉัน ----------
test('GET /api/me/bookings: เฉพาะของตัวเอง ไม่มี uid/rno/rq/bu ใบเสร็จคำนวณจาก books ไม่มี void มี serverNow; ต้องล็อกอิน', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev'); const x = await book(s, a); await book(s, b, { i: 2 });
  const r = await s.call('GET', '/api/me/bookings', { token: a.token }); assert.equal(r.status, 200);
  assert.equal(r.body.serverNow, clock.t); assert.deepEqual(r.body.books.map(q => q.id), [x.booking.id]); assert.equal(r.body.rcp.length, 1);
  for (const k of ['"uid"', '"rno"', '"rq"', '"bu"', b.uid, a.uid]) assert.ok(!r.raw.includes(k), k);
  assert.deepEqual(Object.keys(r.body).sort(), ['books', 'rcp', 'serverNow']);
  assert.equal((await s.call('GET', '/api/me/bookings')).status, 401);
  s.mock.st.failAttr = 0; s.mock.st.failDev['dev-lot'] = 0;
}));

// ---------- SSE mine + serverNow ----------
test('SSE: snapshot มี serverNow แล้วส่ง mine ทันที; จองสำเร็จ/ออกส่ง mine ใหม่ถึงเจ้าของเท่านั้น (ไม่ถึงผู้ใช้อื่น)', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev');
  const ca = await s.sse(a.token), cb = await s.sse(b.token);
  const snap = (await ca.wait('snapshot')).data; assert.equal(snap.serverNow, clock.t);
  const m0 = (await ca.wait('mine')).data; assert.deepEqual(Object.keys(m0).sort(), ['books', 'rcp', 'serverNow']); assert.equal(m0.books.length, 0);
  assert.equal(ca.events[0].event, 'snapshot'); assert.equal(ca.events[1].event, 'mine'); await cb.wait('mine');
  const x = await book(s, a);
  const m1 = (await ca.wait('mine', d => d.books.length === 1)).data; assert.equal(m1.books[0].id, x.booking.id); assert.equal(m1.rcp.length, 1);
  await sleep(80); assert.ok(cb.of('mine').every(e => e.data.books.length === 0), 'ไม่ส่ง mine ของ A ให้ B'); assert.ok(!JSON.stringify(cb.events).includes(a.uid));
  const lotR = await s.call('GET', '/api/lot', { token: a.token }); assert.equal(lotR.body.serverNow, clock.t);
  ca.close(); cb.close();
}));

// ---------- AC-18 โควตา ----------
test('โควตา: วงจรจอง→มาถึง→ออก 1 รอบเขียนไป ThingsBoard ไม่เกิน 8 ครั้ง (เป้า 6) อ่านไม่เกิน 20 ต่อรอบ ไม่มี telemetry/ผู้ใช้ใหม่', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev'); const w0 = wr(s), c0 = s.mock.st.calls.length;
  const b0 = await book(s, a);
  tick(s, clock, 1000, { 'slot_1-1': true }); await mine(s, a); tick(s, clock, 40 * MIN, { 'slot_1-1': true });
  const r = await s.call('POST', '/api/bookings/' + b0.booking.id + '/leave', { token: a.token }); assert.equal(r.status, 200);
  const n = wr(s) - w0; assert.ok(n <= 8, 'เขียน ' + n); assert.equal(n, 6);
  const mine6 = s.mock.st.wr.slice(w0); assert.equal(mine6.filter(x => x.entity === 'ASSET').length, 3); assert.equal(mine6.filter(x => x.entity === 'USER').length, 3);
  const calls = s.mock.st.calls.slice(c0).filter(c => c.method === 'POST' || c.method === 'DELETE');
  assert.ok(!calls.some(c => /telemetry\/.+\/timeseries|\/api\/user|\/api\/asset|\/api\/device|customer/.test(c.path) && !/attributes/.test(c.path)));
  // books ไม่เกินเพดาน แม้ใส่ข้อมูลทดสอบเกิน (ตัดของเก่า ไม่ตัด active รายการใหม่สุดยังอยู่)
  const many = Array.from({ length: 80 }, (_, i) => ({ id: 'bo' + String(i).padStart(15, '0'), f: 1, i: 6, car: 'กข1', s: 1e12 + i, e: 1e12 + i + 2592000000, status: 'done', amt: 20, pm: 'pp', rno: 'PH' + (10000000 + i), out: 1e12 + i + 5, min: 1, park: 0 }));
  s.mock.st.attrs.set(a.uid, { ...s.mock.st.attrs.get(a.uid), books: many });
  const x = await book(s, a, { i: 7 }); const bs = books(s, a); assert.ok(bs.length <= 60); assert.ok(Buffer.byteLength(JSON.stringify(bs)) <= 30000); assert.equal(bs[0].id, x.booking.id);
}));

// ---------- อัตราและ IP (AC-20) ----------
test('leave/DELETE: ครั้งที่ 21 ใน 1 นาที = 429 + Retry-After', life(async (s, clock) => {
  const a = await user(s, 'a@t.dev');
  for (let n = 0; n < 20; n++) assert.equal((await s.call('POST', '/api/bookings/b00000000000000000/leave', { token: a.token })).status, 404);
  const r = await s.call('POST', '/api/bookings/b00000000000000000/leave', { token: a.token }); assert.equal(r.status, 429); assert.equal(code(r), 'RATE_LIMIT'); assert.match(r.headers.get('retry-after'), /^\d+$/);
  const st = await staffUser(s, 'st@t.dev'); assert.equal((await s.call('DELETE', '/api/bookings/b00000000000000000', { token: st.token })).status, 404);
  clock.t += 61000; assert.equal((await s.call('POST', '/api/bookings/b00000000000000000/leave', { token: a.token })).status, 404);
}, { LEAVE_RATE_MAX: '20' }));

test('เพดาน IP ก่อนตรวจตัวตน: ทุก /api/* 120/นาที/IP; JWT ปลอมรัว ๆ ไม่ท่วม ThingsBoard; JWT ที่ถูกปฏิเสธซ้ำถูก cache ผลลบ', run(async s => {
  const ip = { 'X-Forwarded-For': '203.0.113.7' };
  const forged = n => s.mock.makeToken('forged' + n, 900);
  let c429 = 0;
  for (let n = 0; n < 200; n++) { const r = await s.call('GET', '/api/lot', { token: forged(n), headers: ip }); if (r.status === 429) { c429++; assert.equal(code(r), 'RATE_LIMIT'); assert.ok(r.headers.get('retry-after')); } else assert.equal(r.status, 401); }
  assert.equal(c429, 180); assert.ok(s.mock.st.authUserCalls <= 20, 'ThingsBoard ถูกเรียก ' + s.mock.st.authUserCalls);
  // JWT เดียวกันซ้ำ: ถามแค่ครั้งเดียว (ผลลบ cache 30 วิ) จาก IP อื่น
  const one = forged('same'); const n0 = s.mock.st.authUserCalls;
  for (let n = 0; n < 10; n++) { const r = await s.call('GET', '/api/lot', { token: one, headers: { 'X-Forwarded-For': '198.51.100.' + n } }); assert.equal(r.status, 401); assert.equal(code(r), 'TOKEN_INVALID'); }
  assert.equal(s.mock.st.authUserCalls - n0, 1);
  // IP อื่นไม่ถูกกระทบ / healthz ไม่ใช่ /api/ จึงไม่นับ
  assert.equal((await s.call('GET', '/healthz', { headers: ip })).status, 200);
  const u = await s.member('ok@t.dev'); assert.equal((await s.call('GET', '/api/lot', { token: u.token, headers: { 'X-Forwarded-For': '192.0.2.1' } })).status, 200);
}));

// ---------- CORS DELETE ----------
test('CORS: Allow-Methods เจาะจง (GET, POST, PUT, DELETE, OPTIONS ไม่ใช้ *); DELETE ข้าม origin ได้และอ่าน body ได้', run(async s => {
  const pre = await fetch(s.base + '/api/bookings/b1', { method: 'OPTIONS', headers: { Origin: WEB, 'Access-Control-Request-Method': 'DELETE', 'X-Forwarded-For': '10.7.7.7' } });
  assert.equal(pre.status, 204); const am = pre.headers.get('access-control-allow-methods'); assert.ok(/DELETE/.test(am) && !/\*/.test(am), am);
  const st = await staffUser(s, 'st@t.dev');
  const r = await fetch(s.base + '/api/bookings/b00000000000000000', { method: 'DELETE', headers: { Origin: WEB, Authorization: 'Bearer ' + st.token, 'Content-Type': 'application/json', 'X-Forwarded-For': '10.7.7.8' }, body: JSON.stringify({ reason: '<x>' }) });
  assert.equal(r.status, 503, 'ปิดเขียนตอบก่อน'); assert.equal(r.headers.get('access-control-allow-origin'), WEB);
}));
test('CORS+DELETE body: เมื่อเปิดเขียน body ของ DELETE ถูกอ่านและตรวจ (reason ผิด = 400)', life(async (s) => {
  const st = await staffUser(s, 'st@t.dev');
  const r = await fetch(s.base + '/api/bookings/b00000000000000000', { method: 'DELETE', headers: { Authorization: 'Bearer ' + st.token, 'Content-Type': 'application/json', 'X-Forwarded-For': '10.7.7.9' }, body: JSON.stringify({ reason: '<x>' }) });
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'BAD_INPUT');
}));

// ---------- AC-25 ล็อก/ค้าง ----------
test('ล็อกเดียว: 50 คำขอสลับ จอง/leave/ยกเลิก/sweep บนหลายช่องและผู้ใช้ (mock หน่วงสุ่ม) ไม่ค้าง ภายใน 10 วินาที ข้อมูลสอดคล้อง', life(async (s, clock) => {
  const us = []; for (let n = 0; n < 5; n++) us.push(await user(s, `m${n}@t.dev`, ['กข1', 'กข2', 'กข3']));
  const st = await staffUser(s, 'st@t.dev'); s.mock.st.delay = () => Math.floor(Math.random() * 3);
  const ids = [];
  const jobs = [];
  for (let n = 0; n < 50; n++) {
    const u = us[n % 5], kind = n % 5;
    if (kind <= 2) jobs.push(post(s, u, good({ i: n % 12, car: ['กข1', 'กข2', 'กข3'][n % 3] })).then(r => { if (r.status === 201) ids.push([r.body.booking.id, u]); return r; }));
    else if (kind === 3) jobs.push(s.call('POST', '/api/bookings/' + (ids[0] ? ids[0][0] : 'b00000000000000000') + '/leave', { token: (ids[0] ? ids[0][1] : u).token }));
    else jobs.push(s.call('DELETE', '/api/bookings/' + (ids[1] ? ids[1][0] : 'b00000000000000000'), { token: st.token }));
    if (n % 10 === 0) { tick(s, clock, 1000, { ['slot_1-' + (n % 12)]: true }); jobs.push(s.call('GET', '/api/lot', { token: u.token })); }
  }
  const done = await Promise.race([Promise.all(jobs).then(() => 'ok'), sleep(10000).then(() => 'timeout')]);
  assert.equal(done, 'ok'); await settle(s);
  for (const k of [...slots(1), ...slots(2)]) assert.ok((bk(s, k) || []).length <= 1, k);
  for (const u of us) { const ids2 = (books(s, u) || []).map(b => b.id); assert.equal(new Set(ids2).size, ids2.length); }
  const receipts = []; for (const u of us) for (const b of books(s, u) || []) receipts.push(...[b.rno]); assert.equal(new Set(receipts).size, receipts.length);
}));

test('SIGTERM: drain รองานเขียนที่ค้างให้เสร็จก่อน (ไม่ทิ้ง bk_ ครึ่งทาง)', life(async (s) => {
  const a = await user(s, 'a@t.dev'); s.mock.st.delay = () => 15;
  const p = post(s, a, good()); await sleep(40);
  await s.routes.drain(5000); const r = await p; assert.equal(r.status, 201); assert.equal(bk(s, '1-1').length, 1); assert.equal(books(s, a).length, 1);
}));
