// M5 B1: PUT /api/admin/closed, PUT /api/admin/config, D5 ของไม้กั้น บน mock-tb เท่านั้น (AC-M5-1..9, 13, 15 ส่วน API)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run, sleep, until, STAFF, MEMBERS } = require('./harness');
const { DEVICE_ID } = require('./mock-tb');

const ENV = { BOOK_SWEEP_DELAY_MS: '0', BOOK_RECON_DELAY_MS: '0', LOT_CACHE_MS: '0', LOT_ATTR_MS: '0', BARRIER_COOLDOWN_MS: '0', BARRIER_RATE_MAX: '1000', BARRIER_ADMIN_RATE_MAX: '1000', ADMIN_WRITE_RATE_MAX: '1000', ADMIN_LIST_RATE_MAX: '1000' };
const W = { writesEnabled: true, barrierEnabled: true };
const code = r => r.body && r.body.error && r.body.error.code;
const CFG = { floors: 2, slots: 8, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 };
const rid = () => 'req-' + crypto.randomUUID();
const seed = (s, over = {}, cfg = {}) => {
  s.mock.setAttr('config', { ...CFG, ...cfg });
  const t = { hb: 1 }; for (let f = 1; f <= 2; f++) for (let i = 0; i < 8; i++) { t[`slot_${f}-${i}`] = false; t[`bar_${f}-${i}`] = 0; }
  s.mock.setTel({ ...t, ...over }, Date.now());
};
const staffOf = async (s, email = 'staff@t.dev') => { const st = await s.member(email); s.mock.st.users.get(st.uid).customerId = { id: STAFF }; return st; };
const masterOf = async (s, email = 'master@t.dev') => { const m = await s.member(email); s.mock.st.users.get(m.uid).authority = 'TENANT_ADMIN'; return m; };
const carUser = async (s, email, plate = 'กข1234') => { const u = await s.member(email); assert.equal((await s.call('PUT', '/api/me', { token: u.token, body: { cars: [{ plate }] } })).status, 200); return u; };
const closed = (s, u, body) => s.call('PUT', '/api/admin/closed', { token: u.token, body });
const config = (s, u, body) => s.call('PUT', '/api/admin/config', { token: u.token, body });
const book = (s, u, body = {}) => s.call('POST', '/api/bookings', { token: u.token, body: { f: 1, i: 1, car: 'กข1234', pm: 'pp', reqId: rid(), ...body } });
const wr = s => s.mock.st.wr.length;
const adm = (s, u, body) => s.call('POST', '/api/admin/barrier', { token: u.token, body });

