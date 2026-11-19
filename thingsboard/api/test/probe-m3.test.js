// เทสต์ scripts/probe-m3.js บน mock เท่านั้น (ไม่แตะ ThingsBoard จริง)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { main, assertAllowed } = require('../../scripts/probe-m3');

const KEY = 'mock-api-key-123', ASSET = 'asset-aaa', LOT = 'dev-lot-bbb', MEMBERS = 'cust-members', STAFF = 'cust-staff';
const PLANTED = 'SECRET-PLATE-กข9999';
const TARGET = '11111111-2222-3333-4444-555555555555', TARGET_MAIL = 'target-person@x.test';

// mock ที่ปรับพฤติกรรมได้: leak = 'none' | 'asset' | 'user' | 'device'
function mockTb(opts = {}) {
  const calls = [];
  const users = {
    'm@x.test': { pw: 'member-pass-1', id: opts.memberId || 'uid-member', customer: opts.memberCustomer || MEMBERS, authority: 'CUSTOMER_USER' },
    's@x.test': { pw: 'staff-pass-1', id: 'uid-staff', customer: STAFF, authority: 'CUSTOMER_USER' },
    't@x.test': { pw: 'tenant-pass-1', id: 'uid-tenant', customer: null, authority: opts.tenantAuth || 'TENANT_ADMIN' },
  };
  const byTok = {};
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x'), p = url.pathname, auth = req.headers['x-authorization'] || '';
      calls.push({ method: req.method, path: p });
      const out = (code, data, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
      if (p === '/api/auth/login' && req.method === 'POST') {
        const b = JSON.parse(raw), u = users[b.username];
        if (!u || u.pw !== b.password) return out(401, { message: 'bad' });
        const tok = 'jwt-' + u.id + '-abcdef'; byTok[tok] = u; return out(200, { token: tok, refreshToken: 'ref-' + u.id });
      }
      const isKey = auth === 'ApiKey ' + KEY, u = byTok[auth.replace('Bearer ', '')];
      if (p === '/api/auth/user') return u ? out(200, { id: { id: u.id }, authority: u.authority, customerId: u.customer ? { id: u.customer } : null }) : out(401, {});
      if (!isKey && !u) return out(401, {});
      const date = { Date: new Date(Date.now() + (opts.skewMs || 0)).toUTCString() };
      let m;
      if (p === `/api/plugins/telemetry/ASSET/${ASSET}/values/attributes/SERVER_SCOPE`) {
        if (!isKey && opts.leak !== 'asset') return out(403, {});
        const items = [{ key: 'config', value: { floors: 1, slots: 4 }, lastUpdateTs: 1 }, { key: 'closed', value: {}, lastUpdateTs: 1 }, { key: 'bk_1-1', value: [{ car: PLANTED }], lastUpdateTs: 1 }];
        const want = url.searchParams.get('keys');
        return out(200, want ? items.filter(i => want.split(',').includes(i.key)) : items, date);
      }
      if (p === `/api/plugins/telemetry/DEVICE/${LOT}/values/timeseries`) {
        if (!isKey && opts.leak !== 'device') return out(403, {});
        return out(200, { hb: [{ ts: 1, value: '1' }] });
      }
      if ((m = /^\/api\/plugins\/telemetry\/USER\/([^/]+)\/values\/attributes\/SERVER_SCOPE$/.exec(p))) {
        if (isKey) return out(200, []);
        if (m[1] === u.id) return out(opts.ownBlocked ? 403 : 200, [{ key: 'books', value: [{ car: PLANTED }] }, { key: 'pays', value: [] }]);
        return opts.leak === 'user' || opts.leak === 'e1' ? out(200, [{ key: 'books', value: [{ car: PLANTED }] }]) : out(403, {});
      }
      // P10e: รายละเอียดผู้ใช้ และลิสต์ผู้ใช้ของ customer (leak = 'e2' / 'e3')
      if ((m = /^\/api\/user\/([^/]+)$/.exec(p))) {
        if (isKey) return m[1] === TARGET ? out(200, { id: { id: TARGET }, authority: opts.targetAuth || 'CUSTOMER_USER', customerId: { id: opts.targetCustomer || MEMBERS }, email: TARGET_MAIL }) : out(404, {});
        return opts.leak === 'e2' ? out(200, { email: TARGET_MAIL, name: PLANTED }) : out(403, {});
      }
      if (p === `/api/customer/${MEMBERS}/users`) {
        if (!isKey && opts.leak !== 'e3') return out(403, {});
        return out(200, { data: [{ email: TARGET_MAIL }, { email: 'b@x.test' }, { email: 'c@x.test' }], totalElements: 3 });
      }
      out(404, {});
    });
  });
  return { calls, listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))), close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

