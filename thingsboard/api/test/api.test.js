const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockTb, KEY } = require('./mock-tb');
const { loadConfig } = require('../config');
const { createServer } = require('../server');
const { createRoutes } = require('../routes');

const MEMBERS = 'members-cust', STAFF = 'staff-cust', WEB = 'https://parkhere.example.onrender.com';

async function setup(over = {}, clock) {
  const mock = createMockTb({ membersId: MEMBERS, staffId: STAFF });
  const tbPort = await mock.listen();
  const cfg = { ...loadConfig({ TB_HOST: 'http://127.0.0.1:' + tbPort, TB_API_KEY: KEY, TB_CUSTOMER_MEMBERS_ID: MEMBERS, TB_CUSTOMER_STAFF_ID: STAFF, WEB_ORIGINS: WEB }), ...over };
  const srv = createServer(cfg, createRoutes(cfg, undefined, clock));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  let n = 0;
  const call = async (method, path, { body, token, headers = {}, ip } = {}) => {
    const h = { ...headers, 'X-Forwarded-For': ip || `10.0.0.${++n}` };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j, headers: r.headers };
  };
  const signup = async (email, extra = {}) => (await call('POST', '/api/signup', { body: { email, password: 'Passw0rd!x', name: 'ทดสอบ', plate: '1กข 234', ...extra } }));
  return { mock, cfg, call, signup, srvClose: () => srv.closeAllConnections() || srv.close(), close: async () => { srv.closeAllConnections(); await new Promise(r => srv.close(r)); await mock.close(); } };
}
const run = fn => async () => { const s = await setup(); try { await fn(s); } finally { await s.close(); } };

test('signup สำเร็จ: ได้ token, user ถูกสร้างใน customer Members, เก็บ cars', run(async s => {
  const r = await s.signup('a@test.dev');
  assert.equal(r.status, 201);
  assert.ok(r.body.token && r.body.refreshToken);
  assert.equal(r.body.user.role, 'member');
  assert.deepEqual(r.body.user.cars, [{ plate: '1กข 234' }]);
  const u = s.mock.st.byEmail.get('a@test.dev');
  assert.equal(u.customerId.id, MEMBERS);
  assert.equal(u.authority, 'CUSTOMER_USER');
  assert.ok(!JSON.stringify(r.body).includes('Passw0rd'));
}));

test('signup: อีเมลซ้ำ 409, input ผิด 400, ช่องแปลก 400, ไม่ใช้ key จากฝั่ง client', run(async s => {
  await s.signup('dup@test.dev');
  assert.equal((await s.signup('dup@test.dev')).status, 409);
  assert.equal((await s.signup('not-an-email')).body.error.code, 'BAD_INPUT');
  assert.equal((await s.call('POST', '/api/signup', { body: { email: 'q@test.dev', password: 'short', name: 'x' } })).status, 400);
  assert.equal((await s.call('POST', '/api/signup', { body: { email: 'q@test.dev', password: 'Passw0rd!x', name: 'x', role: 'master' } })).status, 400);
  assert.equal((await s.call('POST', '/api/signup', { body: '{bad json' })).body.error.code, 'BAD_JSON');
  assert.equal(s.mock.st.byEmail.has('q@test.dev'), false);
}));

test('signup: ThingsBoard ปฏิเสธรหัสผ่าน -> ลบ user ที่สร้างไว้ (rollback)', run(async s => {
  s.mock.st.failActivateWith = 'Password must be at least 12 characters';
  const r = await s.signup('w@test.dev');
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'WEAK_PASSWORD');
  assert.equal(s.mock.st.byEmail.has('w@test.dev'), false);
}));

test('signup: โควตาผู้ใช้เต็มของ ThingsBoard (หลายรูปแบบ) -> 503 QUOTA ข้อความไทย', run(async s => {
  for (const f of [{ status: 400, message: 'You have reached the maximum number of users' }, { status: 403, message: 'Limit exceeded' }, { status: 402, message: 'Payment required' }, { status: 400, message: 'x', sub: 7 }]) {
    s.mock.st.failCreateWith = f;
    const r = await s.signup('qt@test.dev');
    assert.equal(r.status, 503); assert.equal(r.body.error.code, 'QUOTA'); assert.match(r.body.error.message, /ระบบรับสมาชิกเต็มแล้ว/);
  }
  s.mock.st.failCreateWith = null;
  assert.equal((await s.signup('qt@test.dev')).status, 201);
}));

