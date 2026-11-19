// M3 B1: pricing (golden + parity), ล็อกเดียว, store (ใบเสร็จ/เพดาน/allowlist), lot (arr/สถานะ/fresh), สวิตช์เขียน (mock เท่านั้น)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('../pricing');
const { createMutex, ApiError } = require('../lib');
const S = require('../store');
const { normalizeBookings } = require('../lot');
const { loadConfig } = require('../config');
const { run, sleep } = require('./harness');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const golden = require(path.join(ROOT, 'tests', 'pricing', 'golden.json'));

// ---------- pricing (AC-14) ----------
test('pricing: ผ่าน tests/pricing/golden.json ไฟล์เดียว ทุกเซลล์ ผ่าน check-golden.js กับ adapter-pricing.js', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tests', 'pricing', 'check-golden.js'), path.join(__dirname, 'adapter-pricing.js')], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /^ผ่าน: \d+ เซลล์ตรงกับ golden\.json/);
});

test('pricing: parity กับสูตรฝั่งเว็บ (adapter-current user) price(0..600) และ fee ทุกแถวของ golden เท่ากัน', () => {
  const cur = require(path.join(ROOT, 'tests', 'pricing', 'adapter-current.js')).impls.user;
  const api = require('./adapter-pricing').impls.api;
  let cells = 0;
  for (const c of golden.cases) {
    const a = api.load(c.raw), u = cur.load(c.raw);
    assert.deepEqual(a.effective, { rate: u.effective.rate, freemin: u.effective.freemin, bookfee: u.effective.bookfee }, c.name);
    for (let m = 0; m <= 600; m++) { assert.equal(a.price(m), u.price(m), `${c.name} price(${m})`); assert.equal(a.fee(m * 60000), u.fee(m * 60000), `${c.name} fee(${m})`); cells += 2; }
    for (const ms of [...Object.keys(c.feeByMs), ...Object.keys(c.feeExtra).map(m => m * 60000)]) { assert.equal(a.fee(+ms), u.fee(+ms), `${c.name} fee ${ms}ms`); cells++; }
  }
  assert.ok(cells > 9000);
});

test('pricing: นาทีจอดอย่างน้อย 1 นาที ปัดขึ้น, ค่าที่ผิดรูปใช้ค่าเริ่มต้น, bookFee ตาม config', () => {
  assert.equal(P.parkMinutes(1000, 1000), 1); assert.equal(P.parkMinutes(0, 60000), 1); assert.equal(P.parkMinutes(0, 60001), 2); assert.equal(P.parkMinutes(5000, 1000), 1);
  assert.equal(P.parkFee({ rate: 20, freemin: 30 }, 0, 30 * 60000), 0);
  assert.equal(P.parkFee({ rate: 20, freemin: 30 }, 0, 30 * 60000 + 1), 1);
  assert.equal(P.parkFee({ rate: 20, freemin: 30 }, 0, 90 * 60000), 20);
  for (const bad of [{ rate: -5 }, { rate: NaN }, { rate: [] }, { rate: {} }, { rate: 1.5 }, { rate: 'x' }, { rate: null }, null, undefined, 'str', []]) {
    assert.deepEqual(P.effective(bad), { rate: 20, freemin: 30, bookfee: 20 }, JSON.stringify(bad));
  }
  assert.equal(P.bookFee({ bookfee: 0 }), 0); assert.equal(P.bookFee({}), 20); assert.equal(P.bookFee({ bookfee: '35' }), 35); assert.equal(P.bookFee({ bookfee: -1 }), 20);
  assert.equal(P.effective({ freemin: 0 }).freemin, 0);
});

