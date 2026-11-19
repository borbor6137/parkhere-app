// M3 B2: POST /api/bookings บน mock-tb (ไม่แตะ ThingsBoard จริง) AC-1..8, 19, 20 (ส่วนผู้ใช้), 22, 23, 24, 25
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run, sleep, STAFF } = require('./harness');
const { rqOf } = require('../store');

const W = { writesEnabled: true };
const rid = () => 'req-' + crypto.randomUUID();
const slots = (f = 1, n = 12) => Array.from({ length: n }, (_, i) => f + '-' + i);
const seed = (s, cfg = {}) => {
  s.mock.setAttr('config', { floors: 2, slots: 12, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30, ...cfg });
  const t = { hb: 1 }; for (const k of [...slots(1), ...slots(2)]) t['slot_' + k] = false; s.mock.setTel(t);
};
const user = async (s, email, cars = ['กข1234']) => {
  const u = await s.member(email);
  const r = await s.call('PUT', '/api/me', { token: u.token, body: { cars: cars.map(plate => ({ plate })) } }); assert.equal(r.status, 200);
  return u;
};
const post = (s, u, body) => s.call('POST', '/api/bookings', { token: u.token, body });
const good = (o = {}) => ({ f: 1, i: 1, car: 'กข1234', pm: 'pp', reqId: rid(), ...o });
const writes = s => s.mock.st.wr.length;
const bk = (s, k) => s.mock.st.assetAttrs['bk_' + k];
const code = r => r.body && r.body.error && r.body.error.code;

// ---------- AC-1 ----------
test('จอง: สำเร็จ 201 เวลาเซิร์ฟเวอร์ ยอดจาก config เขียนครบ 2 ครั้ง (bk_ + books) และคนอื่นไม่เห็นข้อมูลส่วนตัว', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev'); const w0 = writes(s);
  const t0 = Date.now(); const r = await post(s, a, good());
  assert.equal(r.status, 201); const { booking, receipt, serverNow } = r.body;
  assert.ok(serverNow >= t0 && serverNow <= Date.now());
  assert.match(booking.id, /^b[0-9a-f]{24}$/); assert.ok(booking.s >= t0 && booking.s <= serverNow); assert.equal(booking.e, booking.s + 30 * 86400000);
  assert.deepEqual({ f: booking.f, i: booking.i, car: booking.car, status: booking.status, amt: booking.amt, pm: booking.pm }, { f: 1, i: 1, car: 'กข1234', status: 'active', amt: 20, pm: 'pp' });
  assert.deepEqual(Object.keys(booking).sort(), ['amt', 'car', 'e', 'f', 'i', 'id', 'pm', 's', 'status']);
  assert.equal(receipt.kind, 'book'); assert.equal(receipt.amt, 20); assert.equal(receipt.bid, booking.id); assert.equal(receipt.t, booking.s); assert.match(receipt.no, /^PH\d{8}$/);
  assert.equal(receipt.desc, 'ค่าจอง ช่อง A2 ชั้น 1'); assert.equal(receipt.f, 1); assert.equal(receipt.i, 1);
  const ent = bk(s, '1-1'); assert.equal(ent.length, 1); assert.equal(ent[0].uid, a.uid); assert.equal(ent[0].id, booking.id); assert.equal(ent[0].amt, 20);
  assert.match(ent[0].rq, /^[0-9a-f]{12}$/);
  const books = s.mock.st.attrs.get(a.uid).books; assert.equal(books.length, 1); assert.equal(books[0].id, booking.id); assert.equal(books[0].rno, receipt.no);
  assert.equal(writes(s) - w0, 2); assert.deepEqual(s.mock.st.wr.slice(w0).map(x => x.entity), ['ASSET', 'USER']);
  // คนอื่นเห็นว่าช่องถูกจอง แต่ไม่มีข้อมูลส่วนตัว
  const lot = await s.call('GET', '/api/lot', { token: b.token });
  assert.deepEqual(lot.body.slots.find(x => x.k === '1-1').bookings, [{ s: booking.s, e: booking.e, status: 'active', mine: false }]);
  for (const k of ['uid', 'rno', 'rq', 'arr', 'amt', 'pm']) assert.ok(!lot.raw.includes('"' + k + '"'));
  assert.ok(!lot.raw.includes(a.uid) && !lot.raw.includes('กข1234') && !lot.raw.includes(booking.id));
  const mine = await s.call('GET', '/api/lot', { token: a.token }); assert.equal(mine.body.slots.find(x => x.k === '1-1').bookings[0].mine, true);
}, {}, W));