const baseEnv = port => ({
  TB_HOST: 'http://127.0.0.1:' + port, TB_API_KEY: KEY, TB_ASSET_ID: ASSET, TB_SENSOR_DEVICE_ID: LOT,
  TB_CUSTOMER_MEMBERS_ID: MEMBERS, TB_CUSTOMER_STAFF_ID: STAFF,
  PROBE_MEMBER_EMAIL: 'm@x.test', PROBE_MEMBER_PASSWORD: 'member-pass-1', PROBE_STAFF_EMAIL: 's@x.test', PROBE_STAFF_PASSWORD: 'staff-pass-1',
});
async function go(opts, argv, envPatch = {}, ask) {
  const m = mockTb(opts), port = await m.listen(), lines = [];
  try {
    const code = await main({ argv, env: { ...baseEnv(port), ...envPatch }, out: s => lines.push(s), ask });
    return { code, text: lines.join('\n'), calls: m.calls };
  } finally { await m.close(); }
}
const SECRETS = [KEY, ASSET, LOT, 'member-pass-1', 'staff-pass-1', 'jwt-uid-member', 'jwt-uid-staff', 'ref-uid', 'uid-member', 'uid-staff', 'm@x.test', 's@x.test', PLANTED];

test('dry-run (ค่าเริ่มต้น): ไม่ยิงอะไรเลย พิมพ์แผน exit 0', async () => {
  const lines = [];
  const code = await main({ argv: [], env: baseEnv(1), fetchImpl: () => { throw new Error('ห้ามยิงใน dry-run'); }, out: s => lines.push(s) });
  const t = lines.join('\n');
  assert.equal(code, 0);
  assert.match(t, /dry-run: ยังไม่ยิงอะไร/);
  assert.match(t, /P10b/);
  for (const s of SECRETS) assert.ok(!t.includes(s), 'dry-run ต้องไม่พิมพ์ ' + s);
});

test('--run บนระบบที่ปิดกั้นถูกต้อง: ผ่านทุกข้อ P10b, exit 0, ไม่มี secret/ข้อมูลในผลลัพธ์', async () => {
  const r = await go({}, ['--run']);
  assert.equal(r.code, 0, r.text);
  const b = r.text.split('\n').filter(l => /P10b|P10c/.test(l) && /ต้องไม่ได้/.test(l));
  assert.equal(b.length, 6, r.text);                       // 3 ข้อ x 2 บัญชี
  assert.ok(b.every(l => /^\[ผ่าน\]/.test(l) && /HTTP 403/.test(l)), r.text);
  assert.match(r.text, /P10a อ่าน attribute ของตัวเองตรง  HTTP 200/);
  for (const s of SECRETS) assert.ok(!r.text.includes(s), 'ผลลัพธ์ต้องไม่มี ' + s);
  // เฉพาะ GET และล็อกอิน 1 ครั้งต่อบัญชี
  assert.deepEqual(r.calls.filter(c => c.method !== 'GET'), [{ method: 'POST', path: '/api/auth/login' }, { method: 'POST', path: '/api/auth/login' }]);
});

