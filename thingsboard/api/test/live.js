// ทดสอบ M1 กับ ThingsBoard จริง (ไม่ใช่ส่วนของ npm test) รัน: node api/test/live.js   (จากโฟลเดอร์ thingsboard)
// อ่านค่าจาก process.env และไฟล์ .env (ถูก .gitignore) เท่านั้น ห้ามพิมพ์ค่าลับ: token/รหัสผ่าน/คีย์ถูก mask ทุกครั้ง
// สมัครบัญชีทดสอบ 1 บัญชี (รหัสผ่านสุ่มในหน่วยความจำ ไม่เขียนลงไฟล์) และไม่ลบบัญชีนั้น (ต้องให้เจ้าของอนุญาตก่อน)
const crypto = require('crypto');
const { loadConfig, missing, loadDotEnv, ENV_FILE } = require('../config');
const { createTb } = require('../tb');
const { createRoutes } = require('../routes');
const { createServer } = require('../server');

// โหลด thingsboard/.env (ไม่พบไฟล์ = throw พร้อม path ไม่ข้ามเงียบ)
loadDotEnv(ENV_FILE, true);

// อีเมลทดสอบอ่านจาก PROBE_EMAIL (env/.env) ห้ามใส่อีเมลจริงในโค้ด ไม่ตั้ง = ไม่รัน (ก่อนยิงอะไรทั้งสิ้น)
const TEST_EMAIL = (process.env.PROBE_EMAIL || '').trim();
if (!TEST_EMAIL) { console.error('ไม่ได้ตั้ง PROBE_EMAIL (อีเมลสำหรับสมัคร/forgot ตอนทดสอบ) ใน env หรือ .env จึงไม่รันสคริปต์นี้'); process.exit(1); }