test('จอง: ยอดค่าจองมาจาก config เสมอ (bookfee 35) และ bookfee=0 ได้ 201 receipt:null amt 0 ไม่มีใบเสร็จ', async () => {
  await run(async s => { seed(s, { bookfee: 35 }); const a = await user(s, 'a@t.dev'); const r = await post(s, a, good()); assert.equal(r.body.booking.amt, 35); assert.equal(r.body.receipt.amt, 35); }, {}, W)();
  await run(async s => {
    seed(s, { bookfee: 0 }); const a = await user(s, 'a@t.dev'); const r = await post(s, a, good());
    assert.equal(r.status, 201); assert.equal(r.body.booking.amt, 0); assert.equal(r.body.receipt, null);
    assert.equal(bk(s, '1-1')[0].amt, 0);
  }, {}, W)();
});

// ---------- AC-8 / AC-19 ----------
test('จอง: ไม่เชื่อ client — ช่องเกิน/ชนิดผิด/ค่าแปลก = 400 ไม่เขียนอะไร; รถ/บัตรที่ไม่ใช่ของตัวเอง 400 CAR_UNKNOWN/PAY_UNKNOWN; ช่องนอก config 404 NO_SLOT', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const w0 = writes(s);
  const bad = [
    {}, { f: 1, i: 1, car: 'กข1234', pm: 'pp' }, good({ reqId: 'short' }), good({ reqId: ['x'.repeat(10)] }), good({ reqId: 'a b c d e f g h' }), good({ reqId: 'x'.repeat(65) }),
    ...[ '1', 1.5, -1, [1], {}, null, true, 0, 100, 'a' ].map(f => good({ f })),
    ...[ '1', 1.5, -1, [1], {}, null, true, 1000, 'a' ].map(i => good({ i })),
    ...[ '', ['กข1234'], [''], {}, 5, null, 'x'.repeat(13), '4111111111111111', '4111 1111 1111 1111', 'ก<b>ข', 'ก\u0000ข' ].map(car => good({ car })),
    ...[ [], {}, 5, '', 'a b', '../x', null, ['pp'] ].map(pm => good({ pm })),
    ...['amt', 'uid', 's', 'e', 'status', 'id', 'by', 'arr', 'out', 'rno', 'rq', 'cvv', 'card', 'constructor'].map(k => good({ [k]: k === 'amt' ? 0 : 'x' })),
    good({ pm: '4111111111111111' + 'x'.repeat(30) }), good({ cvv: '123', card: '4111111111111111' }),
  ];
  for (const body of bad) { const r = await post(s, a, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.ok(['BAD_INPUT', 'PAY_UNKNOWN', 'CAR_UNKNOWN'].includes(code(r)), JSON.stringify(body) + ' ' + code(r)); }
  // body ไม่ใช่ object / __proto__ เป็นคีย์ตรง ๆ
  for (const raw of ['[]', '"x"', '5', 'null', '{"__proto__":{"f":1},"f":1,"i":1,"car":"กข1234","pm":"pp","reqId":"req-12345678"}', '{"f":1', '']) {
    const r = await fetch(s.base + '/api/bookings', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.' + Math.floor(Math.random() * 250) }, body: raw });
    assert.equal(r.status, 400, raw); assert.ok((await r.json()).error.code);
  }
  assert.equal(writes(s) - w0, 0);
  // บัตร/CVV ไม่อยู่ในที่เก็บหรือ log ใด ๆ
  assert.ok(!JSON.stringify([...s.mock.st.attrs.values()]).includes('4111') && !JSON.stringify(s.mock.st.assetAttrs).includes('4111'));
  // ยอดมาจากเซิร์ฟเวอร์: ส่ง amt ไม่ได้ (400) ส่งปกติได้ bookfee
  const ok = await post(s, a, good({ i: 2 })); assert.equal(ok.body.booking.amt, 20);
  // ชนิดถูกแต่ไม่ใช่ของตัวเอง
  const w1 = writes(s);
  let r = await post(s, a, good({ car: 'ขค9999' })); assert.equal(r.status, 400); assert.equal(code(r), 'CAR_UNKNOWN');
  r = await post(s, a, good({ pm: 'card-of-someone-else' })); assert.equal(r.status, 400); assert.equal(code(r), 'PAY_UNKNOWN');
  r = await post(s, a, good({ f: 3 })); assert.equal(r.status, 404); assert.equal(code(r), 'NO_SLOT');
  r = await post(s, a, good({ i: 12 })); assert.equal(r.status, 404); assert.equal(code(r), 'NO_SLOT');
  r = await post(s, a, good({ f: 99, i: 999 })); assert.equal(code(r), 'NO_SLOT');
  assert.equal(writes(s), w1);
}, { BOOK_RATE_MAX: '1000' }, W));