// ---------- ล็อกเดียว (ข้อ 14) ----------
test('ล็อก: ทำทีละงานตามลำดับ ไม่ซ้อนกัน', async () => {
  const m = createMutex({ maxQueue: 25, maxWaitMs: 5000 }); const log = []; let inside = 0, max = 0;
  const job = n => m.run(async () => { inside++; max = Math.max(max, inside); log.push('s' + n); await sleep(5); log.push('e' + n); inside--; return n; });
  const r = await Promise.all([1, 2, 3, 4, 5].map(job));
  assert.deepEqual(r, [1, 2, 3, 4, 5]); assert.equal(max, 1);
  assert.deepEqual(log, ['s1', 'e1', 's2', 'e2', 's3', 'e3', 's4', 'e4', 's5', 'e5']);
});
test('ล็อก: คิวรอเกิน 25 = 503 BUSY ไม่รันงาน, 1 ถือล็อก + 25 รอผ่านได้', async () => {
  const m = createMutex({ maxQueue: 25, maxWaitMs: 5000 }); let ran = 0, release;
  const gate = new Promise(r => (release = r));
  const holder = m.run(async () => { await gate; ran++; });
  const waiting = Array.from({ length: 25 }, () => m.run(async () => { ran++; }));
  await sleep(10);
  await assert.rejects(m.run(async () => { ran += 1000; }), e => e instanceof ApiError && e.status === 503 && e.code === 'BUSY');
  release(); await Promise.all([holder, ...waiting]);
  assert.equal(ran, 26); assert.deepEqual(m.stats(), { held: false, waiting: 0, active: 0 });
});
test('ล็อก: รอนานเกินกำหนด = BUSY และถอนออกจากคิว ไม่ทำให้ล็อกค้าง; งานที่พังไม่ทำให้ล็อกค้าง', async () => {
  const m = createMutex({ maxQueue: 5, maxWaitMs: 30 }); let release;
  const holder = m.run(() => new Promise(r => (release = r)));
  await assert.rejects(m.run(async () => 'never'), e => e.code === 'BUSY');
  assert.equal(m.stats().waiting, 0);
  release(); await holder;
  await assert.rejects(m.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await m.run(async () => 'ok'), 'ok');
  // idle() รอจนงานจบ
  let r2; const h2 = m.run(() => new Promise(r => (r2 = r))); let idled = false; m.idle(2000).then(() => (idled = true));
  await sleep(10); assert.equal(idled, false); r2(); await h2; await sleep(5); assert.equal(idled, true);
});

// ---------- store ----------
test('store: เทียบทะเบียนด้วยรูป normalize (NFKC ช่องว่าง ขีด ตัวพิมพ์ เลขไทย)', () => {
  assert.equal(S.normPlate('กข 1234'), S.normPlate('กข-1234')); assert.equal(S.normPlate('กข๑๒๓๔'), S.normPlate('กข1234'));
  assert.equal(S.normPlate('ABC 12'), S.normPlate('abc-12')); assert.equal(S.normPlate('ＡＢＣ１２'), S.normPlate('abc12'));
  assert.notEqual(S.normPlate('กข1234'), S.normPlate('กข1235'));
});

const mkBook = (n, over = {}) => ({ id: 'b' + String(n).padStart(16, '0'), f: 1, i: n % 12, car: 'กข1234', s: 1700000000000 + n * 1000, e: 1700000000000 + n * 1000 + 2592000000, status: 'done', amt: 20, pm: 'pp', rno: 'PH' + String(10000000 + n), out: 1700000000000 + n * 1000 + 600000, min: 10, park: 0, ...over });

