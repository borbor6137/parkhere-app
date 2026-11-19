// probe-m3.js : ตรวจสิทธิ์สมาชิก/staff บน ThingsBoard จริงแบบ "อ่านอย่างเดียว" (ระดับ A ของ docs/migration/M3-data.md หัวข้อ 7: P7, P9, P10a-c)
// เจ้าของรันเอง ทีมไม่ได้รันกับของจริง (ทดสอบด้วย mock ใน api/test/probe-m3.test.js เท่านั้น)
//
// ข้อจำกัดที่บังคับในโค้ด (ฟังก์ชัน send ด้านล่าง ปฏิเสธทุกอย่างนอกจากนี้ และมีเทสต์ตรวจ):
//   - ส่งได้เฉพาะ GET
//   - ข้อยกเว้นเดียว: POST /api/auth/login (แลก อีเมล+รหัสผ่าน เป็น JWT ของบัญชีที่มีอยู่แล้ว ไม่เขียนข้อมูล ไม่สร้างผู้ใช้)
//   - ไม่มี PUT / DELETE / PATCH ไม่มีการเขียน attribute, ไม่สร้าง/ลบผู้ใช้, asset, device
// ค่าเริ่มต้น = dry-run (พิมพ์แผน ไม่ยิงอะไร) ใส่ --run ถึงจะยิงจริง
//
// env (อ่านจาก thingsboard/.env ได้ ยกเว้นรหัสผ่านที่ไม่ควรลงไฟล์):
//   TB_API_KEY, TB_ASSET_ID, TB_SENSOR_DEVICE_ID (ParkHere-Lot), TB_HOST  ใช้ตามเดิม
//   PROBE_MEMBER_EMAIL, PROBE_STAFF_EMAIL            ไม่ตั้ง = ถามตอนรัน
//   PROBE_MEMBER_PASSWORD, PROBE_STAFF_PASSWORD      ไม่ตั้ง = ถามตอนรันแบบไม่แสดงบนจอ (ต้องรันในเทอร์มินัล) ห้ามเขียนลงไฟล์
// ตัวเลือก: --run, --no-staff (ตรวจเฉพาะสมาชิก ข้ามการเทียบข้ามผู้ใช้)
//   --only-p10e  รันเฉพาะ P10e (สมาชิกอ่านสมาชิกคนอื่นใน customer เดียวกันตรงได้หรือไม่) ข้าม P9/P7/P10a-c และไม่ล็อกอิน staff
//
// P10e (docs/migration/M3-p10-assessment.md หัวข้อ 2, ขั้นตอน docs/migration/M3-p10e-steps.md): GET ล้วนด้วย JWT สมาชิก ภายใต้ assertAllowed เดิม ไม่เพิ่ม method
//   PROBE_TARGET_USER_ID = User ID ของเป้าสำหรับ P10e-1/2 เป็น "ผู้ใช้อื่นที่มีอยู่แล้ว" ได้ 2 แบบ (ไม่ใช่ตัวที่ล็อกอิน ไม่ใช่ Tenant admin):
//       - สมาชิกคนอื่นใน customer ParkHere Members (customer เดียวกัน) หรือ
//       - บัญชี staff ใน customer ParkHere Staff (คนละ customer ต้องตั้ง TB_CUSTOMER_STAFF_ID) <- แผน 2026-11-18: มีสมาชิกคนเดียวจึงใช้ staff เป็นเป้า
//   ใส่เป็น env ในหน้าต่างเทอร์มินัลนั้นเท่านั้น ห้ามลง .env/ไฟล์/แชต (ถ้าใช้ --only-p10e จะถามตอนรัน กด Enter เปล่า = ข้าม P10e-1/2 รันแค่ P10e-3)
//   P10e-1 GET USER/<เป้า> attributes · P10e-2 GET /api/user/<เป้า> · P10e-3 GET /api/customer/<TB_CUSTOMER_MEMBERS_ID>/users (ไม่ต้องใช้เป้า)
//   --tight เพิ่ม P10e-0: สมาชิกอ่าน attribute ของ "ตัวเอง" ตรง ต้องได้ 401/403/404 (ใช้หลังปรับ role ตาม M3-role-tighten-steps.md
//       เป็นหลักฐานเดียวที่ทดสอบสิทธิ์ Read Attributes ของ USER ใน customer เดียวกันได้โดยตรง เมื่อมีสมาชิกคนเดียว)
//   ต้องได้ 401/403/404 ถ้าได้ 200 ข้อใด = exit 2 + พิมพ์ทางแก้ 2 ทาง
//   ตัวควบคุม (แยกกัน เป้าอยู่คนละ customer ไม่ทำให้ P10e-3 ล้ม): P10e-1/2 = API key อ่านเป้าได้ 200 เป็น CUSTOMER_USER และอยู่ customer Members หรือ Staff
//       P10e-3 / P10e-0 = API key ลิสต์ผู้ใช้ของ Members / อ่านของสมาชิกที่ล็อกอินได้ 200 และสมาชิกที่ล็อกอินอยู่ customer Members
//   ไม่ผ่านตัวควบคุม = รายงาน "ไม่แน่ใจ" (ไม่ใช่ผ่าน) พิมพ์แค่รหัส HTTP และจำนวน ไม่พิมพ์เนื้อหา/ID/อีเมล
//
// ผลลัพธ์พิมพ์สั้นๆ ต่อข้อ: ผ่าน/ไม่ผ่าน/ข้อมูล/ไม่แน่ใจ + HTTP status ไม่พิมพ์ token, รหัสผ่าน, อีเมล, ID, หรือเนื้อข้อมูล
// ถ้า P10b ได้ 200 พิมพ์แค่จำนวนรายการ และ exit code = 2  >>> ต้องหยุด M3 แจ้ง parkhere-security ทันที <<<
const { loadConfig, loadDotEnv, ENV_FILE } = require('../api/config');