test('จอง: ทะเบียนเทียบด้วยรูป normalize (ช่องว่าง ขีด เลขไทย) และบันทึกตามที่เก็บในรถ; บัตรเดโมของตัวเอง (id) ใช้ได้', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev', ['กข 1234']);
  const put = await s.call('PUT', '/api/me', { token: a.token, body: { pays: [{ label: 'เดโม', brand: 'visa', last4: '4242' }] } }); assert.equal(put.status, 200);
  const pid = put.body.pays[0].id;   // id ออกโดยเซิร์ฟเวอร์ (F-2)
  const r = await post(s, a, good({ car: 'กข-๑๒๓๔', pm: pid })); assert.equal(r.status, 201);
  assert.equal(r.body.booking.car, 'กข 1234'); assert.equal(r.body.booking.pm, pid);
}, {}, W));

// ---------- AC-2 / AC-3 / AC-24 ----------
// การจองของผู้ใช้อื่นที่ "ปกติ" (มีทั้ง bk_ และสำเนาใน books ของเจ้าของ) ตัวซ่อมจึงไม่ปล่อย
const taken = (s, k, uid, over = {}) => {
  const e = { id: 'b' + crypto.randomBytes(8).toString('hex'), uid, car: 'ทต1', s: 1700000000000, e: 1700000000000 + 2592000000, status: 'active', amt: 20, pm: 'pp', rno: 'PH11111111', rq: 'abcdef012345', ...over };
  s.mock.setAttr('bk_' + k, [e]);
  const [f, i] = k.split('-').map(Number), { uid: _u, ...copy } = e, prev = s.mock.st.attrs.get(uid) || {};
  s.mock.st.attrs.set(uid, { ...prev, books: [{ ...copy, f, i }, ...(prev.books || [])] });
  return e;
};
test('จอง: ปฏิเสธช่องไม่ทราบสถานะ (offline/ไม่เคยส่ง/stale/conflict) โดยไม่เขียน และอ่านสดทุกครั้ง ไม่ใช้ cache 5 วิ', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const w0 = writes(s);
  s.mock.setTel({ 'slot_1-3': undefined });                                  // ไม่เคยส่งช่องนี้
  let r = await post(s, a, good({ i: 3 })); assert.equal(r.status, 409); assert.equal(code(r), 'SLOT_UNKNOWN');
  // cache อุ่นไว้ว่าช่องว่าง แล้วบอร์ดหลุด: ต้องไม่ผ่านด้วย cache
  await s.routes.lot.get();
  s.mock.setTel({ hb: 1 }, Date.now() - 200000); s.mock.setTel({ 'slot_1-1': false }, Date.now() - 200000);
  r = await post(s, a, good({ i: 1 })); assert.equal(r.status, 409); assert.equal(code(r), 'SLOT_UNKNOWN');
  assert.equal(writes(s) - w0, 0);
  // ลานจอดล่มทั้งก้อน (อ่านไม่ครบ) = 502 ไม่ใช่จองด้วยของเก่า
  s.mock.setTel({ hb: 1, 'slot_1-1': false }); await s.routes.lot.get(); s.mock.st.failDev['dev-lot'] = 500;
  r = await post(s, a, good({ i: 1 })); assert.equal(r.status, 502); assert.equal(code(r), 'UPSTREAM'); assert.match(r.body.error.message, /ไม่มีการตัดเงิน/);
  assert.equal(writes(s) - w0, 0);
}, { LOT_CACHE_MS: '600000', LOT_ATTR_MS: '600000' }, W));

test('จอง: ช่องปิด / มีรถจอดอยู่ = 409 SLOT_CLOSED / SLOT_OCCUPIED ไม่เขียน และ SLOT_TAKEN เมื่อมีการจองอยู่แล้ว (รวมของตัวเอง)', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const w0 = writes(s);
  s.mock.setAttr('closed', { '1-2': true }); s.mock.setTel({ 'slot_1-4': true });
  assert.equal(code(await post(s, a, good({ i: 2 }))), 'SLOT_CLOSED');
  assert.equal(code(await post(s, a, good({ i: 4 }))), 'SLOT_OCCUPIED');
  assert.equal(writes(s) - w0, 0);
  const ok = await post(s, a, good({ i: 5 })); assert.equal(ok.status, 201);
  const again = await post(s, a, good({ i: 5, car: 'กข1234' })); assert.equal(again.status, 409); assert.equal(code(again), 'SLOT_TAKEN');   // ของตัวเองก็ TAKEN
}, {}, W));