const secrets = new Set();
const mask = s => {
  let t = String(s);
  for (const x of secrets) if (x && t.includes(x)) t = t.split(x).join('***');
  return t.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, 'JWT***').replace(/(activateToken|resetToken)=[^&\s"]+/g, '$1=***');
};
const log = (...a) => console.log(mask(a.join(' ')));
const results = [];
const step = (n, name, ok, note) => { results.push({ n, name, ok }); log(`[${ok ? 'ผ่าน' : 'ไม่ผ่าน'}] ขั้น ${n}: ${name}${note ? ' -- ' + note : ''}`); return ok; };

// ห่อ fetch เพื่อดูว่าโค้ดคุยกับ ThingsBoard ยังไง (เฉพาะ method/path/status/เวลา และรูปร่างของคำตอบ ไม่พิมพ์ค่าลับ)
function tracingFetch() {
  const calls = [];
  const f = async (url, opts = {}) => {
    const t0 = Date.now();
    const r = await fetch(url, opts);
    const text = await r.clone().text();
    const u = new URL(url);
    const shape = /activationLink/.test(u.pathname) ? mask(text).slice(0, 140)
      : r.ok ? '' : mask(text).slice(0, 200);
    let keys = ''; try { const j = JSON.parse(text); if (j && typeof j === 'object' && !Array.isArray(j)) keys = Object.keys(j).join(','); } catch { /* ไม่ใช่ JSON */ }
    calls.push({ m: opts.method || 'GET', p: u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}'), s: r.status, ms: Date.now() - t0, keys, shape });
    return r;
  };
  f.calls = calls;
  return f;
}
const flush = tf => { for (const c of tf.calls.splice(0)) log(`    TB ${c.m} ${c.p} -> ${c.s} (${c.ms} ms)${c.keys ? ' keys=[' + c.keys + ']' : ''}${c.shape ? ' body=' + c.shape : ''}`); };

(async () => {
  const cfg = loadConfig(), miss = missing(cfg);
  const need = ['TB_ASSET_ID', 'TB_CUSTOMER_STAFF_ID', 'STAFF_TEST_EMAIL', 'STAFF_TEST_PASSWORD'].filter(k => !process.env[k]);
  const wanted = ['TB_API_KEY', 'TB_HOST', 'TB_ASSET_ID', 'TB_CUSTOMER_MEMBERS_ID', 'TB_CUSTOMER_STAFF_ID', 'STAFF_TEST_EMAIL', 'STAFF_TEST_PASSWORD'];
  log('คีย์ที่ตั้งค่าแล้ว (ชื่อเท่านั้น):', wanted.filter(k => process.env[k]).join(', ') || '(ไม่มี)');
  if (miss.length) { console.error('ขาดค่า env (ว่างหรือไม่มีใน .env):', miss.join(', ')); process.exit(1); }
  if (need.length) log('คำเตือน: ไม่มีค่า', need.join(', '), '(ขั้นที่ต้องใช้จะข้าม)');
  secrets.add(cfg.tbApiKey);
  const spw = process.env.STAFF_TEST_PASSWORD; if (spw) secrets.add(spw);

  const tf = tracingFetch();
  const routes = createRoutes(cfg, createTb(cfg, tf));
  const server = createServer(cfg, routes);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (method, p, body, token) => {
    const t0 = Date.now();
    const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return { s: r.status, j, ms: Date.now() - t0 };
  };
  const err = r => r.j && r.j.error ? `${r.j.error.code}: ${r.j.error.message}` : 'ไม่มี error body';

  const pw = 'Pk!' + crypto.randomBytes(12).toString('base64url') + '9a';
  secrets.add(pw);
  let tok, refresh, uid;

  try {
    // 1 สมัคร
    log('--- 1 signup');
    let r = await api('POST', '/api/signup', { email: TEST_EMAIL, password: pw, name: 'ทดสอบ M1', plate: 'กข1234' });
    flush(tf); log(`    API ${r.s} ใน ${r.ms} ms`);
    if (step(1, 'POST /api/signup', r.s === 201 && r.j && r.j.token, r.s === 201 ? `role=${r.j.user.role} id=${r.j.user.id} คืน token ทันที=${!!r.j.token} refreshToken=${!!r.j.refreshToken}` : err(r))) {
      uid = r.j.user.id; tok = r.j.token; refresh = r.j.refreshToken;
      // ตรวจฝั่ง ThingsBoard ว่าอยู่ customer ไหน (อ่านอย่างเดียว เฉพาะบัญชีทดสอบ)
      const tb = createTb(cfg, tf);
      const u = await tb.admin('/api/user/' + uid);
      log(`    user: authority=${u.data && u.data.authority} customerId=${u.data && u.data.customerId && u.data.customerId.id} (ตรงกับ Members=${u.data && u.data.customerId && u.data.customerId.id === cfg.customerMembersId})`);
      const g = await tb.admin(`/api/entityGroups/USER/${uid}`);
      log(`    entity groups: ${g.ok && Array.isArray(g.data) ? g.data.map(x => x.name + '(' + x.id.id + ')').join(', ') || '(ไม่มี)' : 'อ่านไม่ได้ status ' + g.status}`);
      flush(tf);
    }

    if (uid) {
      // 2 login
      log('--- 2 login');
      r = await api('POST', '/api/login', { email: TEST_EMAIL, password: pw });
      flush(tf); log(`    API ${r.s} ใน ${r.ms} ms`);
      if (step(2, 'POST /api/login', r.s === 200 && r.j.user.role === 'member' && r.j.user.id === uid, r.s === 200 ? `role=${r.j.user.role}` : err(r))) { tok = r.j.token; refresh = r.j.refreshToken; }

      // 3 me
      log('--- 3 GET /api/me');
      r = await api('GET', '/api/me', undefined, tok); flush(tf); log(`    API ${r.s} ใน ${r.ms} ms`);
      step(3, 'GET /api/me', r.s === 200 && r.j.id === uid && r.j.cars.length === 1, r.s === 200 ? `name=${r.j.name} cars=${JSON.stringify(r.j.cars)} pays=${r.j.pays.length}` : err(r));

      // 4 put me + get ซ้ำ
      log('--- 4 PUT /api/me');
      r = await api('PUT', '/api/me', { name: 'ทดสอบ M1 แก้ชื่อ', cars: [{ plate: 'กข1234' }, { plate: '9กค5678', label: 'รถสอง' }] }, tok);
      flush(tf); log(`    PUT ${r.s} ใน ${r.ms} ms`);
      const r2 = await api('GET', '/api/me', undefined, tok); flush(tf);
      step(4, 'PUT /api/me แล้ว GET ซ้ำ', r.s === 200 && r2.s === 200 && r2.j.name === 'ทดสอบ M1 แก้ชื่อ' && r2.j.cars.length === 2 && r2.j.cars[1].label === 'รถสอง',
        r2.s === 200 ? `name=${r2.j.name} cars=${r2.j.cars.length}` : err(r.s !== 200 ? r : r2));

      // 5 refresh
      log('--- 5 refresh');
      r = await api('POST', '/api/refresh', { refreshToken: refresh }); flush(tf); log(`    API ${r.s} ใน ${r.ms} ms`);
      let ok5 = r.s === 200 && !!r.j.token;
      if (ok5) { const m = await api('GET', '/api/me', undefined, r.j.token); flush(tf); ok5 = m.s === 200 && m.j.id === uid; }
      step(5, 'POST /api/refresh แล้วใช้ token ใหม่เรียก /api/me', ok5, r.s === 200 ? '' : err(r));

      // 6 forgot (ยิงจริง)
      log('--- 6 forgot (อีเมลจริง)');
      r = await api('POST', '/api/forgot', { email: TEST_EMAIL }); flush(tf); log(`    API ${r.s} ใน ${r.ms} ms`);
      step(6, 'POST /api/forgot ยิงแล้ว (เจ้าของต้องยืนยันว่าอีเมลถึง Gmail)', r.s === 200 && r.j.ok === true, r.s === 200 ? 'ดูสถานะ TB ด้านบน' : err(r));
    } else log('ข้ามขั้น 2-6: สมัครไม่สำเร็จ');

    // 7 staff
    log('--- 7 staff login');
    if (!process.env.STAFF_TEST_EMAIL || !spw) step(7, 'staff login', false, 'ไม่มี STAFF_TEST_EMAIL/PASSWORD ใน env');
    else {
      r = await api('POST', '/api/login', { email: process.env.STAFF_TEST_EMAIL, password: spw }); flush(tf); log(`    API ${r.s} ใน ${r.ms} ms`);
      let ok7 = r.s === 200 && r.j.user.role === 'staff';
      if (r.s === 200) { const m = await api('GET', '/api/me', undefined, r.j.token); flush(tf); ok7 = ok7 && m.s === 200 && m.j.role === 'staff'; }
      step(7, 'login staff ต้องได้ role "staff"', ok7, r.s === 200 ? `role=${r.j.user.role}` : err(r));
    }
  } catch (e) { log('ผิดพลาดนอกคาด:', e && e.message); }
  finally { server.close(); }

  log('\nสรุป:', results.map(x => `${x.n}=${x.ok ? 'ผ่าน' : 'ไม่ผ่าน'}`).join(' '));
  if (uid) log(`บัญชีทดสอบ (ยังไม่ลบ รอเจ้าของอนุญาต): email=${TEST_EMAIL} userId=${uid}`);
  process.exit(results.every(x => x.ok) ? 0 : 1);
})();