test('AC-M5-1 member: ทั้งสอง PUT = 403 FORBIDDEN ไบต์เดียวกันทุกกรณี (แม้ body ผิด) เขียน 0 RPC 0; ไม่มีโทเคน = 401', run(async s => {
  seed(s); const a = await s.member('a@t.dev');
  const bodies = [{ set: { '1-2': true } }, {}, undefined, { role: 'staff' }, { set: { __proto__x: 1 } }];
  const outs = [];
  for (const b of bodies) for (const fn of [closed, config]) { const r = await fn(s, a, b); assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN'); outs.push(r.raw); }
  assert.equal(new Set(outs).size, 1, 'ไบต์ต้องเหมือนกันทุกกรณี');
  assert.equal(wr(s) - 1, 0, 'ไม่มีการเขียน asset (1 = การเขียน PUT /api/me ของ carUser ไม่ได้ใช้ที่นี่)');
  assert.equal(s.mock.st.wr.filter(x => x.entity === 'ASSET').length, 0); assert.equal(s.mock.rpcCount(), 0);
  assert.equal((await s.call('PUT', '/api/admin/closed', { body: { set: { '1-2': true } } })).status, 401);
  assert.equal((await s.call('PUT', '/api/admin/config', { body: { rate: 25 } })).status, 401);
}, ENV, W));

test('AC-M5-2 ไม่เชื่อ cache: ถอดสิทธิ์ staff แล้ว 403 ทันที (authCache ยังเป็น staff)', run(async s => {
  seed(s); const st = await staffOf(s);
  assert.equal((await closed(s, st, { set: { '1-2': true } })).status, 200);   // authCache เก็บ role staff แล้ว
  s.mock.st.users.get(st.uid).customerId = { id: MEMBERS };
  for (const r of [await closed(s, st, { set: { '1-3': true } }), await config(s, st, { rate: 25 })]) { assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN'); }
  assert.deepEqual(s.mock.st.assetAttrs.closed, { '1-2': true }); assert.equal(s.mock.st.assetAttrs.config.rate, 20);
}, ENV, W));

test('AC-M5-2 ถอดสิทธิ์ระหว่างรอคิวล็อก: ตรวจซ้ำในล็อก = 403 ไม่เขียน', run(async s => {
  seed(s); const st = await staffOf(s);
  for (const [fn, body] of [[closed, { set: { '1-2': true } }], [config, { rate: 25 }]]) {
    let release; const held = new Promise(r => { release = r; });
    const holder = s.routes.bookings.mutex.run(() => held);   // ถือล็อกไว้
    const w0 = s.mock.st.wr.filter(x => x.entity === 'ASSET').length;
    const pending = fn(s, st, body);
    await sleep(150);   // ผ่าน authFresh แล้ว กำลังรอคิว
    s.mock.st.users.get(st.uid).customerId = { id: MEMBERS };
    release(); await holder;
    const r = await pending; assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN');
    assert.equal(s.mock.st.wr.filter(x => x.entity === 'ASSET').length, w0);
    s.mock.st.users.get(st.uid).customerId = { id: STAFF };
  }
  assert.equal(s.mock.st.assetAttrs.closed, undefined);
}, ENV, W));

test('AC-M5-2 body อ้าง role/uid/authFresh = 400 BAD_INPUT ไม่มีผล', run(async s => {
  seed(s); const st = await staffOf(s);
  for (const extra of [{ role: 'master' }, { uid: 'x' }, { authFresh: true }]) {
    let r = await closed(s, st, { set: { '1-2': true }, ...extra }); assert.equal(r.status, 400); assert.equal(code(r), 'BAD_INPUT');
    r = await config(s, st, { rate: 25, ...extra }); assert.equal(r.status, 400); assert.equal(code(r), 'BAD_INPUT');
  }
  assert.equal(s.mock.st.wr.filter(x => x.entity === 'ASSET').length, 0);
}, ENV, W));

test('AC-M5-3 ปิด/เปิดช่อง: lot, จอง SLOT_CLOSED, SSE closed, เปิดแล้วจองได้ คีย์ถูกลบ; การจองเดิมไม่ถูกยกเลิก', run(async s => {
  seed(s); const st = await staffOf(s), u = await carUser(s, 'u@t.dev');
  const live = await s.sse(u.token); await live.wait('snapshot');
  let r = await closed(s, st, { set: { '1-2': true } });
  assert.equal(r.status, 200, r.raw); assert.deepEqual(r.body.closed, { '1-2': true }); assert.equal(typeof r.body.serverNow, 'number');
  assert.deepEqual(s.mock.st.assetAttrs.closed, { '1-2': true });
  const ev = await live.wait('closed', d => d.closed['1-2'] === true); assert.deepEqual(ev.data.closed, { '1-2': true });
  const lot = await s.call('GET', '/api/lot', { token: u.token }); assert.equal(lot.body.closed['1-2'], true); assert.equal(lot.body.slots.find(x => x.k === '1-2').closed, true);
  r = await book(s, u, { i: 2 }); assert.equal(r.status, 409); assert.equal(code(r), 'SLOT_CLOSED');
  r = await closed(s, st, { set: { '1-2': false } }); assert.equal(r.status, 200); assert.deepEqual(r.body.closed, {});
  assert.deepEqual(s.mock.st.assetAttrs.closed, {}, 'คีย์ที่เปิดแล้วถูกลบ ไม่เก็บ false');
  await live.wait('closed', d => !d.closed['1-2']);
  r = await book(s, u, { i: 2 }); assert.equal(r.status, 201, r.raw);
  r = await closed(s, st, { set: { '1-2': true, '1-3': true } }); assert.equal(r.status, 200);   // ช่อง 1-2 มีการจองอยู่
  assert.equal(s.mock.st.assetAttrs['bk_1-2'].length, 1); assert.equal(s.mock.st.assetAttrs['bk_1-2'][0].status, 'active');
  assert.equal((await s.call('GET', '/api/me/bookings', { token: u.token })).body.books[0].status, 'active');
  live.close();
}, ENV, W));

test('AC-M5-3 ซ้ำคำขอเดิม = ผลเดิมไม่เขียนซ้ำ (idempotent); master ทำได้', run(async s => {
  seed(s); const m = await masterOf(s);
  assert.equal((await closed(s, m, { set: { '2-1': true } })).status, 200);
  const n = s.mock.st.wr.filter(x => x.entity === 'ASSET').length;
  const r = await closed(s, m, { set: { '2-1': true, '2-2': false } }); assert.equal(r.status, 200); assert.deepEqual(r.body.closed, { '2-1': true });
  assert.equal(s.mock.st.wr.filter(x => x.entity === 'ASSET').length, n);
}, ENV, W));

test('AC-M5-4 closed: รูปแบบผิด/นอกช่วง = 400/404 ไม่เขียน ไม่เป็น 500', run(async s => {
  seed(s); const st = await staffOf(s);
  const bad400 = [undefined, null, [], 'x', {}, { set: {} }, { set: [] }, { set: ['1-2'] }, { set: 'x' }, { set: null }, { set: { x: true } }, { set: { '1-2': 1 } }, { set: { '1-2': 'true' } }, { set: { '1-2': null } },
    { set: { '01-2': true } }, { set: { '0-1': true } }, { set: { '1--1': true } }, { set: { '1-2 ': true } }, { set: { '1-2-3': true } }, { set: { '1-1000': true } }, { set: { '100-1': true } },
    JSON.parse('{"set":{"__proto__":true}}'), JSON.parse('{"set":{"constructor":true}}'), { set: Object.fromEntries(Array.from({ length: 121 }, (_, n) => [`1-${n}`, true])) }, { set: { '1-2': true }, x: 1 }];
  for (const b of bad400) { const r = await closed(s, st, b); assert.equal(r.status, 400, JSON.stringify(b) && JSON.stringify(b).slice(0, 80) + ' -> ' + r.status); assert.equal(code(r), 'BAD_INPUT'); }
  for (const b of [{ set: { '1-99': true } }, { set: { '3-0': true } }, { set: { '1-8': true } }, { set: { '1-2': true, '9-9': true } }]) { const r = await closed(s, st, b); assert.equal(r.status, 404, JSON.stringify(b)); assert.equal(code(r), 'NO_SLOT'); }
  assert.equal(s.mock.st.wr.filter(x => x.entity === 'ASSET').length, 0); assert.equal(s.mock.st.assetAttrs.closed, undefined);
  assert.equal({}.x, undefined, 'prototype ไม่ถูกปนเปื้อน');
}, ENV, W));

test('AC-M5-5 config: merge, GET /api/lot ได้ค่าใหม่, จองใหม่คิดยอดจาก pricing ตามค่าใหม่, การจองเดิมยอดไม่เปลี่ยน, ค่าที่ไม่ส่งคงเดิม, SSE config', run(async s => {
  seed(s); const st = await staffOf(s), u = await carUser(s, 'u@t.dev'), u2 = await carUser(s, 'u2@t.dev', 'กข5678');
  const live = await s.sse(u.token); await live.wait('snapshot');
  const old = await book(s, u, { i: 1 }); assert.equal(old.status, 201); assert.equal(old.body.booking.amt, 20);
  const r = await config(s, st, { rate: 25, freemin: 20, bookfee: 35 });
  assert.equal(r.status, 200, r.raw); assert.deepEqual(r.body.config, { ...CFG, rate: 25, freemin: 20, bookfee: 35 });
  assert.deepEqual(s.mock.st.assetAttrs.config, { ...CFG, rate: 25, freemin: 20, bookfee: 35 });
  await live.wait('config', d => d.config.rate === 25);
  const lot = await s.call('GET', '/api/lot', { token: u.token }); assert.deepEqual([lot.body.config.rate, lot.body.config.freemin, lot.body.config.bookfee, lot.body.config.noshow, lot.body.config.floors], [25, 20, 35, 30, 2]);
  const nu = await book(s, u2, { i: 2, car: 'กข5678' }); assert.equal(nu.status, 201); assert.equal(nu.body.booking.amt, 35, 'ค่าจองใหม่จาก bookfee ใหม่ผ่าน pricing.js');
  assert.equal(s.mock.st.assetAttrs['bk_1-1'][0].amt, 20, 'การจองเดิมยอดไม่ถูกคิดใหม่');
  const mine = await s.call('GET', '/api/me/bookings', { token: u.token }); assert.equal(mine.body.books[0].amt, 20);
  live.close();
}, ENV, W));

test('AC-M5-5 ซ้ำคำขอเดิม = ไม่เขียนซ้ำ; master ทำได้; ใส่ค่าครบทั้ง 6 ช่อง', run(async s => {
  seed(s); const m = await masterOf(s);
  let r = await config(s, m, { rate: 30, bookfee: 10, freemin: 15, floors: 3, slots: 10, noshow: 45 }); assert.equal(r.status, 200, r.raw);
  assert.deepEqual(s.mock.st.assetAttrs.config, { floors: 3, slots: 10, rate: 30, penalty: 20, bookfee: 10, freemin: 15, noshow: 45 });
  const n = s.mock.st.wr.filter(x => x.entity === 'ASSET').length;
  r = await config(s, m, { rate: 30 }); assert.equal(r.status, 200); assert.equal(s.mock.st.wr.filter(x => x.entity === 'ASSET').length, n);
  r = await config(s, m, { freemin: 0, noshow: 0, bookfee: 0 }); assert.equal(r.status, 200); assert.equal(r.body.config.freemin, 0);   // 0 ได้ยกเว้น rate
}, ENV, W));

test('AC-M5-6 config ไม่ถูกต้อง: 400 BAD_INPUT ไม่เขียน (rate=0, ติดลบ, สตริง, ทศนิยม, NaN, 1e9, array, penalty, floors 0, slots 61 ฯลฯ)', run(async s => {
  seed(s); const st = await staffOf(s);
  const bad = [undefined, null, [], 'x', {}, { rate: 0 }, { rate: -1 }, { rate: '20' }, { rate: 20.5 }, { rate: 1e9 }, { rate: 100001 }, { rate: [20] }, { rate: { a: 1 } }, { rate: null }, { rate: true }, { rate: '' },
    { penalty: 5 }, { floors: 0 }, { floors: 11 }, { slots: 0 }, { slots: 61 }, { floors: 1.5 }, { freemin: -1 }, { freemin: 1441 }, { noshow: 1441 }, { bookfee: -5 }, { bookfee: 100001 }, { x: 1 },
    { rate: 25, penalty: 1 }, { rate: 25, floors: 0 }, JSON.parse('{"__proto__":{"rate":5}}'), JSON.parse('{"rate":1e999}')];
  for (const b of bad) { const r = await config(s, st, b); assert.equal(r.status, 400, JSON.stringify(b) + ' -> ' + r.status); assert.equal(code(r), 'BAD_INPUT'); }
  assert.equal(s.mock.st.wr.filter(x => x.entity === 'ASSET').length, 0); assert.equal(s.mock.st.assetAttrs.config.rate, 20);
}, ENV, W));

test('AC-M5-7 ลดชั้น/ช่องที่มีการจอง active ในส่วนที่หาย = 409 CONFIG_HAS_BOOKINGS ไม่เขียน; ไม่มีการจองในส่วนที่หาย = 200', run(async s => {
  seed(s); const st = await staffOf(s), u = await carUser(s, 'u@t.dev');
  assert.equal((await book(s, u, { f: 2, i: 5 })).status, 201);
  let r = await config(s, st, { slots: 5 }); assert.equal(r.status, 409); assert.equal(code(r), 'CONFIG_HAS_BOOKINGS'); assert.match(r.body.error.message, /1 รายการ/);
  r = await config(s, st, { floors: 1 }); assert.equal(r.status, 409); assert.equal(code(r), 'CONFIG_HAS_BOOKINGS');
  assert.equal(s.mock.st.assetAttrs.config.slots, 8); assert.equal(s.mock.st.assetAttrs.config.floors, 2);
  r = await config(s, st, { slots: 6 }); assert.equal(r.status, 200, r.raw);   // ช่อง 5 (index) ยังอยู่ (i < 6)
  r = await config(s, st, { slots: 5, floors: 2 }); assert.equal(r.status, 409);
  r = await config(s, st, { slots: 10, floors: 3 }); assert.equal(r.status, 200);   // ขยายได้เสมอ
}, ENV, W));

test('AC-M5-7 ลดโดยที่ช่องที่หายมีแต่การจองที่จบแล้ว = ผ่าน', run(async s => {
  seed(s); const st = await staffOf(s);
  s.mock.setAttr('bk_1-7', [{ id: 'bold1', uid: 'u1', car: 'x', s: Date.now() - 1e6, e: Date.now() + 1e6, status: 'done' }]);
  assert.equal((await config(s, st, { slots: 4 })).status, 200);
}, ENV, W));

test('AC-M5-8 ล็อกร่วมกับการจอง: จองชน ปิดช่อง พร้อมกัน ผลเรียงตามล็อก ไม่มีสถานะครึ่งๆ', run(async s => {
  seed(s); const st = await staffOf(s), u = await carUser(s, 'u@t.dev');
  s.mock.st.delay = () => 25;   // หน่วงทุกคำขอ mock ให้ซ้อนกัน
  const [rb, rc] = await Promise.all([book(s, u, { i: 3 }), closed(s, st, { set: { '1-3': true } })]);
  s.mock.st.delay = null;
  assert.equal(rc.status, 200);
  const bk = s.mock.st.assetAttrs['bk_1-3'], cl = s.mock.st.assetAttrs.closed;
  assert.equal(cl['1-3'], true);
  if (rb.status === 201) { assert.equal(bk.length, 1); assert.equal(bk[0].status, 'active'); assert.equal(s.mock.st.attrs.get(u.uid).books.length, 1); }   // จองก่อนปิด: การจองเดิมอยู่
  else { assert.equal(rb.status, 409); assert.equal(code(rb), 'SLOT_CLOSED'); assert.ok(!bk || bk.length === 0); assert.ok(!(s.mock.st.attrs.get(u.uid) || {}).books || s.mock.st.attrs.get(u.uid).books.length === 0); }
  const again = await book(s, u, { i: 3, car: 'กข1234' }); assert.ok([409].includes(again.status) || again.status === 200, 'จองซ้ำหลังปิดต้องไม่ได้ช่องใหม่');
}, ENV, W));

test('AC-M5-8 ปิดช่องมาก่อน แล้วจอง = SLOT_CLOSED เสมอ (เรียงตามล็อกทั้งสองทิศ)', run(async s => {
  seed(s); const st = await staffOf(s), u = await carUser(s, 'u@t.dev');
  let release; const held = new Promise(r => { release = r; });
  const holder = s.routes.bookings.mutex.run(() => held);
  const pc = closed(s, st, { set: { '1-4': true } }); await sleep(120);
  const pb = book(s, u, { i: 4 }); await sleep(120);   // คิวหลัง closed
  release(); await holder;
  const [rc, rb] = await Promise.all([pc, pb]);
  assert.equal(rc.status, 200); assert.equal(rb.status, 409); assert.equal(code(rb), 'SLOT_CLOSED');
}, ENV, W));

test('AC-M5-9 writes ปิด (ค่าเริ่มต้น): ทั้งสอง PUT ตอบ 503 WRITES_DISABLED เขียน 0; member ยัง 403 ก่อน', run(async s => {
  seed(s); const st = await staffOf(s), a = await s.member('a@t.dev');
  for (const [fn, b] of [[closed, { set: { '1-2': true } }], [config, { rate: 25 }], [closed, undefined], [config, undefined]]) {
    const r = await fn(s, st, b); assert.equal(r.status, 503); assert.equal(code(r), 'WRITES_DISABLED');
    assert.equal((await fn(s, a, b)).status, 403);
  }
  assert.equal(s.mock.st.wr.filter(x => x.entity === 'ASSET').length, 0);
}, ENV, { writesEnabled: false }));

test('AC-M5-12 เพดานเขียน 20/นาที/uid (รวมสองทาง) ครั้งที่ 21 = 429 RATE_LIMIT + Retry-After; ผู้ใช้อื่นไม่โดน', run(async s => {
  seed(s); const st = await staffOf(s), m = await masterOf(s);
  for (let n = 0; n < 20; n++) { const r = await (n % 2 ? config : closed)(s, st, n % 2 ? { rate: 20 + (n % 3) } : { set: { '1-1': !!(n % 4) } }); assert.equal(r.status, 200, 'n=' + n + ' ' + r.raw); }
  const r = await closed(s, st, { set: { '1-1': true } }); assert.equal(r.status, 429); assert.equal(code(r), 'RATE_LIMIT'); assert.ok(+r.headers.get('retry-after') >= 1);
  assert.equal((await closed(s, m, { set: { '1-1': true } })).status, 200);
}, { ...ENV, ADMIN_WRITE_RATE_MAX: '20' }, W));

test('O1 CONFIG_MASTER_ONLY=1: staff แก้ config = 403 (closed ยังได้), master ได้; ค่าเริ่มต้น staff ได้', run(async s => {
  seed(s); const st = await staffOf(s), m = await masterOf(s);
  let r = await config(s, st, { rate: 25 }); assert.equal(r.status, 403); assert.equal(code(r), 'FORBIDDEN');
  assert.equal((await closed(s, st, { set: { '1-1': true } })).status, 200);
  assert.equal((await config(s, m, { rate: 25 })).status, 200); assert.equal(s.mock.st.assetAttrs.config.rate, 25);
}, { ...ENV, CONFIG_MASTER_ONLY: '1' }, W));

test('ThingsBoard เขียนล้ม = 502 UPSTREAM ข้อความไทย สถานะไม่เปลี่ยน ลองซ้ำสำเร็จ (idempotent)', run(async s => {
  seed(s); const st = await staffOf(s);
  let fail = true; s.mock.st.failWrite = info => (fail && info.entity === 'ASSET' ? 500 : null);
  for (const [fn, b] of [[closed, { set: { '1-2': true } }], [config, { rate: 25 }]]) {
    const r = await fn(s, st, b); assert.equal(r.status, 502); assert.equal(code(r), 'UPSTREAM'); assert.match(r.body.error.message, /ลองใหม่/);
  }
  assert.equal(s.mock.st.assetAttrs.closed, undefined); assert.equal(s.mock.st.assetAttrs.config.rate, 20);
  assert.equal((await s.call('GET', '/api/lot', { token: st.token })).body.closed['1-2'], undefined);
  fail = false;
  assert.equal((await closed(s, st, { set: { '1-2': true } })).status, 200); assert.equal((await config(s, st, { rate: 25 })).status, 200);
  assert.equal(s.mock.st.assetAttrs.closed['1-2'], true); assert.equal(s.mock.st.assetAttrs.config.rate, 25);
}, ENV, W));

test('log หนึ่งบรรทัดต่อการเขียน: มี ชนิด role uid ย่อ ผล; ไม่มีอีเมล/uid เต็ม/ทะเบียน/id การจอง', async () => {
  const lines = [];
  await run(async s => {
    seed(s); const st = await staffOf(s, 'secretstaff@t.dev'), a = await s.member('a@t.dev');
    await closed(s, st, { set: { '1-2': true } }); await config(s, st, { rate: 25 }); await closed(s, a, { set: { '1-2': true } }); await config(s, st, { rate: 0 });
    assert.equal(lines.length, 3);   // L3: member ถูกปฏิเสธไม่ log
    assert.match(lines[0], /\[admin\] \S+ closed staff u=[0-9a-f]{8} ok$/); assert.match(lines[1], /config staff u=[0-9a-f]{8} ok$/);
    assert.match(lines[2], /rejected:BAD_INPUT$/);
    const all = lines.join('\n'); assert.ok(!all.includes('secretstaff') && !all.includes(st.uid) && !all.includes(a.uid) && !all.includes('@'));
  }, ENV, { ...W, adminLog: l => lines.push(l) })();
});

// ---------- D5 (AC-M5-13) ----------
test('AC-M5-13 D5: ลด (down:true) ตอน occ===null ปฏิเสธ 409 SLOT_UNKNOWN แม้ force; RPC 0', run(async s => {
  seed(s, { 'slot_1-1': undefined }); const st = await staffOf(s);
  s.mock.setTel({ 'bar_1-1': 0 });   // ช่อง 1-1 มี bar_ แต่ไม่มี slot_ -> เจ้าของช่องมีแต่ occ ไม่ทราบ
  for (const force of [undefined, false, true]) { const r = await adm(s, st, { f: 1, i: 1, down: true, ...(force === undefined ? {} : { force }) }); assert.equal(r.status, 409, 'force=' + force); assert.equal(code(r), 'SLOT_UNKNOWN'); }
  assert.equal(s.mock.rpcCount(), 0);
}, ENV, W));

test('AC-M5-13 D5: บอร์ดออฟไลน์ (occ null) ลดไม่ได้แม้ force; ยกต้อง force (409 SLOT_OCCUPIED ถ้าไม่ force) แล้วส่งได้', run(async s => {
  seed(s, { 'bar_1-1': 1 }); const st = await staffOf(s);
  s.mock.setTel({ hb: 1 }, Date.now() - 600000);   // hb เก่า = ออฟไลน์ -> occ null
  s.mock.setTel({ 'slot_1-1': false, 'bar_1-1': 1 }, Date.now() - 600000);
  let r = await adm(s, st, { f: 1, i: 1, down: true, force: true }); assert.equal(r.status, 409); assert.equal(code(r), 'SLOT_UNKNOWN');
  r = await adm(s, st, { f: 1, i: 1, down: false }); assert.equal(r.status, 409); assert.equal(code(r), 'SLOT_OCCUPIED');
  assert.equal(s.mock.rpcCount(), 0);
  r = await adm(s, st, { f: 1, i: 1, down: false, force: true }); assert.equal(r.status, 200); assert.equal(r.body.sent, true);
  assert.equal(s.mock.rpcCount(), 1); assert.deepEqual(s.mock.st.rpc[0].params, { slot: '1-1', down: false });
}, ENV, W));

test('AC-M5-13 D5: occ:true ไม่ force = SLOT_OCCUPIED, force ได้; RPC มีแค่ slot,down', run(async s => {
  seed(s, { 'slot_1-2': true }); const st = await staffOf(s);
  let r = await adm(s, st, { f: 1, i: 2, down: true }); assert.equal(code(r), 'SLOT_OCCUPIED'); assert.equal(s.mock.rpcCount(), 0);
  r = await adm(s, st, { f: 1, i: 2, down: true, force: true }); assert.equal(r.status, 200); assert.deepEqual(Object.keys(s.mock.st.rpc[0].params).sort(), ['down', 'slot']);
}, ENV, W));

// ---------- ข้อเสนอ T0 (M5-data.md 2.2, 2.3) ----------
test('T0 config: เขียนครบ 7 คีย์ penalty ไม่หาย คีย์แปลกคงไว้; ไม่มี config เลย = เริ่มจากค่าเริ่มต้นได้', run(async s => {
  seed(s); const st = await staffOf(s);
  s.mock.setAttr('config', { floors: 2, slots: 8, rate: 20, bookfee: 20, freemin: 30, noshow: 30, penalty: 77, extra: 'keep' });
  assert.equal((await config(s, st, { rate: 25 })).status, 200);
  assert.deepEqual(s.mock.st.assetAttrs.config, { floors: 2, slots: 8, rate: 25, bookfee: 20, freemin: 30, noshow: 30, penalty: 77, extra: 'keep' });
  s.mock.setAttr('config', undefined);
  const r = await config(s, st, { rate: 30 }); assert.equal(r.status, 200, r.raw);
  assert.deepEqual(Object.keys(s.mock.st.assetAttrs.config).sort(), ['bookfee', 'floors', 'freemin', 'noshow', 'penalty', 'rate', 'slots']); assert.equal(s.mock.st.assetAttrs.config.rate, 30);
}, ENV, W));

test('T0 config เดิมอ่านไม่ออก (สตริงเสีย/ตัวเลข/array) = 409 CONFIG_UNREADABLE ไม่เขียนทับ; สตริง JSON ที่ถูกต้องอ่านได้', run(async s => {
  seed(s); const st = await staffOf(s);
  for (const bad of ['{not json', 42, [1, 2], 'null']) {
    s.mock.setAttr('config', bad);
    const r = await config(s, st, { rate: 25 }); assert.equal(r.status, 409, JSON.stringify(bad)); assert.equal(code(r), 'CONFIG_UNREADABLE');
    assert.deepEqual(s.mock.st.assetAttrs.config, bad);
  }
  assert.equal(s.mock.st.wr.filter(x => x.entity === 'ASSET').length, 0);
  s.mock.setAttr('config', JSON.stringify(CFG));
  assert.equal((await config(s, st, { rate: 25 })).status, 200); assert.equal(s.mock.st.assetAttrs.config.rate, 25);
}, ENV, W));

test('T0 ลดขนาดแล้วตัด closed นอกช่วง; ขยายกลับแล้วช่องนั้นไม่กลับมาปิดเอง; เขียน closed ก็ตัดคีย์นอกช่วง', run(async s => {
  seed(s); const st = await staffOf(s);
  assert.equal((await closed(s, st, { set: { '1-1': true, '1-6': true, '2-7': true } })).status, 200);
  assert.equal((await config(s, st, { slots: 4 })).status, 200);
  assert.deepEqual(s.mock.st.assetAttrs.closed, { '1-1': true });
  assert.equal((await config(s, st, { slots: 8 })).status, 200);
  assert.deepEqual((await s.call('GET', '/api/lot', { token: st.token })).body.closed, { '1-1': true });
  s.mock.setAttr('closed', { '1-1': true, '1-7': true, '2-7': true }); s.mock.setAttr('config', { ...CFG, slots: 4 });
  const r = await closed(s, st, { set: { '1-2': true } }); assert.equal(r.status, 200); assert.deepEqual(r.body.closed, { '1-1': true, '1-2': true });
}, ENV, W));