test('P10b = 200 (asset อ่านได้): ไม่ผ่าน, exit 2, สั่งหยุด M3, พิมพ์แค่จำนวน ไม่พิมพ์เนื้อหา', async () => {
  const r = await go({ leak: 'asset' }, ['--run']);
  assert.equal(r.code, 2);
  assert.match(r.text, /\[ไม่ผ่าน\].*asset ParkHere-Data.*HTTP 200.*จำนวนรายการ\/คีย์ = 3/);
  assert.match(r.text, /ต้องหยุด M3/);
  assert.ok(!r.text.includes(PLANTED), 'ห้ามพิมพ์เนื้อข้อมูล');
  for (const s of SECRETS) assert.ok(!r.text.includes(s));
});

test('P10b = 200 (อ่าน attribute ของคนอื่นได้ / อ่าน device ได้) ก็ exit 2', async () => {
  for (const leak of ['user', 'device']) {
    const r = await go({ leak }, ['--run']);
    assert.equal(r.code, 2, leak + '\n' + r.text);
    assert.match(r.text, /ต้องหยุด M3/);
    assert.ok(!r.text.includes(PLANTED));
  }
});

test('บัญชี Tenant admin ถูกปฏิเสธ (ผลจะหลอก) และไม่ถูกนับเป็นผ่าน', async () => {
  const r = await go({}, ['--run', '--no-staff'], { PROBE_MEMBER_EMAIL: 't@x.test', PROBE_MEMBER_PASSWORD: 'tenant-pass-1' });
  assert.match(r.text, /ไม่ใช่ CUSTOMER_USER/);
  assert.ok(!/P10b สมาชิก/.test(r.text));
  assert.notEqual(r.code, 0);
});

test('--no-staff: ข้ามการเทียบข้ามผู้ใช้ และไม่ล็อกอิน staff', async () => {
  const r = await go({}, ['--run', '--no-staff']);
  assert.match(r.text, /\[ข้าม\].*ผู้ใช้อื่น/);
  assert.equal(r.calls.filter(c => c.method === 'POST').length, 1);
});

test('รหัสผ่านผิด: ไม่ลองซ้ำ (ล็อกอินครั้งเดียวต่อบัญชี) และไม่พิมพ์รหัส', async () => {
  const r = await go({}, ['--run', '--no-staff'], { PROBE_MEMBER_PASSWORD: 'wrong-pass-zzz' });
  assert.equal(r.calls.filter(c => c.path === '/api/auth/login').length, 1);
  assert.ok(!r.text.includes('wrong-pass-zzz'));
  assert.match(r.text, /ล็อกอินไม่สำเร็จ/);
});

test('ไม่ตั้ง env รหัสผ่าน: ถามผ่านตัวถาม (hidden) แทนที่จะอ่านจากไฟล์', async () => {
  const asked = [];
  const ask = { line: async p => { asked.push(p); return 'm@x.test'; }, hidden: async p => { asked.push(p); return 'member-pass-1'; } };
  const r = await go({}, ['--run', '--no-staff'], { PROBE_MEMBER_EMAIL: '', PROBE_MEMBER_PASSWORD: '' }, ask);
  assert.deepEqual(asked, ['PROBE_MEMBER_EMAIL', 'PROBE_MEMBER_PASSWORD']);
  assert.equal(r.code, 0, r.text);
  assert.ok(!r.text.includes('member-pass-1'));
});

test('ตัวควบคุมไม่ผ่าน (API key อ่าน asset ไม่ได้): 403 ไม่ถูกนับเป็นผ่าน', async () => {
  const r = await go({}, ['--run', '--no-staff'], { TB_API_KEY: 'wrong-key' });
  assert.match(r.text, /สรุปไม่ได้เพราะตัวควบคุมไม่ผ่าน/);
  assert.ok(!/\[ผ่าน\].*asset ParkHere-Data ตรง/.test(r.text));
});