test('จอง: ลำดับรหัสตามตาราง AC-24 (ความแน่นอนมาก่อนความไม่แน่นอน)', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), other = await user(s, 'o@t.dev', ['ทต1']); const w0 = writes(s);
  // ช่องจองแล้ว + occ:null -> SLOT_TAKEN (ไม่ใช่ UNKNOWN)
  taken(s, '1-0', other.uid); s.mock.setTel({ 'slot_1-0': undefined });
  assert.equal(code(await post(s, a, good({ i: 0 }))), 'SLOT_TAKEN');
  // ช่องปิด + occ:null -> SLOT_CLOSED
  s.mock.setAttr('closed', { '1-1': true, '1-2': true, '1-6': true }); s.mock.setTel({ 'slot_1-1': undefined });
  assert.equal(code(await post(s, a, good({ i: 1 }))), 'SLOT_CLOSED');
  // ช่องปิด + ไม่มี telemetry -> SLOT_CLOSED (conflict ข้ามอุปกรณ์ไม่มีแล้ว: เจ้าของช่องคงที่ตาม config)
  assert.equal(code(await post(s, a, good({ i: 2 }))), 'SLOT_CLOSED');
  // occ:true ไม่มีจอง -> SLOT_OCCUPIED
  s.mock.setTel({ 'slot_1-4': true }); assert.equal(code(await post(s, a, good({ i: 4 }))), 'SLOT_OCCUPIED');
  // ช่องจองแล้ว + ปิด + มีรถ -> SLOT_TAKEN ก่อนทุกอย่าง
  taken(s, '1-6', other.uid); s.mock.setTel({ 'slot_1-6': true }); assert.equal(code(await post(s, a, good({ i: 6 }))), 'SLOT_TAKEN');
  // body ผิดรูป + ช่องจองแล้ว -> 400 (ตรวจรูปแบบก่อน)
  assert.equal(code(await post(s, a, { f: 1, i: 0, car: 'กข1234', pm: 'pp' })), 'BAD_INPUT');
  // NO_SLOT ก่อน reqId ซ้ำ: reqId เคยสำเร็จที่ช่อง 1-8 แล้วส่งซ้ำไปช่องนอก config
  const R = rid(); assert.equal((await post(s, a, good({ i: 8, reqId: R }))).status, 201);
  assert.equal(code(await post(s, a, good({ f: 9, i: 8, reqId: R }))), 'NO_SLOT');
  assert.equal(code(await post(s, a, good({ i: 9, reqId: R }))), 'REQ_REUSED');
  assert.equal(writes(s) - w0, 2);
}, { BOOK_RATE_MAX: '1000' }, W));

test('จอง: ช่องที่จองแล้วแต่ข้อมูลช่องหาย/บอร์ดหลุด ยังเป็น TAKEN ตลอด (ไม่ถูกตีเป็นว่าง)', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), o = await user(s, 'o@t.dev', ['ทต1']); taken(s, '1-1', o.uid);
  s.mock.setTel({ hb: 1 }, Date.now() - 500000); s.mock.setTel({ 'slot_1-1': false }, Date.now() - 500000);
  for (let n = 0; n < 3; n++) assert.equal(code(await post(s, a, good({ i: 1 }))), 'SLOT_TAKEN');
}, {}, W));

// ---------- AC-4 แย่งช่องเดียวกัน ----------
test('จอง: 20 ผู้ใช้ส่งพร้อมกันช่องเดียว (mock หน่วงสุ่ม) สำเร็จ 1 ที่เหลือ SLOT_TAKEN ไม่มี BUSY — 20 รอบ', run(async s => {
  seed(s); const users = []; for (let n = 0; n < 20; n++) users.push(await user(s, `u${n}@t.dev`));
  s.mock.st.delay = () => Math.floor(Math.random() * 4);
  for (let round = 0; round < 20; round++) {
    s.mock.setAttr('bk_1-1', []); for (const u of users) s.mock.st.attrs.set(u.uid, { ...s.mock.st.attrs.get(u.uid), books: [] });
    const rs = await Promise.all(users.map(u => post(s, u, good())));
    const ok = rs.filter(r => r.status === 201), lost = rs.filter(r => r.status === 409);
    assert.equal(ok.length, 1, 'รอบ ' + round + ' ' + JSON.stringify(rs.map(r => r.status)));
    assert.equal(lost.length, 19); assert.ok(lost.every(r => code(r) === 'SLOT_TAKEN'));
    assert.ok(!rs.some(r => code(r) === 'BUSY'));
    const ent = bk(s, '1-1'); assert.equal(ent.length, 1); assert.equal(ent[0].id, ok[0].body.booking.id);
    const owner = users.find(u => u.uid === ent[0].uid); assert.equal(s.mock.st.attrs.get(owner.uid).books.length, 1);
    for (const u of users) if (u !== owner) assert.deepEqual(s.mock.st.attrs.get(u.uid).books, []);
  }
}, { BOOK_RATE_MAX: '1000' }, W));

