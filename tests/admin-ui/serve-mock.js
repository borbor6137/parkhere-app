// เซิร์ฟเวอร์ทดสอบหน้า admin/master บน mock ThingsBoard เท่านั้น (ไม่ต่อ ThingsBoard จริง ไม่ใช้พอร์ต 10000)
//   node tests/admin-ui/serve-mock.js [apiPort=18080] [webPort=18081]
// เปิดหน้า: http://127.0.0.1:18081/admin.html?api=http://127.0.0.1:18080
// ตัวควบคุมการทดสอบ (เฉพาะสคริปต์นี้): GET /__ctl?op=occ&k=1-2&v=1|0|null · op=bar&k=1-2&v=1|0 · op=board&v=on|off · env CONFIG_MASTER_ONLY=1 ตอนรัน · op=pw · op=demote · op=rpcfail
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createMockTb, KEY, DEVICE_ID, ASSET_ID } = require('../../thingsboard/api/test/mock-tb');
const { loadConfig } = require('../../thingsboard/api/config');
const { createServer } = require('../../thingsboard/api/server');
const { createRoutes } = require('../../thingsboard/api/routes');

const API = +process.argv[2] || 18080, WEB = +process.argv[3] || 18081;
if (API === 10000 || WEB === 10000) throw new Error('ห้ามใช้พอร์ต 10000');
const MEMBERS = 'members-cust', STAFF = 'staff-cust', PW = 'Pw-' + require('node:crypto').randomBytes(9).toString('hex') + 'Aa1!';   // สุ่มใหม่ทุกครั้งที่รัน ไม่เก็บในไฟล์
const ROOT = path.join(__dirname, '..', '..');
const FL = +process.env.MOCK_FLOORS || 2, SL = +process.env.MOCK_SLOTS || 8;   // ผังใหม่: MOCK_FLOORS=3 MOCK_SLOTS=6
const CFG = { floors: FL, slots: SL, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 };