test('โค้ดอ่านอย่างเดียว: assertAllowed ปฏิเสธทุก method ที่ไม่ใช่ GET ยกเว้น POST /api/auth/login', () => {
  assertAllowed('GET', '/api/anything');
  assertAllowed('POST', '/api/auth/login');
  for (const [m, p] of [['POST', '/api/plugins/telemetry/USER/x/attributes/SERVER_SCOPE'], ['POST', '/api/user'], ['PUT', '/api/x'], ['DELETE', '/api/x'], ['PATCH', '/api/x'], ['POST', '/api/auth/login/x']])
    assert.throws(() => assertAllowed(m, p), /ไม่อนุญาต/, m + ' ' + p);
});

test('ไฟล์สคริปต์ไม่มีการเรียก method เขียนนอกเหนือจากที่อนุญาต (ตรวจจากข้อความโค้ด)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'probe-m3.js'), 'utf8');
  const calls = [...src.matchAll(/send\(\s*'([A-Z]+)'\s*,\s*([^,)]+)/g)].map(m => [m[1], m[2].trim()]);
  assert.ok(calls.length >= 8);
  for (const [method, p] of calls) {
    if (method === 'GET') continue;
    assert.equal(method, 'POST'); assert.equal(p, "'/api/auth/login'");
  }
  assert.ok(!/['"](PUT|DELETE|PATCH)['"]/.test(src.replace(/\/\/.*$/gm, '').replace(/\[M, P\].*$/gm, '').replace(/assertAllowed[^]*?\n}\n/, '')), 'ห้ามมี method PUT/DELETE/PATCH ในโค้ด');
  assert.ok(!/attributes\/(SERVER|CLIENT|SHARED)_SCOPE'\s*,\s*\{\s*method/.test(src));
  assert.ok(!/fs\.(write|append)/.test(src), 'ห้ามเขียนไฟล์');
});

// ---------- P10e : สมาชิกอ่านสมาชิกคนอื่นใน customer เดียวกัน ----------
const E = { PROBE_TARGET_USER_ID: TARGET };
const P10E_SECRETS = [...SECRETS, TARGET, TARGET_MAIL, MEMBERS, 'b@x.test', 'c@x.test'];
const tail = t => t.split('\n').filter(l => /P10e/.test(l));

test('P10e ปิดกั้นถูกต้อง: ผ่าน 3 ข้อ (403), ตัวควบคุมผ่าน, exit 0, เฉพาะ GET + ล็อกอินสมาชิก 1 ครั้ง, ไม่มี secret/ข้อมูล', async () => {
  const r = await go({}, ['--run', '--only-p10e'], E);
  assert.equal(r.code, 0, r.text);
  const ok = r.text.split('\n').filter(l => /^\[ผ่าน\] P10e-[123]/.test(l) && /HTTP 403/.test(l));
  assert.equal(ok.length, 3, r.text);
  assert.match(r.text, /\[ข้อมูล\] P10e ตัวควบคุม.*HTTP 200.*ผ่าน/);
  assert.ok(!/P10b|P10c|P9 |P7 /.test(r.text.replace(/probe-m3 --only-p10e[^\n]*/, '')), 'only-p10e ต้องไม่รัน P9/P7/P10a-c');
  assert.deepEqual(r.calls.filter(c => c.method !== 'GET'), [{ method: 'POST', path: '/api/auth/login' }]);
  assert.ok(!r.calls.some(c => c.path.includes('/ASSET/') || c.path.includes('/DEVICE/')), 'ไม่แตะ asset/device');
  for (const s of P10E_SECRETS) assert.ok(!r.text.includes(s), 'ผลลัพธ์ต้องไม่มี ' + s);
});

test('P10e ข้อใดข้อหนึ่งได้ 200: ไม่ผ่าน, exit 2, พิมพ์ทางแก้ 2 ทาง, พิมพ์แค่จำนวน ไม่พิมพ์เนื้อหา/อีเมล', async () => {
  for (const [leak, label, n] of [['e1', 'P10e-1', 1], ['e2', 'P10e-2', 2], ['e3', 'P10e-3', 3]]) {
    const r = await go({ leak }, ['--run', '--only-p10e'], E);
    assert.equal(r.code, 2, leak + '\n' + r.text);
    assert.match(r.text, new RegExp('\\[ไม่ผ่าน\\] ' + label + '.*HTTP 200'), r.text);
    assert.match(r.text, /ทางเร็ว/); assert.match(r.text, /ย้าย profile\/cars\/pays\/books\/rcp/);
    assert.match(r.text, /ห้ามเปิด BOOKINGS_WRITE/);
    if (leak === 'e3') assert.match(r.text, /จำนวนรายการ\/คีย์ = 3 /);
    // ข้ออื่นของ P10e ยังถูกรันและผ่าน (รายงานครบในรอบเดียว)
    assert.equal(tail(r.text).filter(l => /^\[ผ่าน\]/.test(l)).length, 2, r.text);
    for (const s of P10E_SECRETS) assert.ok(!r.text.includes(s), leak + ' ต้องไม่มี ' + s);
  }
});

test('P10e ตัวควบคุมเป้าไม่ผ่าน (เป้าอยู่ customer อื่นนอก Members/Staff / ไม่ใช่ CUSTOMER_USER / ID ไม่มีจริง): "ไม่แน่ใจ" ไม่นับผ่าน exit 1 แต่ P10e-3 ไม่ล้มตาม', async () => {
  for (const [opts, env, pat] of [
    [{ targetCustomer: 'cust-other' }, E, /ไม่อยู่ใน customer ParkHere Members หรือ ParkHere Staff/],
    [{ targetAuth: 'TENANT_ADMIN' }, E, /ไม่ใช่ CUSTOMER_USER/],
    [{}, { PROBE_TARGET_USER_ID: '99999999-2222-3333-4444-555555555555' }, /API key อ่านเป้าไม่ได้/],
  ]) {
    const r = await go(opts, ['--run', '--only-p10e'], env);
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, pat);
    const t = tail(r.text);
    assert.deepEqual(t.filter(l => /^\[ผ่าน\]/.test(l)).map(l => l.slice(0, 20)).length, 1, r.text);   // เหลือ P10e-3 ข้อเดียวที่ตัดสินได้
    assert.ok(t.some(l => /^\[ผ่าน\] P10e-3/.test(l) && /HTTP 403/.test(l)), r.text);
    assert.equal(t.filter(l => /^\[ไม่แน่ใจ\]/.test(l)).length, 3, r.text);   // ตัวควบคุมเป้า + P10e-1 + P10e-2
    assert.match(r.text, /สรุปไม่ได้เพราะตัวควบคุมไม่ผ่าน/);
  }
});

test('P10e: ตัวควบคุมเป้าไม่ผ่านแต่สมาชิกอ่านได้ 200 ก็ยังเป็นช่องโหว่ (exit 2)', async () => {
  const r = await go({ targetCustomer: 'cust-other', leak: 'e2' }, ['--run', '--only-p10e'], E);
  assert.equal(r.code, 2, r.text);
});

// ---------- แผน 2026-11-18: เป้า P10e-1/2 = staff (คนละ customer), P10e-3 ใช้สมาชิกคนเดียว ----------
test('P10e เป้าเป็น staff (คนละ customer): ตัวควบคุมเป้าผ่าน, P10e-1/2/3 ผ่านหมด (403), exit 0, ตัวควบคุมลิสต์ไม่ล้มเพราะเป้าอยู่คนละ customer', async () => {
  const r = await go({ targetCustomer: STAFF }, ['--run', '--only-p10e'], E);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\[ข้อมูล\] P10e ตัวควบคุมเป้า.*HTTP 200.*ผ่าน \(เป้า = staff คนละ customer\)/);
  assert.match(r.text, /\[ข้อมูล\] P10e ตัวควบคุมลิสต์.*HTTP 200.*ผ่าน \(หน้านี้มี 3 บัญชี\)/);
  assert.equal(r.text.split('\n').filter(l => /^\[ผ่าน\] P10e-[123]/.test(l) && /HTTP 403/.test(l)).length, 3, r.text);
  assert.deepEqual(r.calls.filter(c => c.method !== 'GET'), [{ method: 'POST', path: '/api/auth/login' }]);   // ไม่ล็อกอิน staff
  for (const s of P10E_SECRETS) assert.ok(!r.text.includes(s), 'ผลลัพธ์ต้องไม่มี ' + s);
});

