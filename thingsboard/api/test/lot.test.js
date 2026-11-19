// M2: GET /api/lot, GET /api/live (SSE), GET /healthz  (mock ThingsBoard เท่านั้น ไม่แตะของจริง)
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, run, sleep, until, slotOf, WEB } = require('./harness');

// ---------- /healthz และ CORS ----------
test('healthz: ไม่ต้องล็อกอิน คืนเฉพาะ ok + uptime และไม่เรียก ThingsBoard', run(async s => {
  const r = await s.call('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'uptime']);
  assert.equal(r.body.ok, true); assert.equal(typeof r.body.uptime, 'number');
  assert.equal(s.mock.st.calls.length, 0);
}));

test('CORS: origin ที่ไม่อยู่ใน WEB_ORIGINS ได้ 403, origin ของเว็บได้ header, ALLOW_LOCALHOST=0 ปิด localhost', async () => {
  const s = await setup();
  try {
    assert.equal((await s.call('GET', '/healthz', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const ok = await s.call('GET', '/healthz', { headers: { Origin: WEB } });
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), WEB);
    assert.equal((await s.call('GET', '/healthz', { headers: { Origin: 'http://localhost:5500' } })).status, 200);
  } finally { await s.close(); }
  const s2 = await setup({ ALLOW_LOCALHOST: '0' });
  try {
    assert.equal((await s2.call('GET', '/healthz', { headers: { Origin: 'http://localhost:5500' } })).status, 403);
    assert.equal((await s2.call('GET', '/healthz', { headers: { Origin: WEB } })).status, 200);
  } finally { await s2.close(); }
});

// ---------- /api/lot: สิทธิ์ ----------
test('lot: ไม่มี JWT / JWT ปลอม / หมดอายุ / ผิดรูป = 401 และไม่เรียกอ่านข้อมูลลาน', run(async s => {
  for (const p of ['/api/lot', '/api/live']) {
    assert.equal((await s.call('GET', p)).status, 401, p);
    const forged = await s.call('GET', p, { token: s.mock.makeToken('someone', 900) });
    assert.equal(forged.status, 401); assert.equal(forged.body.error.code, 'TOKEN_INVALID');
    const old = await s.call('GET', p, { token: s.mock.makeToken('someone', -100) });
    assert.equal(old.body.error.code, 'TOKEN_EXPIRED');
    assert.equal((await s.call('GET', p, { token: 'abc' })).body.error.code, 'TOKEN_INVALID');
  }
  assert.equal(s.mock.st.telCalls, 0); assert.equal(s.mock.st.attrCalls, 0);
}));

test('lot: JWT ใน query string ไม่ใช้เป็นการยืนยันตัวตน', run(async s => {
  const u = await s.member('q@test.dev');
  assert.equal((await s.call('GET', '/api/lot?token=' + u.token)).status, 401);
  assert.equal((await s.call('GET', '/api/live?access_token=' + u.token)).status, 401);
}));

// ---------- /api/lot: ข้อมูล ----------
test('lot: บอร์ดไม่เคยส่งข้อมูล (ParkHere-Lot ใหม่) = 200 สถานะ never, ทุกช่อง occ=null, config เป็นค่า default ไม่ใช่ error', run(async s => {
  const u = await s.member('empty@test.dev');
  const r = await s.call('GET', '/api/lot', { token: u.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.board, { status: 'never', online: false, lastSeen: null });
  assert.deepEqual(r.body.boards, [{ id: 'lot', status: 'never', online: false, lastSeen: null }]);
  assert.equal(r.body.slots.length, 18);
  assert.ok(r.body.slots.every(x => x.occ === null && x.barrier === null && x.closed === false && x.bookings.length === 0));
  assert.equal(r.body.configSource, 'default');
  assert.deepEqual(r.body.config, { floors: 3, slots: 6, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 });
  assert.deepEqual(r.body.closed, {});
  assert.equal(r.body.stale, false);
}));

test('lot: ช่องว่าง / มีรถ / ไม้กั้นลด-ยก / ปิดช่อง / config จาก TB (ค่า telemetry เป็นสตริงแบบ TB)', run(async s => {
  const u = await s.member('ok@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-0': 'false', 'slot_1-2': 'true', 'bar_1-2': '1', 'bar_1-0': '0', 'slot_2-5': 'true', 'slot_9-9': 'true', rssi: -50 });
  s.mock.setAttr('config', { floors: 2, slots: 6, rate: 25, penalty: 30 });
  s.mock.setAttr('closed', { '1-1': true, '1-3': false, 'x': true });
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.equal(r.board.status, 'online'); assert.equal(r.board.online, true);
  assert.equal(r.slots.length, 12);   // 2 ชั้น x 6 ช่อง ตาม config
  assert.equal(slotOf(r, '1-0').occ, false); assert.equal(slotOf(r, '1-0').barrier, 'up');
  assert.equal(slotOf(r, '1-2').occ, true); assert.equal(slotOf(r, '1-2').barrier, 'down');
  assert.equal(slotOf(r, '2-5').occ, true);
  assert.equal(slotOf(r, '1-4').occ, null);          // ไม่มี telemetry ของช่องนี้ = ไม่ทราบ
  assert.equal(slotOf(r, '9-9'), undefined);         // นอกขอบเขต config ไม่โผล่
  assert.equal(slotOf(r, '1-1').closed, true); assert.equal(slotOf(r, '1-3').closed, false);
  assert.deepEqual(r.closed, { '1-1': true });
  assert.equal(r.config.rate, 25); assert.equal(r.config.floors, 2);
  assert.equal(r.configSource, 'partial');           // bookfee/freemin/noshow ยังไม่อยู่ใน TB -> default
  assert.deepEqual(r.defaulted, ['bookfee', 'freemin', 'noshow']);
  assert.equal(r.config.bookfee, 20);
  assert.equal(s.mock.st.writes.length, 0);          // ไม่เขียนอะไรลง TB
}));

test('lot: config ครบทุกคีย์ = source tb; ค่าผิดรูป/เกินช่วง ใช้ default ต่อคีย์', run(async s => {
  const u = await s.member('cfg@test.dev');
  s.mock.setAttr('config', { floors: 1, slots: 4, rate: 20, penalty: 20, bookfee: 15, freemin: 45, noshow: 10 });
  let r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.equal(r.configSource, 'tb'); assert.deepEqual(r.defaulted, []); assert.equal(r.slots.length, 4); assert.equal(r.config.freemin, 45);
  await sleep(350);
  s.mock.setAttr('config', JSON.stringify({ floors: 999, slots: 'x', rate: -5, penalty: 1.5, bookfee: 7 }));   // JSON เป็นสตริงก็อ่านได้
  r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.equal(r.config.floors, 3); assert.equal(r.config.slots, 6); assert.equal(r.config.rate, 20); assert.equal(r.config.penalty, 20);
  assert.equal(r.config.bookfee, 7); assert.equal(r.configSource, 'partial');
}));

test('lot: hb เก่ากว่า 90 วินาที = offline ทุกช่อง occ=null (ไม่ใช่ว่าง) และบอกเวลาล่าสุด', run(async s => {
  const u = await s.member('off@test.dev');
  const ts = Date.now() - 120000;
  s.mock.setTel({ hb: 1, 'slot_1-2': 'true', 'bar_1-2': '1' }, ts);
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.equal(r.board.status, 'offline'); assert.equal(r.board.online, false); assert.equal(r.board.lastSeen, ts);
  assert.equal(slotOf(r, '1-2').occ, null); assert.equal(slotOf(r, '1-2').barrier, null);
}));

test('lot: ไม่มี hb แต่มี telemetry ใหม่ = ใช้เวลา telemetry ล่าสุด ; เก่า 89 วิ ยังออนไลน์', run(async s => {
  const u = await s.member('nohb@test.dev');
  s.mock.setTel({ 'slot_1-2': 'true' }, Date.now() - 89000);
  const r = (await s.call('GET', '/api/lot', { token: u.token })).body;
  assert.equal(r.board.online, true); assert.equal(slotOf(r, '1-2').occ, true);
}));

test('lot: การจอง เจ้าของเห็น id/car ของตัวเอง คนอื่นเห็นแค่ช่วงเวลา/สถานะ; ข้อมูลผิดรูป/ยกเลิกถูกซ่อน', run(async s => {
  const a = await s.member('a@test.dev'), b = await s.member('b@test.dev');
  const t = Date.now();
  s.mock.setTel({ hb: 1 });
  s.mock.setAttr('bk_1-2', [
    { id: 'bk-a', uid: a.uid, car: 'กข1234', s: t + 1000, e: t + 3600000, amount: 40, status: 'active', t },
    { id: 'bk-b', uid: b.uid, car: 'ขค9999', s: t + 4000000, e: t + 7000000, amount: 40, status: 'paid', t },
    { id: 'bk-c', uid: b.uid, car: 'ซ่อน', s: t, e: t + 1000, status: 'cancelled' },
    { id: 'bad', uid: b.uid, s: 'x', e: 5 }, 'junk', null, { id: 'bk-r', uid: b.uid, s: 10, e: 5 },
  ]);
  s.mock.setAttr('bk_1-3', 'not-an-array');
  const ra = await s.call('GET', '/api/lot', { token: a.token }), rb = await s.call('GET', '/api/lot', { token: b.token });
  const sa = slotOf(ra.body, '1-2').bookings, sb = slotOf(rb.body, '1-2').bookings;
  assert.equal(sa.length, 2);
  assert.deepEqual(sa[0], { id: 'bk-a', car: 'กข1234', s: t + 1000, e: t + 3600000, status: 'active', mine: true });
  assert.deepEqual(sa[1], { s: t + 4000000, e: t + 7000000, status: 'paid', mine: false });
  assert.deepEqual(sb[0], { s: t + 1000, e: t + 3600000, status: 'active', mine: false });
  assert.equal(sb[1].mine, true); assert.equal(sb[1].car, 'ขค9999');
  // ไม่รั่วข้อมูลคนอื่นแม้แต่ใน JSON ดิบ
  for (const [resp, other] of [[ra, b], [rb, a]]) {
    assert.ok(!resp.raw.includes(other.uid), 'ต้องไม่มี uid ของคนอื่น');
    assert.ok(!resp.raw.includes(other === b ? 'bk-b' : 'bk-a') && !resp.raw.includes(other === b ? 'ขค9999' : 'กข1234'));
  }
  assert.ok(!ra.raw.includes('ซ่อน') && !ra.raw.includes('amount'));
  assert.equal(slotOf(ra.body, '1-3').bookings.length, 0);
}));

test('lot: cache ไม่ยิง ThingsBoard ซ้ำเมื่อมีหลายคำขอพร้อมกัน/ถี่ ๆ', run(async s => {
  const u = await s.member('cache@test.dev');
  s.mock.setTel({ hb: 1 });
  await Promise.all(Array.from({ length: 10 }, () => s.call('GET', '/api/lot', { token: u.token })));
  for (let i = 0; i < 5; i++) await s.call('GET', '/api/lot', { token: u.token });
  assert.equal(s.mock.st.telCalls, 1); assert.equal(s.mock.st.attrCalls, 1);
  await sleep(350);
  await s.call('GET', '/api/lot', { token: u.token });
  assert.equal(s.mock.st.telCalls, 2);
}));

test('lot: ThingsBoard ล่มและยังไม่มี cache = 502 UPSTREAM; มี cache เก่า = ตอบ 200 ด้วยข้อมูลเดิมและพักการยิงซ้ำ', run(async s => {
  const u = await s.member('down@test.dev');
  s.mock.st.failTel = 500;
  const bad = await s.call('GET', '/api/lot', { token: u.token });
  assert.equal(bad.status, 502); assert.equal(bad.body.error.code, 'UPSTREAM');
  s.mock.st.failTel = 0; await sleep(2100);   // พ้นช่วงพักหลังล้มเหลว
  s.mock.setTel({ hb: 1, 'slot_1-0': 'true' });
  assert.equal((await s.call('GET', '/api/lot', { token: u.token })).body.stale, false);
  await sleep(350); s.mock.st.failTel = 503; s.mock.st.telCalls = 0;
  const r = await s.call('GET', '/api/lot', { token: u.token });
  assert.equal(r.status, 200); assert.equal(slotOf(r.body, '1-0').occ, true);
  for (let i = 0; i < 5; i++) await s.call('GET', '/api/lot', { token: u.token });
  assert.ok(s.mock.st.telCalls <= 2, 'ต้องพักการยิงซ้ำ ไม่ใช่ยิงทุกคำขอ: ' + s.mock.st.telCalls);
}));

test('lot: ไม่ตั้ง TB_ASSET_ID / TB_SENSOR_DEVICE_ID = 503 NOT_CONFIGURED (healthz และ me ยังทำงาน)', async () => {
  const s = await setup({ TB_ASSET_ID: '', TB_SENSOR_DEVICE_ID: '' });
  try {
    const u = await s.member('nc@test.dev');
    const r = await s.call('GET', '/api/lot', { token: u.token });
    assert.equal(r.status, 503); assert.equal(r.body.error.code, 'NOT_CONFIGURED');
    assert.equal((await s.call('GET', '/healthz')).status, 200);
  } finally { await s.close(); }
});

test('lot: method อื่นได้ 405', run(async s => { assert.equal((await s.call('POST', '/api/lot', { body: {} })).status, 405); }));

// ---------- /api/live (SSE) ----------
test('live: ต่อแล้วได้ snapshot ก่อน, header ถูกต้อง, ส่ง diff เฉพาะที่เปลี่ยน, ping มาเรื่อย ๆ', run(async s => {
  const u = await s.member('live@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-0': 'false', 'slot_1-1': 'false' });
  const c = await s.sse(u.token);
  assert.equal(c.status, 200);
  assert.match(c.headers.get('content-type'), /^text\/event-stream/);
  assert.match(c.headers.get('cache-control'), /no-cache/);
  await c.wait('snapshot');
  assert.equal(c.events[0].event, 'snapshot');
  assert.equal(c.events[0].data.slots.length, 18);
  assert.equal(slotOf(c.events[0].data, '1-0').occ, false);
  await c.wait('ping');
  await sleep(250);   // ไม่มีอะไรเปลี่ยน = ไม่มี slot event
  assert.equal(c.of('slot').length, 0);
  s.mock.setTel({ 'slot_1-1': 'true' });
  const e = await c.wait('slot', d => d.k === '1-1');
  assert.deepEqual(e.data, { k: '1-1', occ: true, barrier: null, source: 'lot', online: true, conflict: false });
  s.mock.setTel({ 'bar_1-1': '1' });
  assert.deepEqual((await c.wait('slot', d => d.k === '1-1' && d.barrier === 'down')).data, { k: '1-1', occ: true, barrier: 'down', source: 'lot', online: true, conflict: false });
  assert.equal(c.of('slot').length, 2);   // ส่งเฉพาะช่องที่เปลี่ยน
  c.close();
}));

test('live: ปิดช่อง / เปลี่ยน config / เกิดการจอง ส่ง event ของตัวเอง; bookings กรองข้อมูลส่วนตัวต่อผู้ใช้', run(async s => {
  const a = await s.member('la@test.dev'), b = await s.member('lb@test.dev');
  s.mock.setTel({ hb: 1 });
  const ca = await s.sse(a.token), cb = await s.sse(b.token);
  await ca.wait('snapshot'); await cb.wait('snapshot');
  s.mock.setAttr('closed', { '1-3': true });
  assert.deepEqual((await ca.wait('closed')).data, { closed: { '1-3': true } });
  s.mock.setAttr('config', { floors: 3, slots: 12, rate: 30, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 });
  const cfgEv = await ca.wait('config'); assert.equal(cfgEv.data.config.rate, 30); assert.equal(cfgEv.data.configSource, 'tb');
  const t = Date.now();
  s.mock.setAttr('bk_1-2', [{ id: 'bk-a', uid: a.uid, car: 'กข1234', s: t, e: t + 3600000, status: 'active' }]);
  const ea = await ca.wait('bookings'), eb = await cb.wait('bookings');
  assert.deepEqual(ea.data, { k: '1-2', bookings: [{ id: 'bk-a', car: 'กข1234', s: t, e: t + 3600000, status: 'active', mine: true }] });
  assert.deepEqual(eb.data, { k: '1-2', bookings: [{ s: t, e: t + 3600000, status: 'active', mine: false }] });
  assert.ok(!JSON.stringify(cb.events).includes('กข1234') && !JSON.stringify(cb.events).includes(a.uid));
  ca.close(); cb.close();
}));

test('live: บอร์ดหยุดส่ง hb เกิน 90 วินาทีระหว่างเชื่อมต่อ = ได้ event board offline + slot เป็น null; กลับมา = online', run(async s => {
  const u = await s.member('lo@test.dev');
  s.mock.setTel({ hb: 1, 'slot_1-2': 'true' });
  const c = await s.sse(u.token); await c.wait('snapshot');
  assert.equal(slotOf(c.events[0].data, '1-2').occ, true);
  s.mock.setTel({ hb: 1, 'slot_1-2': 'true' }, Date.now() - 100000);
  assert.equal((await c.wait('board', d => d.board.status === 'offline')).data.board.online, false);
  assert.deepEqual((await c.wait('slot', d => d.k === '1-2' && d.occ === null)).data.barrier, null);
  s.mock.setTel({ hb: 1, 'slot_1-2': 'true' });
  await c.wait('board', d => d.board.status === 'online');
  await c.wait('slot', d => d.k === '1-2' && d.occ === true);
  c.close();
}));

test('live: บอร์ดไม่เคยส่งข้อมูล = เชื่อมต่อได้ ได้ snapshot สถานะ never (ไม่ error)', run(async s => {
  const u = await s.member('ln@test.dev');
  const c = await s.sse(u.token);
  assert.equal(c.status, 200);
  assert.equal((await c.wait('snapshot')).data.board.status, 'never');
  c.close();
}));

test('live: ตัดการเชื่อมต่อแล้ว poller หยุด (ไม่ยิง ThingsBoard ต่อ) และต่อใหม่ได้ snapshot ใหม่', run(async s => {
  const u = await s.member('lc@test.dev');
  s.mock.setTel({ hb: 1 });
  const c = await s.sse(u.token); await c.wait('snapshot');
  await sleep(200);
  assert.ok(s.mock.st.telCalls >= 3, 'ระหว่างมีคนดูต้อง poll ต่อเนื่อง ' + s.mock.st.telCalls);
  c.close();
  await until(() => s.routes.lot.listenerCount() === 0 && s.routes.hub.count() === 0);
  await sleep(100); const n = s.mock.st.telCalls; await sleep(300);
  assert.equal(s.mock.st.telCalls, n, 'ไม่มีคนดูแล้วต้องหยุด poll');
  s.mock.setTel({ 'slot_1-5': 'true' });
  const c2 = await s.sse(u.token); const snap = await c2.wait('snapshot');
  assert.equal(slotOf(snap.data, '1-5').occ, true);
  c2.close();
}));

test('live: จำกัด 3 การเชื่อมต่อต่อผู้ใช้ — อันใหม่ตัดอันเก่าสุด (end: replaced) และผู้ใช้อื่นไม่กระทบ', run(async s => {
  const u = await s.member('lm@test.dev'), o = await s.member('lo2@test.dev');
  s.mock.setTel({ hb: 1 });
  const cs = []; for (let i = 0; i < 3; i++) { const c = await s.sse(u.token); await c.wait('snapshot'); cs.push(c); }
  const other = await s.sse(o.token); await other.wait('snapshot');
  assert.equal(s.routes.hub.count(), 4);
  const c4 = await s.sse(u.token); await c4.wait('snapshot');
  assert.deepEqual((await cs[0].wait('end')).data, { reason: 'replaced' });
  await until(() => cs[0].ended);
  assert.equal(cs[1].ended, false); assert.equal(cs[2].ended, false); assert.equal(other.ended, false);
  assert.equal(s.routes.hub.count(), 4);
  [...cs, c4, other].forEach(c => c.close());
}));

test('live: เกินจำนวนรวมสูงสุด = 503 BUSY (JSON ปกติ)', run(async s => {
  const u = await s.member('lt@test.dev'), o = await s.member('lt2@test.dev');
  s.mock.setTel({ hb: 1 });
  const c = await s.sse(u.token); await c.wait('snapshot');
  const r = await s.sse(o.token);
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'BUSY');
  c.close();
}, { LIVE_MAX_TOTAL: '1' }));