(async () => {
  const mock = createMockTb({ membersId: MEMBERS, staffId: STAFF });
  const tbPort = await mock.listen();
  const env = { TB_HOST: 'http://127.0.0.1:' + tbPort, TB_API_KEY: KEY, TB_CUSTOMER_MEMBERS_ID: MEMBERS, TB_CUSTOMER_STAFF_ID: STAFF, WEB_ORIGINS: 'http://127.0.0.1:' + WEB,
    TB_ASSET_ID: ASSET_ID, TB_SENSOR_DEVICE_ID: DEVICE_ID, LIVE_POLL_MS: '400', LOT_ATTR_MS: '400', LOT_CACHE_MS: '300', LIVE_PING_MS: '5000',
    BARRIER_COOLDOWN_MS: '1500', ADMIN_WRITE_RATE_MAX: '200', ADMIN_LIST_RATE_MAX: '200', ADMIN_LIST_CACHE_MS: '1000', LEAVE_RATE_MAX: '200', BARRIER_ADMIN_RATE_MAX: '200', BARRIER_RATE_MAX: '200', ...(process.env.CONFIG_MASTER_ONLY ? { CONFIG_MASTER_ONLY: '1' } : {}) };
  const cfg = loadConfig(env);
  const routes = createRoutes(cfg, undefined, undefined, { writesEnabled: true, barrierEnabled: true });
  const srv = createServer(cfg, routes);
  await new Promise(r => srv.listen(API, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + API;
  let n = 0;
  const call = async (method, p, body, token) => {
    const h = { 'X-Forwarded-For': `10.7.0.${++n}` }; if (body !== undefined) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
  };
  const user = async (email, name) => { const r = await call('POST', '/api/signup', { email, password: PW, name }); if (r.status !== 201) throw new Error('signup ' + r.status); return { token: r.body.token, uid: r.body.user.id }; };

  mock.setAttr('config', CFG);
  mock.st.rpcApply = true;
  const tel = { hb: 1 }; for (let f = 1; f <= FL; f++) for (let i = 0; i < SL; i++) { tel[`slot_${f}-${i}`] = false; tel[`bar_${f}-${i}`] = 0; }
  tel['slot_1-5'] = true; tel['bar_1-3'] = 1;
  mock.setTel(tel, Date.now());
  setInterval(() => { if (!global.__boardOff) mock.setTel({ hb: 1 }, Date.now()); }, 5000).unref();

  // บัญชีทดสอบทั้งหมดเป็นข้อมูลสมมติ (example.test) ไม่มีข้อมูลจริง
  const staff = await user('staff@example.test', 'เจ้าหน้าที่ทดสอบ'); mock.st.users.get(staff.uid).customerId = { id: STAFF };
  const master = await user('master@example.test', 'มาสเตอร์ทดสอบ'); mock.st.users.get(master.uid).authority = 'TENANT_ADMIN'; mock.st.users.get(master.uid).customerId = undefined;
  await user('member@example.test', 'สมาชิกทดสอบ');
  const c = await user('somsri@example.test', 'สมศรี ทดสอบ'); await call('PUT', '/api/me', { cars: [{ plate: 'งจ3333' }] }, c.token);
  const a = await user('somchai@example.test', 'สมชาย &amp; ทดสอบ'), b = await user('somying@example.test', 'สมหญิง ทดสอบ');
  await call('PUT', '/api/me', { cars: [{ plate: 'กข1111' }] }, a.token); await call('PUT', '/api/me', { cars: [{ plate: 'ขค2222' }] }, b.token);
  const bk = async (u, plate, f, i) => { const r = await call('POST', '/api/bookings', { f, i, car: plate, pm: 'pp', reqId: 'req-' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2) }, u.token); if (r.status !== 201) throw new Error('book ' + r.status + JSON.stringify(r.body)); return r.body.booking; };
  const b1 = await bk(a, 'กข1111', 1, 1), b2 = await bk(b, 'ขค2222', 2, 0), b3 = await bk(c, 'งจ3333', 1, SL - 2);
  const dl = await call('DELETE', '/api/bookings/' + b3.id, { reason: 'ซ่อมพื้น' }, staff.token);
  if (dl.status !== 200) throw new Error('cancel ' + dl.status);
  await call('PUT', '/api/admin/closed', { set: { ['2-' + (SL - 1)]: true } }, staff.token);

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
  const web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__ctl') {
      const op = u.searchParams.get('op'), k = u.searchParams.get('k'), v = u.searchParams.get('v');
      if (op === 'occ') mock.setTel({ ['slot_' + k]: v === 'null' ? undefined : v === '1' }, Date.now());
      else if (op === 'bar') mock.setTel({ ['bar_' + k]: v === '1' ? 1 : 0 }, Date.now());
      else if (op === 'board') { global.__boardOff = v === 'off'; mock.setTel({ hb: 1 }, v === 'off' ? Date.now() - 600000 : Date.now()); }
      else if (op === 'rpcfail') mock.st.rpcMode = v === '1' ? () => ({ status: 504 }) : undefined;
      else if (op === 'demote') mock.st.users.get(staff.uid).customerId = { id: MEMBERS };
      else if (op === 'pw') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ pw: PW })); }   // เฉพาะ 127.0.0.1 ของเครื่องทดสอบ
      else if (op === 'ids') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ b1: b1.id, b2: b2.id })); }
      res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}');
    }
    const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname.replace(/\.\./g, ''));
    if (!/^[\\/]?[\w.-]+\.(html|js|css)$/.test(path.relative(ROOT, f)) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', MIME[path.extname(f)] || 'text/plain'); res.setHeader('cache-control', 'no-store'); fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => web.listen(WEB, '127.0.0.1', r));
  console.log(`READY api=${base} web=http://127.0.0.1:${WEB} (บัญชี: staff@example.test, master@example.test, member@example.test รหัสผ่านสุ่ม ขอได้ที่ /__ctl?op=pw)`);
})().catch(e => { console.error(e); process.exit(1); });