test('P10e เป้าเป็น staff แต่ไม่ได้ตั้ง TB_CUSTOMER_STAFF_ID: ไม่แน่ใจ (บอกให้ตั้ง) ไม่ใช่ผ่าน', async () => {
  const r = await go({ targetCustomer: STAFF }, ['--run', '--only-p10e'], { ...E, TB_CUSTOMER_STAFF_ID: '' });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /ต้องตั้ง TB_CUSTOMER_STAFF_ID/);
  assert.ok(tail(r.text).some(l => /^\[ผ่าน\] P10e-3/.test(l)), 'P10e-3 ไม่ขึ้นกับเป้า');
});

test('P10e --only-p10e กด Enter เปล่าที่ช่องเป้า: ข้าม P10e-1/2 รันแค่ P10e-3 และไม่ยิง /api/user/', async () => {
  const ask = { line: async () => '', hidden: async () => 'member-pass-1' };
  const r = await go({}, ['--run', '--only-p10e'], { PROBE_TARGET_USER_ID: '', PROBE_MEMBER_PASSWORD: '' }, ask);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\[ข้าม\] P10e-1\/2/);
  assert.match(r.text, /\[ผ่าน\] P10e-3.*HTTP 403/);
  assert.ok(!r.calls.some(c => c.path.startsWith('/api/user/')));
});