test('store: trimBooks ไม่เกิน 60 รายการ และ 30,000 ไบต์, ตัด void ก่อน แล้วรายการจบเก่าสุด, ไม่ตัด active', () => {
  const list = []; for (let n = 100; n >= 1; n--) list.push(mkBook(n));          // ใหม่สุดก่อน
  list[0] = mkBook(100, { status: 'active' }); list[99] = mkBook(1, { status: 'active' });   // active เก่าสุดต้องไม่ถูกตัด
  const t = S.trimBooks(list);
  assert.equal(t.length, 60); assert.ok(t.some(b => b.id === list[99].id), 'active เก่าสุดยังอยู่'); assert.equal(t[0].id, list[0].id);
  assert.deepEqual(t.filter(b => b.status === 'active').length, 2);
  // void ถูกตัดก่อนรายการจบ
  const l2 = []; for (let n = 60; n >= 1; n--) l2.push(mkBook(n, n === 30 ? { status: 'void' } : {})); l2.unshift(mkBook(61));
  const t2 = S.trimBooks(l2); assert.equal(t2.length, 60); assert.ok(!t2.some(b => b.status === 'void'));
  // เกินไบต์: เหตุผลยาวสุด 100 ตัวอักษรไทย
  const fat = []; for (let n = 60; n >= 1; n--) fat.push(mkBook(n, { status: 'cancelled', by: 'admin', bu: 'u'.repeat(36), reason: 'ก'.repeat(100) }));
  assert.ok(Buffer.byteLength(JSON.stringify(fat)) > S.MAX_BOOKS_BYTES);
  const tf = S.trimBooks(fat); assert.ok(Buffer.byteLength(JSON.stringify(tf)) <= S.MAX_BOOKS_BYTES); assert.equal(tf[0].id, fat[0].id);
  // มีแต่ active เกินเพดานก็ไม่ตัด
  const act = Array.from({ length: 3 }, (_, n) => mkBook(n + 1, { status: 'active' })); assert.equal(S.trimBooks(act).length, 3);
});

test('store: normBooks ทิ้งรายการเสีย (ชนิดผิด/ซ้ำ/ไม่มี id/สถานะแปลก) และไม่รับคีย์แปลกปลอม', () => {
  const good = mkBook(1);
  const out = S.normBooks([good, good, null, 5, 'x', { id: '../x', f: 1, i: 1 }, { ...good, id: 'b2', status: 'hacked' }, { ...good, id: 'b3', f: '1' }, { ...good, id: 'b4', e: 0 }, { ...mkBook(5), evil: 1, __proto__: { x: 1 } }]);
  assert.deepEqual(out.map(b => b.id), [good.id, mkBook(5).id]);
  assert.ok(!('evil' in out[1]));
  assert.deepEqual(S.normBooks('not json'), []); assert.deepEqual(S.normBooks({}), []); assert.deepEqual(S.normBooks(JSON.stringify([good])).map(b => b.id), [good.id]);
});

test('store: ใบเสร็จคำนวณจาก books ตามกฎ (ค่าจอง amt!=0 / ค่าจอด done+park>0 / คืนเงิน cancelled+amt!=0 / void ไม่มี / bookfee 0 ไม่มี)', () => {
  const rc = S.receiptsOf;
  const a = mkBook(1, { status: 'active', amt: 20 }); assert.deepEqual(rc(a).map(r => [r.kind, r.no, r.amt]), [['book', a.rno, 20]]);
  assert.equal(rc(a)[0].t, a.s); assert.equal(rc(a)[0].desc, 'ค่าจอง ช่อง A2 ชั้น 1'); assert.equal(rc(a)[0].f, 1); assert.equal(rc(a)[0].i, 1);
  const d = mkBook(2, { status: 'done', park: 15, min: 75, out: 1700000009999 }); const dr = rc(d);
  assert.deepEqual(dr.map(r => [r.kind, r.no, r.amt, r.t]), [['book', d.rno, 20, d.s], ['park', d.rno + '-p', 15, 1700000009999]]);
  assert.equal(dr[1].min, 75); assert.equal(dr[1].desc, 'ค่าจอด 75 นาที ช่อง B1 ชั้น 1'); assert.ok(!('min' in dr[0]));
  assert.equal(rc(mkBook(3, { status: 'done', park: 0 })).length, 1);                       // ไม่มีค่าจอด = ไม่มีใบเสร็จค่าจอด
  const c = mkBook(4, { status: 'cancelled', by: 'admin' }); assert.deepEqual(rc(c).map(r => [r.kind, r.no, r.amt]), [['book', c.rno, 20], ['refund', c.rno + '-r', -20]]);
  assert.equal(rc(mkBook(5, { status: 'cancelled', amt: 0 })).length, 0);                    // amt=0: ไม่มีใบเสร็จคืนเงิน
  assert.equal(rc(mkBook(6, { status: 'noshow' })).length, 1);                               // no-show ไม่คืน ไม่มีใบเสร็จใหม่
  assert.equal(rc(mkBook(7, { status: 'void' })).length, 0);
  assert.equal(rc(mkBook(8, { status: 'active', amt: 0 })).length, 0);                       // bookfee=0
  assert.equal(rc({ ...mkBook(9), rno: undefined }).length, 0);
  // เรียงใหม่สุดก่อน และจำกัดจาก books ล่าสุด 60 รายการ
  const all = []; for (let n = 70; n >= 1; n--) all.push(mkBook(n, { status: 'active' }));
  const rr = S.receiptsFrom(all); assert.equal(rr.length, 60); assert.ok(rr.every((r, k) => k === 0 || rr[k - 1].t >= r.t));
});