// ---------- AC-5 ----------
test('จอง: รถคันเดียวสองช่องพร้อมกัน สำเร็จ 1 อีกอัน CAR_BOOKED; ผู้ใช้อื่นจองด้วยทะเบียนเดียวกันได้ (ไม่รู้ว่ามีการจอง)', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev');
  s.mock.st.delay = () => Math.floor(Math.random() * 3);
  const rs = await Promise.all([post(s, a, good({ i: 1 })), post(s, a, good({ i: 2 }))]);
  assert.deepEqual(rs.map(r => r.status).sort(), [201, 409]); assert.equal(code(rs.find(r => r.status === 409)), 'CAR_BOOKED');
  const rb = await post(s, b, good({ i: 3 })); assert.equal(rb.status, 201);   // ทะเบียนเดียวกัน คนละบัญชี
}, {}, W));

test('จอง: เพดาน 3 ช่องต่อผู้ใช้ (ผู้ใช้มีรถ ≥ 4 คัน) = LIMIT ไม่ใช่ CAR_BOOKED; รถที่จองแล้ว = CAR_BOOKED ก่อน LIMIT', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev', ['กข1', 'กข2', 'กข3', 'กข4']);
  for (const [n, c] of ['กข1', 'กข2', 'กข3'].entries()) assert.equal((await post(s, a, good({ i: n, car: c }))).status, 201);
  const w0 = writes(s);
  const r = await post(s, a, good({ i: 5, car: 'กข4' })); assert.equal(r.status, 409); assert.equal(code(r), 'LIMIT');
  assert.equal(code(await post(s, a, good({ i: 6, car: 'กข1' }))), 'CAR_BOOKED');
  assert.equal(writes(s) - w0, 0);
}, { BOOK_RATE_MAX: '1000' }, W));

test('จอง: การจองของคนอื่นไม่นับเข้าเพดาน/ทะเบียนของเรา (ขอบเขตผู้ใช้เดียว SR-32)', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), o = await user(s, 'o@t.dev');
  for (let n = 0; n < 3; n++) taken(s, '1-' + (6 + n), o.uid, { car: 'กข1234' });
  assert.equal((await post(s, a, good({ i: 1 }))).status, 201);
}, {}, W));

// ---------- AC-6 / AC-22 reqId ----------
test('จอง: ส่ง reqId เดิมซ้ำ = 200 ผลเดิม (ไม่จองซ้ำ ไม่เขียนเพิ่ม); ซ้ำพร้อมกัน = รอผลเดียวกัน; payload ต่าง = 409 REQ_REUSED', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev', ['กข1234', 'กข5678']); const R = rid();
  const r1 = await post(s, a, good({ reqId: R })); assert.equal(r1.status, 201); const w1 = writes(s);
  const r2 = await post(s, a, good({ reqId: R })); assert.equal(r2.status, 200); assert.deepEqual(r2.body, r1.body);
  assert.equal(writes(s), w1); assert.equal(bk(s, '1-1').length, 1); assert.equal(s.mock.st.attrs.get(a.uid).books.length, 1);
  for (const diff of [{ i: 2 }, { f: 2 }, { pm: 'xx' }]) { const r = await post(s, a, good({ reqId: R, ...diff })); assert.ok(['REQ_REUSED', 'PAY_UNKNOWN'].includes(code(r)), JSON.stringify(diff)); }
  assert.equal(code(await post(s, a, good({ reqId: R, i: 2 }))), 'REQ_REUSED'); assert.equal(writes(s), w1);
  // พร้อมกัน
  const R2 = rid(); s.mock.st.delay = () => 3;
  const [x, y] = await Promise.all([post(s, a, good({ reqId: R2, i: 4, car: 'กข5678' })), post(s, a, good({ reqId: R2, i: 4, car: 'กข5678' }))]);
  assert.ok(x.status === 201 || y.status === 201); assert.deepEqual(x.body, y.body); assert.deepEqual([x.status, y.status].sort(), [200, 201].sort());
}, {}, W));

test('จอง: reqId ผูกกับผู้ใช้ — B ส่ง reqId เดียวกับ A ได้ผลของ B เอง ของ A ไม่เปลี่ยน', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev'); const R = rid();
  const ra = await post(s, a, good({ reqId: R, i: 1 })), rb = await post(s, b, good({ reqId: R, i: 2 }));
  assert.equal(ra.status, 201); assert.equal(rb.status, 201); assert.notEqual(ra.body.booking.id, rb.body.booking.id);
  assert.equal(rb.body.booking.i, 2); assert.equal(bk(s, '1-1')[0].uid, a.uid); assert.equal(bk(s, '1-2')[0].uid, b.uid);
  const again = await post(s, a, good({ reqId: R, i: 1 })); assert.equal(again.status, 200); assert.equal(again.body.booking.id, ra.body.booking.id);
}, {}, W));

