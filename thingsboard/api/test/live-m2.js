// ทดสอบ M2 กับ ThingsBoard จริงแบบ "อ่านอย่างเดียว" (ไม่ใช่ส่วนของ npm test) รัน: npm run test:live-m2  (จากโฟลเดอร์ thingsboard)
// อ่านค่าจาก process.env และ thingsboard/.env เท่านั้น; ค่าลับ/JWT/ID ถูก mask; ไม่สมัครผู้ใช้ ไม่เขียน attribute/telemetry ไม่ส่ง RPC
// ใช้เฉพาะ GET ไปยัง device/asset + login บัญชี staff ที่มีอยู่แล้ว (STAFF_TEST_EMAIL/PASSWORD) เพื่อได้ JWT เรียก /api/lot
const { loadConfig, loadDotEnv, ENV_FILE } = require('../config');
const { createTb } = require('../tb');
const { createRoutes } = require('../routes');
const { createServer } = require('../server');
const { createLot } = require('../lot');

loadDotEnv(ENV_FILE, true);
const cfg = loadConfig();
const secrets = new Set([cfg.tbApiKey, process.env.STAFF_TEST_PASSWORD, ...cfg.devices.map(d => d.id), cfg.assetId, cfg.customerMembersId, cfg.customerStaffId].filter(Boolean));
const mask = s => { let t = String(s); for (const x of secrets) t = t.split(x).join('***'); return t.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, 'JWT***').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>'); };
const log = (...a) => console.log(mask(a.join(' ')));
const results = [];
const step = (n, ok, note) => { results.push(ok); log(`[${ok ? 'ผ่าน' : 'ไม่ผ่าน'}] ${n}${note ? ' -- ' + note : ''}`); };
const ago = ts => ts ? Math.round((Date.now() - ts) / 1000) + ' วินาทีที่แล้ว' : '(ไม่เคย)';