test('P10e-3: สมาชิกที่ล็อกอินไม่อยู่ใน customer Members = ไม่แน่ใจ ไม่นับผ่าน', async () => {
  const r = await go({ memberCustomer: 'cust-elsewhere' }, ['--run', '--only-p10e'], E);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /\[ไม่แน่ใจ\] P10e-3.*สรุปไม่ได้เพราะตัวควบคุมไม่ผ่าน/);
  assert.match(r.text, /ไม่อยู่ใน customer ParkHere Members/);
});

test('--tight (P10e-0): หลังปรับ role อ่านของตัวเองตรงไม่ได้ = ผ่าน exit 0; ยังอ่านได้ (200) = ไม่ผ่าน exit 2 พร้อมบอกว่า role ยังไม่ถูกปรับ', async () => {
  const ok = await go({ targetCustomer: STAFF, ownBlocked: true }, ['--run', '--only-p10e', '--tight'], E);
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /\[ผ่าน\] P10e-0.*HTTP 403/);
  assert.equal(ok.text.split('\n').filter(l => /^\[ผ่าน\] P10e-[0123]/.test(l)).length, 4, ok.text);
  const bad = await go({ targetCustomer: STAFF }, ['--run', '--only-p10e', '--tight'], E);   // mock ค่าเริ่มต้น: อ่านของตัวเองได้ 200 (เหมือนก่อนปรับ role)
  assert.equal(bad.code, 2, bad.text);
  assert.match(bad.text, /\[ไม่ผ่าน\] P10e-0.*HTTP 200/);
  assert.match(bad.text, /P10e-0 ได้ 200: role ของกลุ่ม Customer Users ยังให้ Read Attributes อยู่/);
  assert.ok(!bad.text.includes(PLANTED));
  for (const s of P10E_SECRETS) assert.ok(!bad.text.includes(s) && !ok.text.includes(s));
  // ไม่ใส่ --tight = ไม่มี P10e-0
  const no = await go({ targetCustomer: STAFF, ownBlocked: true }, ['--run', '--only-p10e'], E);
  assert.ok(!/P10e-0/.test(no.text));
});