test('store: รายการที่ผู้ใช้เห็น (publicBooking) ไม่มี uid rno rq bu, void ถูกกรอง, ใบเสร็จไม่มี rno ภายใน', () => {
  const b = mkBook(1, { status: 'cancelled', by: 'admin', bu: 'admin-uid', reason: 'ปิดซ่อม', rq: 'abcdef012345', uid: 'u1', arr: 1700000001000 });
  const p = S.publicBooking(b);
  assert.deepEqual(Object.keys(p).sort(), ['amt', 'arr', 'by', 'car', 'e', 'f', 'i', 'id', 'min', 'out', 'park', 'pm', 'reason', 's', 'status'].sort());
  assert.deepEqual(S.visibleBooks([mkBook(1, { status: 'void' }), mkBook(2)]).map(x => x.id), [mkBook(2).id]);
  assert.ok(!JSON.stringify(S.receiptsOf(b)).match(/bu|uid|rq|admin-uid/));
  const act = S.publicBooking(mkBook(3, { status: 'active', rq: 'abcdef012345' })); assert.deepEqual(Object.keys(act).sort(), ['amt', 'car', 'e', 'f', 'i', 'id', 'min', 'out', 'park', 'pm', 's', 'status'].filter(k => !['min', 'out', 'park'].includes(k) || k in act).sort());
});

test('store: id/เลขใบเสร็จ/rq รูปแบบถูกต้องและไม่ซ้ำ', () => {
  const ids = new Set(Array.from({ length: 200 }, () => S.newBookingId())); assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^b[0-9a-f]{24}$/);
  for (let n = 0; n < 50; n++) assert.match(S.newReceiptNo(), /^PH\d{8}$/);
  assert.match(S.rqOf('req-12345678'), /^[0-9a-f]{12}$/); assert.equal(S.rqOf('a'), S.rqOf('a')); assert.notEqual(S.rqOf('a'), S.rqOf('b'));
});