(async () => {
  log('ตั้งค่าแล้ว (ชื่อเท่านั้น):', ['TB_API_KEY', 'TB_HOST', 'TB_ASSET_ID', 'TB_SENSOR_DEVICE_ID', 'TB_SIM_DEVICE_ID', 'TB_SENSOR_DEVICE_IDS', 'TB_CUSTOMER_MEMBERS_ID', 'TB_CUSTOMER_STAFF_ID', 'STAFF_TEST_EMAIL', 'STAFF_TEST_PASSWORD'].filter(k => process.env[k]).join(', '));
  log('host =', cfg.tbHost, ' อุปกรณ์ที่ตั้งไว้:', cfg.devices.map(d => d.name).join(',') || '(ไม่มี)');
  if (!cfg.tbApiKey || !cfg.devices.length || !cfg.assetId) { console.error('ขาด TB_API_KEY / TB_SENSOR_DEVICE_ID / TB_ASSET_ID'); process.exit(1); }

  // ห่อ fetch: บล็อกทุกอย่างที่ไม่ใช่ GET (ยกเว้น login/auth/user ของบัญชี staff เดิม) และนับคำขอ
  const calls = [];
  const tf = async (url, opts = {}) => {
    const u = new URL(url), m = opts.method || 'GET', p = u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}');
    if (!(m === 'GET' || p === '/api/auth/login')) throw new Error('บล็อก: ไม่ใช่คำขออ่านอย่างเดียว ' + m + ' ' + p);
    const t0 = Date.now(), r = await fetch(url, opts);
    calls.push(`${m} ${p} -> ${r.status} (${Date.now() - t0} ms)`);
    return r;
  };
  const tb = createTb(cfg, tf);

  // ---- A. รูปร่างข้อมูลดิบจริง (เทียบกับที่ mock สมมติ) ----
  const t = await tb.admin(`/api/plugins/telemetry/DEVICE/${cfg.devices[0].id}/values/timeseries`);   // อุปกรณ์แรก (lot)
  step('A1 อ่าน latest telemetry ของ ParkHere-Lot', t.ok && t.data && typeof t.data === 'object', 'HTTP ' + t.status);
  const keys = t.ok ? Object.keys(t.data) : [];
  log('    จำนวนคีย์ telemetry =', keys.length, keys.length ? ' ชื่อ: ' + keys.slice(0, 12).join(',') : '(ว่าง: บอร์ดยังไม่ส่งข้อมูลมาที่อุปกรณ์นี้)');
  for (const k of keys.slice(0, 3)) { const x = t.data[k][0]; log(`    ตัวอย่าง ${k}: ts=${ago(x.ts)} ชนิดค่า=${typeof x.value} ค่า=${String(x.value).slice(0, 20)}`); }
  const a = await tb.admin(`/api/plugins/telemetry/ASSET/${cfg.assetId}/values/attributes/SERVER_SCOPE`);
  step('A2 อ่าน SERVER_SCOPE attributes ของ ParkHere-Data', a.ok && Array.isArray(a.data), 'HTTP ' + a.status);
  if (a.ok) for (const x of a.data) log(`    attribute ${x.key}: ชนิดค่า=${typeof x.value}${x.value && typeof x.value === 'object' ? ' คีย์=' + Object.keys(x.value).join(',') : ''} ค่า=${JSON.stringify(x.value).slice(0, 120)}`);

  // ---- B. โมดูล lot ตรง ๆ กับของจริง ----
  const lot = createLot(cfg, tb);
  const s = await lot.get(), v = lot.view(s, 'nobody');
  step('B1 lot.get() สำเร็จกับ TB จริง', !!v && v.slots.length === v.config.floors * v.config.slots, `ช่อง=${v.slots.length}`);
  log('    boards =', JSON.stringify(v.boards.map(b => ({ ...b, lastSeen: ago(b.lastSeen) }))));
  log('    config =', JSON.stringify(v.config), 'แหล่ง=' + v.configSource, 'ใช้ค่า default ของคีย์:', v.defaulted.join(',') || '(ไม่มี)');
  log('    closed =', JSON.stringify(v.closed));
  const cnt = { true: 0, false: 0, null: 0 }; for (const x of v.slots) cnt[String(x.occ)]++;
  log(`    ช่อง: มีรถ=${cnt.true} ว่าง=${cnt.false} ไม่ทราบ(null)=${cnt.null}  ไม้กั้น: ` + ['down', 'up', 'null'].map(b => b + '=' + v.slots.filter(x => String(x.barrier) === b).length).join(' '));
  log('    การจองทั้งหมดในลาน =', v.slots.reduce((n, x) => n + x.bookings.length, 0));
  lot.stop();

  // ---- C. ผ่าน HTTP จริง (บัญชี staff ที่มีอยู่แล้ว) ----
  const routes = createRoutes(cfg, tb);
  const server = createServer(cfg, routes);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    let r = await fetch(base + '/healthz'); const hj = await r.json();
    step('C1 GET /healthz', r.status === 200 && hj.ok === true && Object.keys(hj).length === 2, JSON.stringify(hj));
    r = await fetch(base + '/api/lot'); step('C2 GET /api/lot ไม่มี JWT = 401', r.status === 401);
    r = await fetch(base + '/api/live'); step('C3 GET /api/live ไม่มี JWT = 401', r.status === 401);
    r = await fetch(base + '/api/lot', { headers: { Authorization: 'Bearer aaa.bbb.ccc' } }); step('C4 JWT ปลอม = 401', r.status === 401);
    const em = process.env.STAFF_TEST_EMAIL, pw = process.env.STAFF_TEST_PASSWORD;
    if (!em || !pw) step('C5 login staff', false, 'ไม่มี STAFF_TEST_EMAIL/PASSWORD');
    else {
      r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.9' }, body: JSON.stringify({ email: em, password: pw }) });
      const lj = await r.json(); step('C5 login staff (บัญชีเดิม)', r.status === 200 && !!lj.token, 'role=' + (lj.user && lj.user.role));
      if (lj.token) {
        const t0 = Date.now(); r = await fetch(base + '/api/lot', { headers: { Authorization: 'Bearer ' + lj.token } }); const j = await r.json();
        step('C6 GET /api/lot พร้อม JWT', r.status === 200 && j.slots.length === v.slots.length, `HTTP ${r.status} ${Date.now() - t0} ms ช่อง=${j.slots && j.slots.length} board=${j.board && j.board.status}`);
        const ac = new AbortController(), evs = [];
        const sr = await fetch(base + '/api/live', { headers: { Authorization: 'Bearer ' + lj.token }, signal: ac.signal });
        step('C7 GET /api/live เปิดได้ content-type event-stream', sr.status === 200 && /text\/event-stream/.test(sr.headers.get('content-type') || ''), 'HTTP ' + sr.status);
        const rd = (async () => { const dec = new TextDecoder(); let buf = ''; try { for await (const ch of sr.body) { buf += dec.decode(ch, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const e = /^event: (.+)$/m.exec(b); if (e) evs.push(e[1]); } } } catch { /* abort */ } })();
        const c0 = calls.length; await new Promise(r => setTimeout(r, 4000)); ac.abort(); await rd;
        const poll = calls.slice(c0).filter(x => /timeseries/.test(x)).length;
        step('C8 SSE 4 วินาที: ได้ snapshot ก่อน', evs[0] === 'snapshot', `events=[${evs.join(',')}] poll telemetry ${poll} ครั้งใน 4 วินาที`);
        await new Promise(r => setTimeout(r, 300));
        step('C9 ตัด SSE แล้ว poller หยุด', routes.lot.listenerCount() === 0 && routes.hub.count() === 0);
      }
    }
  } finally { routes.close(); server.closeAllConnections(); server.close(); }
  const nonGet = calls.filter(x => !/^GET /.test(x) && !/auth\/login/.test(x));
  step('D ไม่มีคำขอเขียนไป ThingsBoard', nonGet.length === 0, `คำขอทั้งหมด ${calls.length} ครั้ง`);
  log('\nสรุป:', results.filter(Boolean).length + '/' + results.length, 'ผ่าน');
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('ผิดพลาด:', mask(e && e.message)); process.exit(1); });