test('จอง: หลังรีสตาร์ต (แคชหาย) reqId เดิม = 200 รายการเดิมผ่าน rq แม้จบไปแล้ว; payload ต่าง REQ_REUSED; เขียนครึ่งทางถูกเติมให้ครบ', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const R = rid();
  const r1 = await post(s, a, good({ reqId: R })); const w1 = writes(s);
  s.routes.bookings.clearReqCache();
  const r2 = await post(s, a, good({ reqId: R })); assert.equal(r2.status, 200); assert.equal(r2.body.booking.id, r1.body.booking.id); assert.equal(r2.body.receipt.no, r1.body.receipt.no); assert.equal(writes(s), w1);
  // รายการจบไปแล้ว (bk_ ถอน, books done) ก็ยังตอบผลเดิม ไม่จองใหม่
  s.mock.setAttr('bk_1-1', []); const bs = s.mock.st.attrs.get(a.uid); bs.books[0] = { ...bs.books[0], status: 'done', out: bs.books[0].s + 1000, min: 1, park: 0 };
  s.routes.bookings.clearReqCache();
  const r3 = await post(s, a, good({ reqId: R })); assert.equal(r3.status, 200); assert.equal(r3.body.booking.id, r1.body.booking.id); assert.equal(bk(s, '1-1').length, 0); assert.equal(writes(s), w1);
  s.routes.bookings.clearReqCache();
  assert.equal(code(await post(s, a, good({ reqId: R, i: 2 }))), 'REQ_REUSED'); assert.equal(writes(s), w1);
  // เขียน bk_ แล้วแต่ books ยังไม่มี (ดับกลางทาง) -> ส่ง reqId เดิม = เติม books ให้ครบ ตอบสำเร็จ ไม่ใช่ SLOT_TAKEN
  const R2 = rid(); const rq = rqOf(R2);
  s.mock.setAttr('bk_1-5', [{ id: 'b0000000000000abc', uid: a.uid, car: 'กข1234', s: Date.now(), e: Date.now() + 2592000000, status: 'active', amt: 20, pm: 'pp', rno: 'PH22222222', rq }]);
  const before = s.mock.st.attrs.get(a.uid).books.length;
  const r4 = await post(s, a, good({ reqId: R2, i: 5 })); assert.equal(r4.status, 200); assert.equal(r4.body.booking.id, 'b0000000000000abc');
  const after = s.mock.st.attrs.get(a.uid).books; assert.equal(after.length, before + 1); assert.equal(after[0].id, 'b0000000000000abc'); assert.equal(bk(s, '1-5').length, 1);
  // ทำซ้ำ: ไม่เพิ่มรายการ
  s.routes.bookings.clearReqCache(); await post(s, a, good({ reqId: R2, i: 5 })); assert.equal(s.mock.st.attrs.get(a.uid).books.length, before + 1);
}, { BOOK_RATE_MAX: '1000' }, W));

// ---------- AC-7 ล้มกลางทาง ----------
test('จอง: เขียน books ล้ม (หลังเขียน bk_) = 502 UPSTREAM "ไม่มีการตัดเงิน" และถอน bk_ ช่องว่างอีกครั้ง ไม่มีรายการ/ใบเสร็จ', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev');
  s.mock.st.failWrite = i => i.entity === 'USER' && i.keys.includes('books') ? 503 : 0;
  const r = await post(s, a, good()); assert.equal(r.status, 502); assert.equal(code(r), 'UPSTREAM'); assert.match(r.body.error.message, /ไม่มีการตัดเงิน \(ระบบจำลอง\)/);
  assert.deepEqual(bk(s, '1-1'), []); assert.equal((s.mock.st.attrs.get(a.uid).books || []).length, 0);
  s.mock.st.failWrite = null;
  assert.equal((await post(s, a, good())).status, 201);   // ช่องว่าง จองใหม่ได้
}, {}, W));

test('จอง: เขียน bk_ แล้วคำตอบหาย (TB เขียนแล้วแต่ตอบ error) = 502 และถอนกลับ', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); let first = true;
  s.mock.st.failWrite = i => { if (i.entity === 'ASSET' && first) { first = false; return { status: 504, apply: true }; } return 0; };
  const r = await post(s, a, good()); assert.equal(r.status, 502); assert.deepEqual(bk(s, '1-1'), []);
}, {}, W));

test('จอง: ถอนกลับล้มด้วย ต้องไม่ตอบว่าสำเร็จ; ส่ง reqId เดิมใหม่แล้วเติมให้ครบ (ไม่ใช่ SLOT_TAKEN) และ bk_ ที่ค้างไม่หายไปเอง', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const R = rid();
  s.mock.st.failWrite = i => (i.entity === 'USER' && i.keys.includes('books')) ? 503 : (i.entity === 'ASSET' && Array.isArray(i.body['bk_1-1']) && i.body['bk_1-1'].length === 0 ? 503 : 0);
  const r = await post(s, a, good({ reqId: R })); assert.equal(r.status, 502);
  assert.equal(bk(s, '1-1').length, 1, 'ถอนล้ม bk_ ค้าง ให้ตัวซ่อมเก็บ');
  s.mock.st.failWrite = null; s.routes.bookings.clearReqCache();
  const r2 = await post(s, a, good({ reqId: R })); assert.equal(r2.status, 200); assert.equal(r2.body.booking.id, bk(s, '1-1')[0].id);
}, {}, W));