test('login: สำเร็จ / รหัสผิด 401 ข้อความไทย', run(async s => {
  await s.signup('l@test.dev');
  const ok = await s.call('POST', '/api/login', { body: { email: 'L@test.dev', password: 'Passw0rd!x' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.user.email, 'l@test.dev'); assert.equal(ok.body.user.role, 'member');
  const bad = await s.call('POST', '/api/login', { body: { email: 'l@test.dev', password: 'wrong-pass' } });
  assert.equal(bad.status, 401); assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
  assert.match(bad.body.error.message, /ไม่ถูกต้อง/);
  assert.equal((await s.call('POST', '/api/login', { body: { email: 'nobody@test.dev', password: 'x12345678' } })).body.error.message, bad.body.error.message);
}));

test('login: staff อ่าน role จาก customer ไม่ใช่จากอีเมล; ผู้ใช้นอกแอป 403', run(async s => {
  await s.signup('st@test.dev');
  const u = s.mock.st.byEmail.get('st@test.dev'); u.customerId = { id: STAFF, entityType: 'CUSTOMER' };
  assert.equal((await s.call('POST', '/api/login', { body: { email: 'st@test.dev', password: 'Passw0rd!x' } })).body.user.role, 'staff');
  u.customerId = { id: 'other' };
  const r = await s.call('POST', '/api/login', { body: { email: 'st@test.dev', password: 'Passw0rd!x' } });
  assert.equal(r.status, 403);
}));

test('login: ล็อกบัญชีหลังผิด 8 ครั้ง (คนละ IP)', run(async s => {
  await s.signup('k@test.dev');
  for (let i = 0; i < 8; i++) assert.equal((await s.call('POST', '/api/login', { body: { email: 'k@test.dev', password: 'bad-bad-bad' } })).status, 401);
  const r = await s.call('POST', '/api/login', { body: { email: 'k@test.dev', password: 'Passw0rd!x' } });
  assert.equal(r.status, 429); assert.equal(r.body.error.code, 'ACCOUNT_LOCKED');
}));

test('rate limit ต่อ IP: login ครั้งที่ 11 ใน 1 นาที = 429, IP อื่นยังผ่าน', run(async s => {
  for (let i = 0; i < 10; i++) assert.notEqual((await s.call('POST', '/api/login', { ip: '9.9.9.9', body: { email: `r${i}@test.dev`, password: 'whatever12' } })).status, 429);
  const r = await s.call('POST', '/api/login', { ip: '9.9.9.9', body: { email: 'r@test.dev', password: 'whatever12' } });
  assert.equal(r.status, 429); assert.equal(r.body.error.code, 'RATE_LIMIT');
  assert.notEqual((await s.call('POST', '/api/login', { ip: '8.8.8.8', body: { email: 'r@test.dev', password: 'whatever12' } })).status, 429);
}));

test('rate limit signup', run(async s => {
  for (let i = 0; i < 10; i++) await s.call('POST', '/api/signup', { ip: '7.7.7.7', body: { email: 'bad', password: 'x', name: 'x' } });
  assert.equal((await s.call('POST', '/api/signup', { ip: '7.7.7.7', body: { email: 'z@test.dev', password: 'Passw0rd!x', name: 'z' } })).status, 429);
}));

test('refresh: ได้คู่ token ใหม่ / token ปลอมหรือ access token 401', run(async s => {
  const su = await s.signup('f@test.dev');
  const r = await s.call('POST', '/api/refresh', { body: { refreshToken: su.body.refreshToken } });
  assert.equal(r.status, 200); assert.ok(r.body.token);
  assert.equal((await s.call('POST', '/api/refresh', { body: { refreshToken: 'x.y.z-forged-token' } })).status, 401);
  assert.equal((await s.call('POST', '/api/refresh', { body: {} })).status, 400);
}));

test('forgot: ตอบเหมือนกันทั้งอีเมลที่มีและไม่มี, เรียก TB resetPasswordByEmail', run(async s => {
  await s.signup('fg@test.dev');
  const a = await s.call('POST', '/api/forgot', { body: { email: 'fg@test.dev' } });
  const b = await s.call('POST', '/api/forgot', { body: { email: 'none@test.dev' } });
  assert.equal(a.status, 200); assert.deepEqual(a.body, b.body);
  assert.deepEqual(s.mock.st.resetFor, ['fg@test.dev', 'none@test.dev']);
  assert.equal((await s.call('POST', '/api/forgot', { body: { email: 'bad' } })).status, 400);
}));

test('forgot: บัญชีที่สมัครผ่าน API ต้องอยู่ใน group Customer Users (ไม่งั้น TB ไม่ส่งอีเมล) และ log สถานะโดยไม่มีอีเมล', run(async s => {
  const su = await s.signup('grp@test.dev');
  assert.ok(s.mock.st.groupMembers.has(su.body.user.id), 'ผู้ใช้ใหม่ต้องอยู่ใน group');
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try { assert.equal((await s.call('POST', '/api/forgot', { body: { email: 'grp@test.dev' } })).status, 200); } finally { console.log = orig; }
  assert.deepEqual(s.mock.st.mailSent, ['grp@test.dev']);
  const l = logs.find(x => x.includes('[forgot]')); assert.ok(l && /status=200/.test(l)); assert.ok(!l.includes('grp@test.dev'));
}));

test('forgot: log ข้อความ error ของ TB แบบ mask และยังตอบ ok', async () => {
  const { createRoutes } = require('../routes');
  const cfg = loadConfig({ TB_HOST: 'http://x', TB_API_KEY: 'k', TB_CUSTOMER_MEMBERS_ID: 'm', TB_CUSTOMER_STAFF_ID: 's' });
  const tb = { anon: async () => ({ ok: false, status: 429, data: { message: 'Too many for who@test.dev token abcdefghijklmnopqrstuvwxyz123' } }) };
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  let r; try { r = await createRoutes(cfg, tb).forgot({}, { ip: '1.1.1.1', body: { email: 'who@test.dev' } }); } finally { console.log = orig; }
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.ok(/status=429/.test(logs[0]) && !logs[0].includes('who@test.dev') && !logs[0].includes('abcdefghijklmnop'), logs[0]);
});

test('me: ต้องมี token; ปลอม/รูปแบบผิด/หมดอายุ -> 401; ไม่ถูกส่งให้ TB ถ้ารูปแบบผิด', run(async s => {
  assert.equal((await s.call('GET', '/api/me')).status, 401);
  assert.equal((await s.call('GET', '/api/me', { token: 'garbage' })).body.error.code, 'TOKEN_INVALID');
  const before = s.mock.st.authUserCalls;
  assert.equal((await s.call('GET', '/api/me', { token: s.mock.makeToken('someone', 900) })).status, 401);   // รูปแบบถูกแต่ TB ไม่รู้จัก
  assert.equal(s.mock.st.authUserCalls, before + 1);
  const exp = await s.call('GET', '/api/me', { token: s.mock.makeToken('someone', -10) });
  assert.equal(exp.status, 401); assert.equal(exp.body.error.code, 'TOKEN_EXPIRED');
  assert.equal(s.mock.st.authUserCalls, before + 1);   // หมดอายุตัดสินในเครื่อง
  assert.equal((await s.call('GET', '/api/me', { token: s.mock.addOutsider() })).status, 403);
}));

test('me: อ่าน/แก้โปรไฟล์ รถ บัตรเดโม (last4 เท่านั้น)', run(async s => {
  const { body: { token } } = await s.signup('m@test.dev');
  const me = await s.call('GET', '/api/me', { token });
  assert.equal(me.status, 200); assert.equal(me.body.email, 'm@test.dev'); assert.equal(me.body.name, 'ทดสอบ');
  const put = await s.call('PUT', '/api/me', { token, body: { name: 'ชื่อใหม่', cars: [{ plate: 'กก 1' }, { plate: 'ขข 2', label: 'รถเรา' }], pays: [{ label: 'บัตรเดโม', brand: 'visa', last4: '4242' }] } });
  assert.equal(put.status, 200); assert.equal(put.body.name, 'ชื่อใหม่'); assert.equal(put.body.cars.length, 2);
  assert.deepEqual(Object.keys(put.body.pays[0]).sort(), ['brand', 'id', 'label', 'last4']);
  const again = await s.call('GET', '/api/me', { token });
  assert.deepEqual(again.body.pays, put.body.pays);
  // แก้ส่วนเดียวไม่กระทบส่วนอื่น
  const p2 = await s.call('PUT', '/api/me', { token, body: { name: 'อีกชื่อ' } });
  assert.equal(p2.body.cars.length, 2); assert.equal(p2.body.pays.length, 1);
}));

test('me: ปฏิเสธเลขบัตรเต็ม/CVV/ช่องแปลก/role', run(async s => {
  const { body: { token } } = await s.signup('c@test.dev');
  const bad = body => s.call('PUT', '/api/me', { token, body });
  assert.equal((await bad({ pays: [{ label: 'x', brand: 'v', last4: '4242', number: '4242424242424242' }] })).status, 400);
  assert.equal((await bad({ pays: [{ label: 'x', brand: 'v', last4: '4242', cvv: '123' }] })).status, 400);
  assert.equal((await bad({ pays: [{ label: 'x', brand: 'v', last4: '4242424242424242' }] })).status, 400);
  assert.equal((await bad({ pays: [{ label: '4242 4242 4242 4242', brand: 'v', last4: '4242' }] })).status, 400);
  assert.equal((await bad({ role: 'master' })).status, 400);
  assert.equal((await bad({ cars: [{ plate: '<script>' }] })).status, 400);
  assert.equal((await bad({ cars: Array(11).fill({ plate: 'a' }) })).status, 400);
  assert.equal((await bad({})).status, 400);
  assert.equal((await s.call('GET', '/api/me', { token })).body.pays.length, 0);
}));

test('ผู้ใช้ A อ่าน/แก้ของ B ไม่ได้ (uid มาจาก token เท่านั้น)', run(async s => {
  const A = (await s.signup('ua@test.dev')).body, B = (await s.signup('ub@test.dev')).body;
  await s.call('PUT', '/api/me', { token: B.token, body: { name: 'ของบี', cars: [{ plate: 'บบ 9' }] } });
  // พยายามส่ง id/uid ของ B ผ่าน body, query หรือ header -> ถูกปฏิเสธหรือไม่มีผล
  assert.equal((await s.call('PUT', '/api/me', { token: A.token, body: { id: B.user.id, name: 'แฮ็ก' } })).status, 400);
  const viaQuery = await s.call('GET', `/api/me?id=${B.user.id}&uid=${B.user.id}`, { token: A.token, headers: { 'X-Uid': B.user.id } });
  assert.equal(viaQuery.body.id, A.user.id); assert.equal(viaQuery.body.email, 'ua@test.dev'); assert.deepEqual(viaQuery.body.cars, [{ plate: '1กข 234' }]);
  await s.call('PUT', '/api/me', { token: A.token, body: { name: 'เอ', cars: [] } });
  const b = await s.call('GET', '/api/me', { token: B.token });
  assert.equal(b.body.name, 'ของบี'); assert.deepEqual(b.body.cars, [{ plate: 'บบ 9' }]);
  // ไม่มี endpoint รับ id ของคนอื่น
  assert.equal((await s.call('GET', '/api/me/' + B.user.id, { token: A.token })).status, 404);
}));

test('ตรวจ token ผ่าน TB แล้ว cache 60 วิ (ไม่ยิงซ้ำ), หมดแล้วตรวจใหม่', async () => {
  let t = 1_000_000; const clock = () => t;
  const s = await setup({}, clock);
  try {
    const { body: { token } } = await s.signup('ca@test.dev');
    const n0 = s.mock.st.authUserCalls;
    await s.call('GET', '/api/me', { token }); await s.call('GET', '/api/me', { token }); await s.call('GET', '/api/me', { token });
    assert.equal(s.mock.st.authUserCalls, n0 + 1);
    t += 61_000;
    await s.call('GET', '/api/me', { token });
    assert.equal(s.mock.st.authUserCalls, n0 + 2);
  } finally { await s.close(); }
});

test('CORS: อนุญาต origin ของเว็บและ localhost, ปฏิเสธ origin อื่น, preflight 204', run(async s => {
  const pre = await s.call('OPTIONS', '/api/login', { headers: { Origin: WEB, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), WEB);
  const lo = await s.call('GET', '/api/me', { headers: { Origin: 'http://localhost:5500' } });
  assert.equal(lo.headers.get('access-control-allow-origin'), 'http://localhost:5500');
  const evil = await s.call('POST', '/api/login', { headers: { Origin: 'https://evil.example' }, body: { email: 'a@b.co', password: 'x12345678' } });
  assert.equal(evil.status, 403); assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal(s.mock.st.calls.filter(c => c.path === '/api/auth/login').length, 0);
}));

test('API key ไม่รั่วถึง browser และถูกใช้เฉพาะ endpoint ฝั่งแอดมิน', run(async s => {
  const su = await s.signup('kk@test.dev');
  const all = JSON.stringify(su.body) + JSON.stringify((await s.call('GET', '/api/me', { token: su.body.token })).body);
  assert.ok(!all.includes(KEY));
  for (const c of s.mock.st.calls) {
    if (c.path === '/api/auth/login' || c.path === '/api/noauth/activate' || c.path === '/api/auth/token' || c.path === '/api/noauth/resetPasswordByEmail') assert.equal(c.auth, '');
    if (c.path === '/api/auth/user') assert.equal(c.auth, 'Bearer');
  }
  assert.ok(s.mock.st.calls.some(c => c.auth === 'ApiKey'));
}));

test('ข้อผิดพลาดทั่วไป: 404, 405, body ใหญ่ 413, TB ล่ม 502', async () => {
  const s = await setup();
  try {
    assert.equal((await s.call('GET', '/nope')).status, 404);
    assert.equal((await s.call('GET', '/api/login')).status, 405);
    assert.equal((await s.call('POST', '/api/login', { body: { email: 'a@b.co', password: 'x'.repeat(20000) } })).status, 413);
    await s.mock.close();
    const r = await s.call('POST', '/api/login', { body: { email: 'a@b.co', password: 'x12345678' } });
    assert.equal(r.status, 502); assert.equal(r.body.error.code, 'UPSTREAM');
  } finally { s.srvClose(); }
});