// ---------- lot (allowlist, สถานะ, fresh) ----------
test('lot: normalizeBookings เก็บ arr amt pm rno rq (รูปแบบถูก) ภายใน แต่ซ่อน done/void/cancelled/noshow ตามปกติ', () => {
  const raw = [{ id: 'b0123456789abcdef', uid: 'u1', car: 'กข1234', s: 1, e: 5, status: 'active', amt: 20, pm: 'pp', rno: 'PH12345678', rq: 'abcdef012345', arr: 3, evil: 1 },
    { id: 'x1', uid: 'u', car: 'a', s: 1, e: 5, status: 'done' }, { id: 'x2', uid: 'u', car: 'a', s: 1, e: 5, status: 'void' },
    { id: 'x3', uid: 'u', car: 'a', s: 1, e: 5, status: 'cancelled' }, { id: 'x4', uid: 'u', car: 'a', s: 1, e: 5, status: 'noshow' }];
  const v = normalizeBookings(raw); assert.equal(v.length, 1);
  assert.deepEqual(v[0], { id: 'b0123456789abcdef', uid: 'u1', car: 'กข1234', s: 1, e: 5, status: 'active', amt: 20, pm: 'pp', rno: 'PH12345678', rq: 'abcdef012345', arr: 3 });
  assert.equal(normalizeBookings(raw, true).length, 5);
  const bad = normalizeBookings([{ id: 'b1', uid: 'u', car: 'a', s: 1, e: 5, amt: -1, pm: '<x>', rno: 'x', rq: 'ZZ', arr: 'now' }])[0];
  assert.deepEqual(Object.keys(bad).sort(), ['car', 'e', 'id', 's', 'status', 'uid']);
});

const seedLot = s => {
  s.mock.setTel({ hb: 1, 'slot_1-1': false, 'slot_1-2': true });
  s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 });
};
test('lot: มุมมองสาธารณะของการจองมีเฉพาะคีย์ที่กำหนด (เจ้าของเห็น id,car,mine) และไม่รั่ว arr/amt/pm/rno/rq/uid/bu', run(async s => {
  seedLot(s); const u = await s.member('a@t.dev'), v = await s.member('b@t.dev');
  s.mock.setAttr('bk_1-1', [{ id: 'b0123456789abcdef', uid: u.uid, car: 'กข1234', s: 1700000000000, e: 1700000000000 + 2592000000, status: 'active', amt: 20, pm: 'pp', rno: 'PH12345678', rq: 'abcdef012345', arr: 1700000500000 }]);
  const ra = await s.call('GET', '/api/lot', { token: u.token }), rb = await s.call('GET', '/api/lot', { token: v.token });
  const ba = ra.body.slots.find(x => x.k === '1-1').bookings, bb = rb.body.slots.find(x => x.k === '1-1').bookings;
  assert.deepEqual(ba, [{ id: 'b0123456789abcdef', car: 'กข1234', s: 1700000000000, e: 1700000000000 + 2592000000, status: 'active', mine: true }]);
  assert.deepEqual(bb, [{ s: 1700000000000, e: 1700000000000 + 2592000000, status: 'active', mine: false }]);
  for (const k of ['uid', 'arr', 'amt', 'pm', 'rno', 'rq', 'bu']) assert.ok(!rb.raw.includes('"' + k + '"'), 'ห้ามมี ' + k);
  assert.ok(!rb.raw.includes(u.uid) && !rb.raw.includes('กข1234'));
}));

test('lot: การจองสถานะ done/void ใน bk_ ไม่แสดงเป็น "จองแล้ว" บนแผนที่', run(async s => {
  seedLot(s); const u = await s.member('c@t.dev');
  s.mock.setAttr('bk_1-1', [{ id: 'b1', uid: u.uid, car: 'ก', s: 1, e: 9, status: 'done' }]); s.mock.setAttr('bk_1-3', [{ id: 'b2', uid: u.uid, car: 'ก', s: 1, e: 9, status: 'void' }]);
  const r = await s.call('GET', '/api/lot', { token: u.token });
  assert.ok(r.body.slots.every(x => x.bookings.length === 0));
}));

test('lot.fresh(): อ่านสดทั้งหมด ไม่ใช้ cache 5 วิ (เห็นค่าใหม่ทันที) แต่ get() ยังใช้ cache', run(async s => {
  seedLot(s); await s.member('d@t.dev');
  const lot = s.routes.lot;
  const a = await lot.get(); assert.equal(a.slots['1-1'].occ, false);
  s.mock.setTel({ 'slot_1-1': true }); s.mock.setAttr('closed', { '1-0': true });
  const cached = await lot.get(); assert.equal(cached.slots['1-1'].occ, false, 'get() ใช้ cache');
  const f = await lot.fresh(); assert.equal(f.slots['1-1'].occ, true); assert.deepEqual(f.closed, { '1-0': true });
  const n = s.mock.st.telCalls; await lot.fresh(); assert.ok(s.mock.st.telCalls > n, 'ทุกครั้งอ่านใหม่');
}, { LOT_CACHE_MS: '60000', LOT_ATTR_MS: '60000' }));