test('จอง: อ่านกลับแล้วไม่ใช่ของเรา (กระบวนการอื่นทับ) = SLOT_TAKEN ไม่ย้อนเขียนทับของเขา', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), o = await user(s, 'o@t.dev', ['ทต1']);
  // จำลองกระบวนการอื่นเขียนทับช่องเดียวกันหลังเราเขียน (ก่อนที่เราอ่านกลับครั้งแรก)
  const origRead = s.routes.bookings.store.readBk; let n = 0;
  s.routes.bookings.store.readBk = async (f, i) => { const r = await origRead(f, i); if (++n === 1) { s.mock.st.assetAttrs['bk_1-1'] = [{ id: 'b00000000000000ff', uid: o.uid, car: 'ทต1', s: 1, e: 2592000002, status: 'active', amt: 20, pm: 'pp', rno: 'PH33333333', rq: 'abcdef999999' }]; return origRead(f, i); } return r; };
  const r = await post(s, a, good()); assert.equal(r.status, 409); assert.equal(code(r), 'SLOT_TAKEN');
  assert.equal(bk(s, '1-1')[0].uid, o.uid); assert.equal((s.mock.st.attrs.get(a.uid).books || []).length, 0);
  s.routes.bookings.store.readBk = origRead;
}, {}, W));

// ---------- AC-20 (ส่วนผู้ใช้) ----------
test('จอง: ครั้งที่ 11 ใน 1 นาที = 429 RATE_LIMIT + Retry-After ข้อความไทยบอกวินาที ไม่เขียน/ไม่เรียก TB เพิ่ม; ทุกคำขอที่ผ่าน auth นับ; พ้นหน้าต่างใช้ได้; ผู้ใช้อื่นไม่กระทบ', async () => {
  let clock = Date.now(); const now = () => clock;
  await run(async s => {
    seed(s); const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev');
    for (let n = 0; n < 10; n++) assert.equal((await post(s, a, { bad: 1 })).status, 400);   // 400 ก็นับ
    const calls = s.mock.st.calls.length, w = writes(s);
    const r = await post(s, a, good()); assert.equal(r.status, 429); assert.equal(code(r), 'RATE_LIMIT');
    assert.match(r.body.error.message, /ลองใหม่ใน \d+ วินาที/); assert.match(r.headers.get('retry-after'), /^\d+$/); assert.ok(+r.headers.get('retry-after') >= 1);
    assert.equal(writes(s), w); assert.ok(!s.mock.st.calls.slice(calls).some(c => /attributes|timeseries/.test(c.path)), 'ไม่เรียก TB อ่าน/เขียน');
    assert.equal((await post(s, b, good())).status, 201);
    clock += 61000; assert.equal((await post(s, a, good({ i: 2 }))).status, 201);
    assert.equal((await post(s, a, { bad: 1 })).status, 400);
  }, {}, { writesEnabled: true, now })();
});

// ---------- AC-23 staff + bookfee ----------
test('จอง: staff/master จองได้ด้วยกฎเดียวกับ member (เพดาน 3, 1 รถ ไม่ตรวจ role ตอนจอง)', run(async s => {
  seed(s); const st = await s.member('staff@t.dev'); s.mock.st.users.get(st.uid).customerId = { id: STAFF };
  assert.equal((await s.call('PUT', '/api/me', { token: st.token, body: { cars: [{ plate: 'สต1' }, { plate: 'สต2' }, { plate: 'สต3' }, { plate: 'สต4' }] } })).status, 200);
  const me = await s.call('GET', '/api/me', { token: st.token }); assert.equal(me.body.role, 'staff');
  for (const [n, c] of ['สต1', 'สต2', 'สต3'].entries()) assert.equal((await post(s, st, good({ i: n, car: c }))).status, 201);
  assert.equal(code(await post(s, st, good({ i: 5, car: 'สต4' }))), 'LIMIT'); assert.equal(code(await post(s, st, good({ i: 6, car: 'สต1' }))), 'CAR_BOOKED');
}, { BOOK_RATE_MAX: '1000' }, W));