test('P10e: เป้าเป็นบัญชีเดียวกับผู้ล็อกอิน หรือไม่ใช่ UUID = ไม่แน่ใจ และไม่ยิงอ่านเป้า', async () => {
  const same = await go({ memberId: TARGET }, ['--run', '--only-p10e'], E);
  assert.match(same.text, /\[ไม่แน่ใจ\] P10e.*เป้าเป็นบัญชีเดียวกับ/);
  assert.ok(!same.calls.some(c => c.path.startsWith('/api/user/')));
  assert.notEqual(same.code, 0);
  const bad = await go({}, ['--run', '--only-p10e'], { PROBE_TARGET_USER_ID: 'ไม่ใช่ไอดี' });
  assert.match(bad.text, /\[ไม่แน่ใจ\] P10e.*ไม่ใช่ User ID/);
  assert.ok(!bad.text.includes('ไม่ใช่ไอดี  '), 'ไม่สะท้อนค่าที่กรอก');
  assert.ok(!bad.calls.some(c => c.path.startsWith('/api/user/')));
  assert.notEqual(bad.code, 0);
});

test('P10e: ไม่ตั้งเป้า (รันปกติ) = ข้าม P10e ไม่ยิง /api/user และพฤติกรรมเดิมไม่เปลี่ยน', async () => {
  const r = await go({}, ['--run', '--no-staff']);
  assert.equal(r.code, 0, r.text);
  assert.ok(!/P10e-/.test(r.text));
  assert.ok(!r.calls.some(c => c.path.startsWith('/api/user/') || c.path.includes('/api/customer/')));
});

test('P10e: รันรวมกับ P10a-c (ตั้งเป้า ไม่ใช้ --only) ได้ครบและไม่ล็อกอินเพิ่ม', async () => {
  const r = await go({}, ['--run', '--no-staff'], E);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\[ผ่าน\] P10b/); assert.match(r.text, /\[ผ่าน\] P10e-3/);
  assert.equal(r.calls.filter(c => c.method === 'POST').length, 1);
});

test('P10e --only-p10e: ไม่ตั้ง env เป้า = ถามผ่านตัวถาม (line) แล้วไม่พิมพ์ค่านั้น', async () => {
  const asked = [];
  const ask = { line: async p => { asked.push(p); return TARGET; }, hidden: async p => { asked.push(p); return 'member-pass-1'; } };
  const r = await go({}, ['--run', '--only-p10e'], { PROBE_MEMBER_PASSWORD: '', PROBE_TARGET_USER_ID: '' }, ask);
  assert.deepEqual(asked, ['PROBE_TARGET_USER_ID', 'PROBE_MEMBER_PASSWORD']);
  assert.equal(r.code, 0, r.text);
  assert.ok(!r.text.includes(TARGET));
});

test('P10e dry-run: พิมพ์แผน ไม่ยิง ไม่พิมพ์เป้า/อีเมล', async () => {
  const lines = [];
  const code = await main({ argv: ['--only-p10e'], env: { ...baseEnv(1), ...E }, fetchImpl: () => { throw new Error('ห้ามยิงใน dry-run'); }, out: s => lines.push(s) });
  const t = lines.join('\n');
  assert.equal(code, 0);
  assert.match(t, /P10e-1.*P10e-2.*P10e-3/s); assert.match(t, /PROBE_TARGET_USER_ID=ตั้งแล้ว/);
  for (const s of P10E_SECRETS) assert.ok(!t.includes(s), 'dry-run ต้องไม่พิมพ์ ' + s);
});

test('P10e: คำขอใหม่ทั้งหมดเป็น GET (ตรวจจากข้อความโค้ด) และไม่เขียนเป้าลงไฟล์', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'probe-m3.js'), 'utf8');
  const e = src.slice(src.indexOf('// ---------- P10e'));
  assert.ok(/send\('GET', UD/.test(e) && /send\('GET', U\(target\)/.test(e) && /send\('GET', '\/api\/customer\//.test(e));
  assert.ok(!/send\('(POST|PUT|DELETE|PATCH)'/.test(e));
  assert.ok(!/target[^\n]*(writeFile|appendFile)/.test(src));
});