test('lot.fresh(): อ่านได้ไม่ครบ (attribute หรืออุปกรณ์ใดล้ม) = 502 UPSTREAM ไม่ใช้ของเก่า; กลับมาแล้วอ่านได้', run(async s => {
  seedLot(s); await s.member('e@t.dev'); const lot = s.routes.lot;
  await lot.fresh();
  s.mock.st.failAttr = 503; await assert.rejects(lot.fresh(), e => e instanceof ApiError && e.status === 502 && e.code === 'UPSTREAM'); s.mock.st.failAttr = 0;
  s.mock.st.failDev['dev-lot'] = 500; await assert.rejects(lot.fresh(), e => e.code === 'UPSTREAM'); s.mock.st.failDev['dev-lot'] = 0;
  assert.ok((await lot.fresh()).slots['1-1']);
}));

// ---------- tb: asset attributes + สวิตช์เขียน ----------
test('tb: readAssetAttrs อ่านสดเฉพาะคีย์ที่ขอ, writeAssetAttrs เขียนลง asset ของลาน และนับเป็นการเขียนแยกจากการอ่าน', run(async s => {
  const { createTb } = require('../tb'); const tb = createTb(s.cfg);
  s.mock.setAttr('bk_1-1', [{ id: 'b1' }]); s.mock.setAttr('bk_1-2', []); s.mock.setAttr('config', { a: 1 });
  assert.deepEqual(Object.keys(await tb.readAssetAttrs(['bk_1-1', 'bk_9-9'])), ['bk_1-1']);
  assert.equal(s.mock.st.wr.length, 0);
  await tb.writeAssetAttrs({ 'bk_1-2': [{ id: 'b2' }] });
  assert.deepEqual(s.mock.st.assetAttrs['bk_1-2'], [{ id: 'b2' }]); assert.equal(s.mock.st.wr.length, 1); assert.deepEqual(s.mock.st.wr[0], { entity: 'ASSET', id: 'asset-data', keys: ['bk_1-2'], status: 200 });
  s.mock.st.failWrite = () => 503;
  await assert.rejects(tb.writeAssetAttrs({ x: 1 }), e => e.status === 502 && e.code === 'UPSTREAM');
  assert.equal(s.mock.st.assetAttrs.x, undefined);
}));

test('สวิตช์เขียน: ค่าเริ่มต้น = ปิด; BOOKINGS_WRITE=1 เปิด; ค่าอื่น (true, yes, 0) ไม่เปิด; ตัวเลือกตอนสร้างชนะ env', async () => {
  const base = { TB_API_KEY: 'k', TB_CUSTOMER_MEMBERS_ID: 'm' };
  assert.equal(loadConfig(base).bookingsWrite, false);
  assert.equal(loadConfig({ ...base, BOOKINGS_WRITE: '1' }).bookingsWrite, true);
  for (const v of ['true', 'yes', '0', '', ' 1', 'on']) assert.equal(loadConfig({ ...base, BOOKINGS_WRITE: v }).bookingsWrite, false, v);
  const { createRoutes } = require('../routes');
  const mk = (env, opts) => { const r = createRoutes(loadConfig({ ...base, ...env }), {}, undefined, opts); r.close(); return r.writesEnabled; };
  assert.equal(mk({}), false); assert.equal(mk({ BOOKINGS_WRITE: '1' }), true);
  assert.equal(mk({}, { writesEnabled: true }), true); assert.equal(mk({ BOOKINGS_WRITE: '1' }, { writesEnabled: false }), false);
});