test('live: JWT หมดอายุระหว่างเชื่อมต่อ = ส่ง end token-expired แล้วปิด', run(async s => {
  const u = await s.member('le@test.dev');
  const tok = s.mock.makeToken(u.uid, 2); s.mock.st.tokens.set(tok, u.uid);
  s.mock.setTel({ hb: 1 });
  const c = await s.sse(tok); await c.wait('snapshot');
  assert.deepEqual((await c.wait('end', () => true, 4000)).data, { reason: 'token-expired' });
  await until(() => c.ended);
}));

test('live: CORS ของ stream ตอบ origin ของเว็บ; origin อื่น 403 ไม่เปิด stream', run(async s => {
  const u = await s.member('lcors@test.dev');
  s.mock.setTel({ hb: 1 });
  const ok = await s.sse(u.token, { headers: { Origin: WEB } });
  assert.equal(ok.headers.get('access-control-allow-origin'), WEB);
  ok.close();
  const bad = await s.sse(u.token, { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
}));

test('live: ThingsBoard ล่มและยังไม่มี cache = 502 JSON (ไม่ค้างเป็น stream เปล่า)', run(async s => {
  const u = await s.member('lf@test.dev');
  s.mock.st.failAttr = 500;
  const c = await s.sse(u.token);
  assert.equal(c.status, 502); assert.equal(c.body.error.code, 'UPSTREAM');
}));