// ---------- AC-25 สวิตช์เขียน + BUSY ----------
test('สวิตช์เขียน: ค่าเริ่มต้นปิด = 503 WRITES_DISABLED ก่อนเรียก ThingsBoard (ไม่อ่าน/ไม่เขียน) แต่ยังต้องผ่านตรวจตัวตนและเพดานก่อน', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'); const w0 = writes(s), reads = [s.mock.st.attrCalls, s.mock.st.telCalls, s.mock.st.userAttrReads];
  const r = await post(s, a, good()); assert.equal(r.status, 503); assert.equal(code(r), 'WRITES_DISABLED'); assert.match(r.body.error.message, /ไม่มีการตัดเงิน \(ระบบจำลอง\)/);
  assert.equal((await post(s, a, { junk: 1 })).status, 503, 'ปิดเขียนตอบก่อนตรวจรูปแบบ');
  assert.equal(writes(s), w0); assert.deepEqual([s.mock.st.attrCalls, s.mock.st.telCalls, s.mock.st.userAttrReads], reads);
  assert.equal((await s.call('POST', '/api/bookings', { body: good() })).status, 401);   // ไม่ล็อกอินยัง 401 ก่อน
  assert.equal((await s.call('GET', '/api/lot', { token: a.token })).status, 200);        // อ่านยังได้
}));

test('ล็อก: คิวเต็ม = 503 BUSY ไม่เขียน (ขีดจำกัดคิวตั้งผ่าน BOOK_QUEUE_MAX); ที่ผ่านคิวสำเร็จตามปกติ', run(async s => {
  seed(s); const us = []; for (let n = 0; n < 12; n++) us.push(await user(s, `q${n}@t.dev`));
  s.mock.st.delay = () => 8; const w0 = writes(s);
  const rs = await Promise.all(us.map((u, n) => post(s, u, good({ i: n }))));
  const busy = rs.filter(r => code(r) === 'BUSY'), ok = rs.filter(r => r.status === 201);
  assert.ok(busy.length >= 1 && ok.length >= 1); assert.equal(busy.length + ok.length, 12);
  assert.ok(busy.every(r => r.status === 503 && /ไม่มีการตัดเงิน/.test(r.body.error.message)));
  assert.equal(writes(s) - w0, ok.length * 2, 'คำขอที่ BUSY ไม่เขียนอะไร');
  // BUSY ส่งซ้ำด้วย reqId เดิมได้ (ไม่ถูกจำเป็นความล้มเหลว)
  s.mock.st.delay = null; const retry = await post(s, us[rs.findIndex(r => code(r) === 'BUSY')], good({ i: rs.findIndex(r => code(r) === 'BUSY') })); assert.equal(retry.status, 201);
}, { BOOK_QUEUE_MAX: '3', BOOK_RATE_MAX: '1000' }, W));

test('ล็อก: รอล็อกเกินกำหนด = 503 BUSY (BOOK_LOCK_WAIT_MS)', run(async s => {
  seed(s); const a = await user(s, 'a@t.dev'), b = await user(s, 'b@t.dev');
  s.mock.st.delay = () => 60;
  const [x, y] = await Promise.all([post(s, a, good({ i: 1 })), post(s, b, good({ i: 2 }))]);
  const rs = [x, y]; assert.equal(rs.filter(r => r.status === 201).length, 1); assert.equal(rs.filter(r => code(r) === 'BUSY' && r.status === 503).length, 1);
}, { BOOK_LOCK_WAIT_MS: '100', BOOK_RATE_MAX: '1000' }, W));

// ---------- รูปแบบ error ----------
test('ทุก error ของ API มี error.code (404 ไม่พบ, 405, JSON เสีย, ใหญ่เกิน, origin ต้องห้าม, 401, 429)', run(async s => {
  const a = await user(s, 'a@t.dev');
  const cases = [
    await s.call('GET', '/api/nope'), await s.call('GET', '/api/bookings', { token: a.token }), await s.call('PUT', '/api/lot', { token: a.token }),
    await fetch(s.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }),
    await fetch(s.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(20000) }) }),
    await s.call('GET', '/healthz', { headers: { Origin: 'https://evil.example' } }), await s.call('POST', '/api/bookings', { body: good() }),
  ];
  for (const r of cases) { const j = typeof r.json === 'function' ? await r.json() : r.body; assert.ok(j.error && typeof j.error.code === 'string' && j.error.code && typeof j.error.message === 'string', JSON.stringify(j)); }
}, {}, W));

// ---------- ไม่มี console รั่ว ----------
test('จอง: ไม่ log ข้อมูลส่วนตัว (ทะเบียน/uid/เลขบัตร) ระหว่างจองและล้มเหลว', async () => {
  const lines = []; const o = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(o)) console[k] = (...a) => lines.push(a.join(' '));
  try {
    await run(async s => {
      seed(s); const a = await user(s, 'a@t.dev'); await post(s, a, good({ car: '4111111111111111' })); await post(s, a, good());
      s.mock.st.failWrite = () => 503; await post(s, a, good({ i: 3 }));
      assert.ok(!lines.join('\n').match(/กข1234|4111|a@t\.dev/), lines.join('\n').slice(0, 400));
    }, {}, W)();
  } finally { Object.assign(console, o); }
});