const BLOCKED = new Set([401, 403, 404]);   // ผลที่ถือว่า "ถูกปิดกั้น" (หลังยืนยันแล้วว่า token ใช้ได้และ API key อ่านได้ปกติ)

// ทางออกเดียวของคำขอทั้งหมด ถ้าจะเพิ่ม method ต้องแก้ตรงนี้ (และเทสต์จะล้ม)
function assertAllowed(method, path) {
  if (method === 'GET') return;
  if (method === 'POST' && path === '/api/auth/login') return;
  throw new Error('probe-m3 ไม่อนุญาตคำขอ ' + method + ' (อ่านอย่างเดียว ยกเว้นล็อกอิน)');
}

function makeSender(host, fetchImpl, timeoutMs) {
  return async function send(method, path, { auth, body } = {}) {
    assertAllowed(method, path);
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) headers['X-Authorization'] = auth;
    try {
      const r = await fetchImpl(host + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* ไม่ใช่ JSON */ }
      return { status: r.status, data, bytes: Buffer.byteLength(text), date: r.headers.get('date') };
    } catch (e) { return { status: 0, data: null, bytes: 0, date: null }; }
  };
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('ไม่มีเทอร์มินัลให้พิมพ์รหัสผ่าน ตั้ง ' + prompt + ' เป็น env ในหน้าต่างนี้ (ห้ามลงไฟล์)'));
    process.stderr.write(prompt + ' (พิมพ์แล้วไม่แสดงบนจอ): ');
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    let s = '';
    const onData = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stderr.write('\n'); return resolve(s); }
        if (c === '\u0003') { process.stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    process.stdin.on('data', onData);
  });
}
function readLine(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('ไม่มีเทอร์มินัลให้พิมพ์ ตั้ง ' + prompt + ' เป็น env'));
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt + ': ', a => { rl.close(); resolve(a.trim()); });
  });
}

const count = d => Array.isArray(d) ? d.length : d && typeof d === 'object' ? Object.keys(d).length : null;

// main แยกออกมาให้เทสต์เรียกได้ (ส่ง env, argv, fetchImpl, ตัวถามรหัสผ่าน, ตัวพิมพ์)
async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, ask = { line: readLine, hidden: readHidden }, out = console.log } = {}) {
  const only = argv.includes('--only-p10e'), tight = argv.includes('--tight');
  const run = argv.includes('--run'), noStaff = argv.includes('--no-staff') || only;
  const cfg = loadConfig(env);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let target = String(env.PROBE_TARGET_USER_ID || '').trim();
  const lot = (cfg.devices || []).find(d => d.name === 'lot');
  const secrets = [];                                  // ค่าที่ห้ามหลุดลงผลลัพธ์
  const mask = s => { let t = String(s); for (const x of secrets) if (x && String(x).length >= 4) t =t.split(x).join('***'); return t; };
  const log = (...a) => out(mask(a.join(' ')));
  const tally = { pass: 0, fail: 0, inc: 0, info: 0, skip: 0 };
  const row = (kind, label, status, extra) => {
    tally[kind]++;
    const tag = { pass: 'ผ่าน', fail: 'ไม่ผ่าน', inc: 'ไม่แน่ใจ', info: 'ข้อมูล', skip: 'ข้าม' }[kind];
    log(`[${tag}] ${label}${status === undefined ? '' : '  HTTP ' + status}${extra ? '  ' + extra : ''}`);
  };
  secrets.push(cfg.tbApiKey, cfg.assetId, lot && lot.id, cfg.customerMembersId, cfg.customerStaffId, target);

  const roles = [{ key: 'member', label: 'สมาชิก', P: 'P10', emailEnv: 'PROBE_MEMBER_EMAIL', pwEnv: 'PROBE_MEMBER_PASSWORD' }];
  if (!noStaff) roles.push({ key: 'staff', label: 'staff', P: 'P10c', emailEnv: 'PROBE_STAFF_EMAIL', pwEnv: 'PROBE_STAFF_PASSWORD' });

  // ---------- แผน (dry-run และก่อนรันจริง) ----------
  log(only ? 'probe-m3 --only-p10e: ตรวจเฉพาะสมาชิกอ่านสมาชิกคนอื่นข้ามผู้ใช้ (อ่านอย่างเดียว)' : 'probe-m3: ตรวจสิทธิ์แบบอ่านอย่างเดียว (ระดับ A: P7, P9, P10a-c, P10e ถ้าตั้งเป้า)');
  log('คำขอที่จะส่ง (ทุกอัน GET ยกเว้นล็อกอิน 1 ครั้งต่อบัญชี):');
  if (!only) {
    log('  P9   GET asset ParkHere-Data attributes (API key) ทั้งก้อน / ?keys= คีย์ที่ไม่มี / ?keys= 36 คีย์ · GET ParkHere-Lot telemetry (API key, ตัวควบคุม)');
    log('  P7   เทียบหัว Date ของคำตอบ P9 กับนาฬิกาเครื่อง');
    for (const r of roles) {
      log(`  ${r.P}  [${r.label}] POST /api/auth/login (บัญชีที่มีอยู่) · GET /api/auth/user`);
      log(`        P10a GET USER/<ตัวเอง> attributes · P10b GET asset ParkHere-Data · GET USER/<${r.key === 'member' ? 'staff' : 'สมาชิก'}> attributes · GET ParkHere-Lot telemetry (ด้วย JWT ของบัญชีนั้น)`);
    }
  } else log('  ล็อกอินสมาชิก 1 ครั้ง (บัญชีที่มีอยู่) · GET /api/auth/user');
  if (only || target || tight) {
    log('  P10e ตัวควบคุมเป้า (API key): GET /api/user/<เป้า> ต้อง 200 เป็น CUSTOMER_USER ใน customer Members (สมาชิกอื่น) หรือ Staff (คนละ customer)');
    log('  P10e ตัวควบคุมลิสต์ (API key): GET /api/customer/<Members>/users ต้อง 200 และสมาชิกที่ล็อกอินอยู่ใน customer Members (แยกจากเป้า)');
    log('  P10e-1 (JWT สมาชิก) GET USER/<เป้า> attributes SERVER_SCOPE · P10e-2 GET /api/user/<เป้า> · P10e-3 GET /api/customer/<Members>/users?pageSize=5&page=0');
    if (tight) log('  P10e-0 (--tight) GET USER/<ตัวเอง> attributes ด้วย JWT สมาชิก ต้องไม่ได้ (หลังปรับ role) · ตัวควบคุม: API key อ่านของตัวเองได้');
    log('        ต้องได้ 401/403/404 ถ้าได้ 200 ข้อใด = exit 2 (พิมพ์แค่รหัส HTTP และจำนวน)');
  }
  if (!only) log('  P0   ทำเองในหน้าเว็บ: Plan and billing > Subscription > API calls > See details (สคริปต์ไม่แตะ)');
  const have = {
    'TB_API_KEY': !!cfg.tbApiKey, 'TB_ASSET_ID': !!cfg.assetId, 'TB_SENSOR_DEVICE_ID': !!lot, 'TB_HOST': cfg.tbHost.replace(/^(https?:\/\/[^/]+).*/, '$1'),
    'TB_CUSTOMER_MEMBERS_ID': !!cfg.customerMembersId, 'TB_CUSTOMER_STAFF_ID': !!cfg.customerStaffId, 'PROBE_TARGET_USER_ID': target ? 'ตั้งแล้ว' : only ? 'จะถาม' : 'ไม่ตั้ง (ข้าม P10e)',
  };
  for (const r of roles) { have[r.emailEnv] = env[r.emailEnv] ? 'ตั้งแล้ว' : 'จะถาม'; have[r.pwEnv] = env[r.pwEnv] ? 'ตั้งแล้ว' : 'จะถามแบบไม่แสดง'; }
  log('การตั้งค่า: ' + Object.entries(have).map(([k, v]) => `${k}=${v === true ? 'มี' : v === false ? 'ไม่มี' : v}`).join(' · '));
  if (!run) { log('dry-run: ยังไม่ยิงอะไร ใส่ --run เพื่อยิงจริง (เจ้าของรันเอง)'); return 0; }
  if (!cfg.tbApiKey || (!only && !cfg.assetId)) { log('หยุด: ต้องมี TB_API_KEY' + (only ? '' : ' และ TB_ASSET_ID')); return 1; }
  if (only && !cfg.customerMembersId) { log('หยุด: --only-p10e ต้องมี TB_CUSTOMER_MEMBERS_ID'); return 1; }
  if (only && !target) {
    log('(กด Enter เปล่าที่ช่อง PROBE_TARGET_USER_ID = ข้าม P10e-1/2 รันแค่ P10e-3)');
    try { target = (await ask.line('PROBE_TARGET_USER_ID')).trim(); } catch (e) { log('หยุด: ' + e.message); return 1; }
    secrets.push(target);
  }

  const send = makeSender(cfg.tbHost, fetchImpl, cfg.tbTimeoutMs);
  const apiKey = 'ApiKey ' + cfg.tbApiKey.replace(/^ApiKey /, '');
  const A = '/api/plugins/telemetry/ASSET/' + encodeURIComponent(cfg.assetId) + '/values/attributes/SERVER_SCOPE';
  const D = lot ? '/api/plugins/telemetry/DEVICE/' + encodeURIComponent(lot.id) + '/values/timeseries' : '';
  const U = uid => '/api/plugins/telemetry/USER/' + encodeURIComponent(uid) + '/values/attributes/SERVER_SCOPE';

  // ---------- P9 / P7 (API key) และตัวควบคุม ----------
  let assetOk = false, devOk = false;
  if (!only) {
  log('--- P9: อ่าน asset ParkHere-Data ด้วย API key (ตัวควบคุม) ---');
  const all = await send('GET', A, { auth: apiKey });
  assetOk = all.status === 200 && Array.isArray(all.data);
  if (!assetOk) row('inc', 'P9 อ่านทั้งก้อน', all.status, 'อ่านไม่ได้ ผล P10b ของ asset จึงสรุปไม่ได้');
  else {
    const items = all.data, keys = items.map(x => x && x.key);
    const nBk = keys.filter(k => /^bk_/.test(k)).length;
    const cfgItem = items.find(x => x && x.key === 'config');
    const cfgType = !cfgItem ? 'ไม่มีคีย์ config' : typeof cfgItem.value === 'string' ? 'สตริง' : cfgItem.value && typeof cfgItem.value === 'object' ? 'อ็อบเจกต์/อาร์เรย์ (parse แล้ว)' : typeof cfgItem.value;
    row('info', 'P9 อ่านทั้งก้อน', all.status, `คีย์ ${items.length} (bk_ ${nBk}, config ${keys.includes('config') ? 'มี' : 'ไม่มี'}, closed ${keys.includes('closed') ? 'มี' : 'ไม่มี'}), ขนาดคำตอบ ${all.bytes} ไบต์, ชนิดของ config = ${cfgType}, มี lastUpdateTs ครบ = ${items.every(x => x && Number.isFinite(+x.lastUpdateTs)) ? 'ใช่' : 'ไม่'}`);
  }
  const miss = await send('GET', A + '?keys=config,closed,bk_9-9,bk_99-999', { auth: apiKey });
  if (miss.status === 200 && Array.isArray(miss.data)) {
    const got = miss.data.map(x => x && x.key);
    const ok = !got.includes('bk_9-9') && !got.includes('bk_99-999');
    row(ok ? 'pass' : 'fail', 'P9 ?keys= กับคีย์ที่ไม่มี ถูกข้าม (ไม่ error)', miss.status, `ได้ ${got.length} คีย์`);
  } else row('inc', 'P9 ?keys= กับคีย์ที่ไม่มี', miss.status, 'ต้องการ 200 แล้วข้ามคีย์ที่ไม่มี');
  const many = await send('GET', A + '?keys=' + Array.from({ length: 36 }, (_, i) => 'bk_1-' + i).join(','), { auth: apiKey });
  row(many.status === 200 ? 'pass' : 'inc', 'P9 ?keys= 36 คีย์ (ความยาว URL)', many.status);
  if (lot) {
    const d = await send('GET', D, { auth: apiKey });
    devOk = d.status === 200;
    row(devOk ? 'info' : 'inc', 'ตัวควบคุม: อ่าน ParkHere-Lot ด้วย API key', d.status, devOk ? '' : 'อ่านไม่ได้ ผล P10b ของ device จึงสรุปไม่ได้');
  } else row('skip', 'ตัวควบคุมและ P10b ของ device', undefined, 'ไม่มี TB_SENSOR_DEVICE_ID');
  log('--- P7: เวลา ThingsBoard เทียบเครื่องนี้ ---');
  if (all.date && Number.isFinite(Date.parse(all.date))) {
    const dt = Math.round((Date.parse(all.date) - Date.now()) / 1000);
    row(Math.abs(dt) <= 5 ? 'pass' : 'inc', 'P7 หัว Date ของ TB ต่างจากเครื่อง', undefined, `${dt} วินาที (ความละเอียดหัว Date = 1 วินาที)`);
  } else row('inc', 'P7 ไม่มีหัว Date ในคำตอบ');
  }

  // ---------- P10: ล็อกอินบัญชีที่มีอยู่ ----------
  const acc = {};
  for (const r of roles) {
    let email = env[r.emailEnv], pw = env[r.pwEnv];
    try {
      if (!email) email = await ask.line(r.emailEnv);
      if (!pw) pw = await ask.hidden(r.pwEnv);
    } catch (e) { log('หยุด: ' + e.message); return 1; }
    secrets.push(email, pw);
    const l = await send('POST', '/api/auth/login', { body: { username: email, password: pw } });
    if (l.status !== 200 || !l.data || !l.data.token) { row('inc', `${r.P} ล็อกอินบัญชี${r.label}`, l.status, 'ล็อกอินไม่สำเร็จ (ตรวจอีเมล/รหัสผ่าน อย่าลองซ้ำหลายครั้ง บัญชีอาจถูกล็อก)'); continue; }
    secrets.push(l.data.token, l.data.refreshToken);
    const bearer = 'Bearer ' + l.data.token;
    const me = await send('GET', '/api/auth/user', { auth: bearer });
    if (me.status !== 200 || !me.data || !me.data.id) { row('inc', `${r.P} อ่านข้อมูลบัญชี${r.label}`, me.status); continue; }
    secrets.push(me.data.id.id, me.data.customerId && me.data.customerId.id);
    if (me.data.authority !== 'CUSTOMER_USER') { row('fail', `${r.P} บัญชี${r.label}ไม่ใช่ CUSTOMER_USER (${me.data.authority})`, undefined, 'ห้ามใช้บัญชี Tenant admin ในการตรวจนี้ ผลจะหลอก ข้ามบัญชีนี้'); continue; }
    const expect = r.key === 'member' ? cfg.customerMembersId : cfg.customerStaffId;
    const inCustomer = !expect ? 'ไม่ได้ตั้ง TB_CUSTOMER_*_ID จึงไม่เทียบ' : me.data.customerId && me.data.customerId.id === expect ? 'อยู่ใน customer ที่คาดไว้' : 'ไม่อยู่ใน customer ที่คาดไว้ (ตรวจว่าใช้บัญชีถูกคน)';
    row('info', `${r.P} ล็อกอินบัญชี${r.label} สำเร็จ`, undefined, 'CUSTOMER_USER, ' + inCustomer);
    acc[r.key] = { r, bearer, uid: me.data.id.id, cid: me.data.customerId && me.data.customerId.id };
  }

  let stop = false, stopE = false;
  // ตัดสินผลของคำขอที่ "ต้องถูกปิดกั้น": 200 = ไม่ผ่าน (flag ตั้งสถานะหยุด), 401/403/404 ผ่านเมื่อตัวควบคุมผ่านเท่านั้น
  const verdict = (label, resp, control, flag, n) => {
    if (resp.status === 200) {
      if (flag === 'E') stopE = true; else stop = true;
      return row('fail', label, resp.status, `ได้ข้อมูลกลับมา จำนวนรายการ/คีย์ = ${n === undefined ? count(resp.data) : n} (ไม่แสดงเนื้อหา) ช่องโหว่: หยุด M3 แจ้ง parkhere-security`);
    }
    if (!control) return row('inc', label, resp.status, 'สรุปไม่ได้เพราะตัวควบคุมไม่ผ่าน');
    if (BLOCKED.has(resp.status)) return row('pass', label, resp.status, 'ถูกปิดกั้น');
    return row('inc', label, resp.status, 'ไม่ใช่ 200 แต่ก็ไม่ใช่ 401/403/404 ตรวจซ้ำ');
  };
  for (const r of roles) {
    const a = acc[r.key]; if (!a || only) continue;
    log(`--- ${r.P}: บัญชี${r.label} ใช้ JWT ของตัวเองเรียก ThingsBoard ตรง ---`);
    // P10a: อ่านของตัวเอง (ข้อมูลประกอบ ไม่ตัดสินผ่าน/ไม่ผ่าน)
    const own = await send('GET', U(a.uid), { auth: a.bearer });
    if (own.status === 200 && Array.isArray(own.data)) {
      const names = own.data.map(x => x && x.key).filter(k => typeof k === 'string' && /^[\w-]{1,30}$/.test(k));
      row('info', `${r.P}a อ่าน attribute ของตัวเองตรง`, own.status, `อ่านได้ ${own.data.length} คีย์ (${names.join(',')}) ถ้า 200 ผู้ใช้เห็น books/rcp/pays ของตัวเองตรงได้`);
    } else row('info', `${r.P}a อ่าน attribute ของตัวเองตรง`, own.status, BLOCKED.has(own.status) ? 'อ่านไม่ได้' : '');
    // P10b: ต้องถูกปิดกั้น
    verdict(`${r.P === 'P10' ? 'P10b' : 'P10c'} ${r.label}อ่าน asset ParkHere-Data ตรง (ต้องไม่ได้)`, await send('GET', A, { auth: a.bearer }), assetOk);
    const other = r.key === 'member' ? acc.staff : acc.member;
    if (other) verdict(`${r.P === 'P10' ? 'P10b' : 'P10c'} ${r.label}อ่าน attribute ของบัญชี${other.r.label}ตรง (ต้องไม่ได้)`, await send('GET', U(other.uid), { auth: a.bearer }), true);
    else row('skip', `${r.P === 'P10' ? 'P10b' : 'P10c'} อ่าน attribute ของผู้ใช้อื่น`, undefined, 'ต้องมีบัญชีทั้งสมาชิกและ staff (ไม่ใช้ --no-staff)');
    if (lot) verdict(`${r.P === 'P10' ? 'P10b' : 'P10c'} ${r.label}อ่าน telemetry ของ ParkHere-Lot ตรง (ต้องไม่ได้)`, await send('GET', D, { auth: a.bearer }), devOk);
  }

  // ---------- P10e: สมาชิกอ่านสมาชิกคนอื่น (customer เดียวกัน) ตรงได้หรือไม่ ----------
  let ownOpen = false;
  if (target || only || tight) {
    log('--- P10e: สมาชิกใช้ JWT ของตัวเองอ่านผู้ใช้อื่น/ลิสต์ผู้ใช้ผ่าน ThingsBoard ตรง (GET ล้วน) ---');
    const a = acc.member, enc = encodeURIComponent;
    if (!a) row('inc', 'P10e', undefined, 'ล็อกอินสมาชิกไม่สำเร็จ จึงทดสอบไม่ได้');
    else if (!cfg.customerMembersId) row('inc', 'P10e', undefined, 'ไม่ได้ตั้ง TB_CUSTOMER_MEMBERS_ID จึงตรวจตัวควบคุมไม่ได้');
    else {
      // P10e-0 (--tight): อ่าน attribute ของตัวเองตรง ต้องไม่ได้หลังปรับ role (ตัวควบคุม: API key อ่านของตัวเองได้)
      if (tight) {
        const ownCtl = await send('GET', U(a.uid), { auth: apiKey });
        row(ownCtl.status === 200 ? 'info' : 'inc', 'P10e ตัวควบคุม (P10e-0): API key อ่าน attribute ของสมาชิกที่ล็อกอินได้', ownCtl.status, ownCtl.status === 200 ? 'ผ่าน' : 'อ่านไม่ได้ P10e-0 จึงสรุปไม่ได้');
        const own = await send('GET', U(a.uid), { auth: a.bearer });
        if (own.status === 200) ownOpen = true;
        verdict('P10e-0 สมาชิกอ่าน attribute ของตัวเองตรง (หลังปรับ role ต้องไม่ได้)', own, ownCtl.status === 200, 'E');
      }
      // P10e-1/2: เป้า = สมาชิกอื่น (customer เดียวกัน) หรือ staff (คนละ customer)
      if (!target) row('skip', 'P10e-1/2', undefined, 'ไม่ได้ให้ PROBE_TARGET_USER_ID (รันเฉพาะ P10e-3)');
      else if (!UUID.test(target)) row('inc', 'P10e', undefined, 'PROBE_TARGET_USER_ID ไม่ใช่ User ID (ต้องเป็นรหัสแบบ xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) ตรวจว่าคัดลอกถูกช่อง');
      else if (target.toLowerCase() === String(a.uid).toLowerCase()) row('inc', 'P10e', undefined, 'เป้าเป็นบัญชีเดียวกับสมาชิกที่ล็อกอิน (อ่านของตัวเองได้อยู่แล้ว ผลจะหลอก) ต้องใช้ผู้ใช้อื่น');
      else {
        const UD = '/api/user/' + enc(target);
        const ctl = await send('GET', UD, { auth: apiKey });
        const cid = ctl.data && ctl.data.customerId && ctl.data.customerId.id;
        let ctlOk = false, why, kind = '';
        if (ctl.status !== 200 || !ctl.data) why = 'API key อ่านเป้าไม่ได้ (ID ผิด หรือ key ไม่มีสิทธิ์) 404 จาก JWT สมาชิกจึงไม่มีความหมาย';
        else if (ctl.data.authority !== 'CUSTOMER_USER') why = 'เป้าไม่ใช่ CUSTOMER_USER (อย่าใช้บัญชี Tenant admin เป็นเป้า)';
        else if (cid === cfg.customerMembersId) { ctlOk = true; kind = 'เป้า = สมาชิกอื่น customer เดียวกัน'; }
        else if (cfg.customerStaffId && cid === cfg.customerStaffId) { ctlOk = true; kind = 'เป้า = staff คนละ customer'; }
        else why = 'เป้าไม่อยู่ใน customer ParkHere Members หรือ ParkHere Staff' + (cfg.customerStaffId ? '' : ' (ถ้าเป้าคือ staff ต้องตั้ง TB_CUSTOMER_STAFF_ID)') + ' ตรวจว่าคัดลอก User ID ถูกคน';
        row(ctlOk ? 'info' : 'inc', 'P10e ตัวควบคุมเป้า (P10e-1/2): API key อ่านเป้าได้ เป็น CUSTOMER_USER ใน Members/Staff', ctl.status, ctlOk ? 'ผ่าน (' + kind + ')' : why);
        verdict('P10e-1 สมาชิกอ่าน attribute ของผู้ใช้อื่นตรง (ต้องไม่ได้)', await send('GET', U(target), { auth: a.bearer }), ctlOk, 'E');
        verdict('P10e-2 สมาชิกอ่าน /api/user/<ผู้ใช้อื่น> (มีอีเมล) (ต้องไม่ได้)', await send('GET', UD, { auth: a.bearer }), ctlOk, 'E');
      }
      // P10e-3: ลิสต์ผู้ใช้ของ customer Members ไม่ใช้เป้า (ตัวควบคุมของตัวเอง ไม่ล้มเพราะเป้าอยู่คนละ customer)
      const lctl = await send('GET', '/api/customer/' + enc(cfg.customerMembersId) + '/users?pageSize=5&page=0', { auth: apiKey });
      const inMem = a.cid === cfg.customerMembersId;
      const lctlOk = lctl.status === 200 && !!lctl.data && Array.isArray(lctl.data.data) && inMem;
      row(lctlOk ? 'info' : 'inc', 'P10e ตัวควบคุมลิสต์ (P10e-3): API key ลิสต์ผู้ใช้ของ customer Members ได้ และสมาชิกที่ล็อกอินอยู่ใน customer นี้', lctl.status,
        lctlOk ? `ผ่าน (หน้านี้มี ${lctl.data.data.length} บัญชี)` : !inMem ? 'บัญชีที่ล็อกอินไม่อยู่ใน customer ParkHere Members (ตรวจว่าใช้บัญชีถูกคน)' : 'ลิสต์ด้วย API key ไม่ได้ (TB_CUSTOMER_MEMBERS_ID ผิด หรือ key ไม่มีสิทธิ์) 403/404 จาก JWT สมาชิกจึงไม่มีความหมาย');
      const lst = await send('GET', '/api/customer/' + enc(cfg.customerMembersId) + '/users?pageSize=5&page=0', { auth: a.bearer });
      verdict('P10e-3 สมาชิกลิสต์ผู้ใช้ของ customer Members (ต้องไม่ได้)', lst, lctlOk, 'E', lst.data && Array.isArray(lst.data.data) ? lst.data.data.length : undefined);
    }
  }

  log(`สรุป: ผ่าน ${tally.pass} · ไม่ผ่าน ${tally.fail} · ไม่แน่ใจ ${tally.inc} · ข้อมูล ${tally.info} · ข้าม ${tally.skip}  (P0 ทำเองในหน้าเว็บ; ไม่มีการเขียนข้อมูลใดๆ)`);
  if (stop) {
    log('');
    log('*** P10b/P10c ได้ HTTP 200: สมาชิก/staff อ่านข้อมูลที่ไม่ใช่ของตัวเองผ่าน ThingsBoard ตรงได้ ***');
    log('*** ต้องหยุด M3 ทันที (ห้ามเขียนโค้ดจอง/ห้ามเปิดเขียนจริง) และแจ้ง parkhere-security + ผู้จัดการ ***');
    return 2;
  }
  if (stopE) {
    log('');
    log('*** P10e ได้ HTTP 200: สมาชิกอ่านข้อมูลของผู้ใช้อื่น/ลิสต์ผู้ใช้ใน customer เดียวกันผ่าน ThingsBoard ตรงได้ (ทะเบียนรถ/บัตรจำลอง/ประวัติจอง/อีเมล) ***');
    if (ownOpen) log('*** P10e-0 ได้ 200: role ของกลุ่ม Customer Users ยังให้ Read Attributes อยู่ (ปรับ role ตาม docs/migration/M3-role-tighten-steps.md ยังไม่สำเร็จ หรือกลุ่ม/role ที่แก้ไม่ใช่ตัวที่สมาชิกใช้อยู่) ***');
    log('*** หยุด: ห้ามเปิด BOOKINGS_WRITE และห้ามเขียนข้อมูลสมาชิกลง USER attribute จนกว่าจะแก้ แล้วแจ้ง parkhere-security + ผู้จัดการ ***');
    log('ทางแก้ (เลือกอย่างใดอย่างหนึ่ง ตาม docs/migration/M3-p10-assessment.md หัวข้อ 2):');
    log('  1) ทางเร็ว (เจ้าของกดใน ThingsBoard): แก้กลุ่ม Customer Users ของ ParkHere Members ไม่ให้มี generic role "Read ทุก resource"');
    log('     เหลือเฉพาะ Profile (เว็บไม่ต้องให้ ThingsBoard อ่านอะไรให้สมาชิก parkhere-api ใช้ JWT แค่ /api/auth/user และอ่านทุกอย่างด้วย API key)');
    log('     แล้วรัน probe ซ้ำ: P10a ต้อง 403 และ P10e ทุกข้อ 403/404 และตรวจว่าล็อกอินยังใช้ได้');
    log('  2) ถ้าแก้ role ไม่ได้ในแผนฟรี (ทีมแก้โค้ด): ย้าย profile/cars/pays/books/rcp จาก USER attribute ไปเก็บบน asset ของ tenant (ParkHere-Members)');
    log('     ซึ่งสมาชิกอ่านตรงไม่ได้เหมือน ParkHere-Data ต้องแก้ api/tb.js + แผน M3-data + เทสต์ (ส่ง parkhere-backend / parkhere-lead)');
    return 2;
  }
  return tally.fail || tally.inc ? 1 : 0;
}

if (require.main === module) {
  loadDotEnv(ENV_FILE, false);
  main().then(code => process.exit(code), e => { console.error('ผิดพลาด:', e && e.message); process.exit(1); });
}
module.exports = { main, assertAllowed };
