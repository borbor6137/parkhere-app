// probe-m5.js : ตรวจข้อมูลสำหรับ M5 บน ThingsBoard จริงแบบ "อ่านอย่างเดียว" (Q0-Q6 ของ docs/migration/M5-data.md หัวข้อ 7)
// เจ้าของรันเอง (หรือสั่ง tbdata รันหลังอนุญาต) ทีม *ยังไม่เคยรัน* สคริปต์นี้ ไม่ว่ากับของจริงหรือ mock
//
// ข้อจำกัดที่บังคับในโค้ด (ฟังก์ชัน assertAllowed ปฏิเสธทุกอย่างนอกจากนี้):
//   - ส่งได้เฉพาะ GET
//   - ข้อยกเว้นเดียว: POST /api/entitiesQuery/find (คำสั่งค้นหาแบบ Entity Data Query ไม่เขียนข้อมูล)
//   - ไม่มี PUT / DELETE / PATCH ไม่เขียน attribute ไม่สร้าง/ลบ/แก้ผู้ใช้ asset device ไม่ล็อกอินบัญชีใคร (ใช้แค่ tenant API key)
// ค่าเริ่มต้น = dry-run (พิมพ์แผน ไม่ยิงอะไร) ใส่ --run ถึงจะยิงจริง
//
// env (อ่านจาก thingsboard/.env ได้): TB_API_KEY, TB_ASSET_ID, TB_CUSTOMER_MEMBERS_ID, TB_CUSTOMER_STAFF_ID (ไม่บังคับ), TB_HOST
//
// ผลลัพธ์พิมพ์สั้นๆ: ผ่าน/ไม่ผ่าน/ข้อมูล/ไม่แน่ใจ + HTTP status ไม่พิมพ์ API key, ID, อีเมล, ชื่อ, ทะเบียน, เนื้อ books
// (พิมพ์เฉพาะจำนวน ชนิดของค่า และชื่อฟิลด์) ข้อมูลส่วนบุคคลที่อ่านมาถูกใช้นับในหน่วยความจำเท่านั้น ไม่เขียนไฟล์
const { loadConfig, loadDotEnv, ENV_FILE } = require('../api/config');

const GRACE_MS = 120000;   // หน้าต่าง 120 วิของตัวซ่อม (M3-data.md 4.3): การจองที่อายุน้อยกว่านี้อาจกำลังเขียนอยู่ ไม่นับเป็นความขัดกัน

// ทางออกเดียวของคำขอทั้งหมด ถ้าจะเพิ่ม method หรือ path ต้องแก้ตรงนี้
function assertAllowed(method, path) {
  if (method === 'GET') return;
  if (method === 'POST' && path === '/api/entitiesQuery/find') return;
  throw new Error('probe-m5 ไม่อนุญาตคำขอ ' + method + ' (อ่านอย่างเดียว ยกเว้น entitiesQuery/find)');
}

function makeSender(host, fetchImpl, timeoutMs) {
  const stat = { n: 0 };
  async function send(method, path, { auth, body } = {}) {
    assertAllowed(method, path);
    stat.n++;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) headers['X-Authorization'] = auth;
    try {
      const r = await fetchImpl(host + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* ไม่ใช่ JSON */ }
      return { status: r.status, data, bytes: Buffer.byteLength(text) };
    } catch (e) { return { status: 0, data: null, bytes: 0 }; }
  }
  return { send, stat };
}

const parseVal = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return undefined; } };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeOf = v => v === undefined ? 'ไม่มี' : typeof v === 'string' ? 'สตริง' : Array.isArray(v) ? 'อาร์เรย์' : v === null ? 'null' : typeof v === 'object' ? 'อ็อบเจกต์' : typeof v;
const page = d => isObj(d) && Array.isArray(d.data) ? d : null;   // PageData ของ ThingsBoard
const uidOf = u => u && u.id && typeof u.id.id === 'string' ? u.id.id : null;

async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, out = console.log, now = () => Date.now() } = {}) {
  const run = argv.includes('--run');
  const cfg = loadConfig(env);
  const secrets = [cfg.tbApiKey, cfg.assetId, cfg.customerMembersId, cfg.customerStaffId];   // ค่าที่ห้ามหลุดลงผลลัพธ์ (เติมเพิ่มเมื่อพบ uid)
  const mask = s => { let t = String(s); for (const x of secrets) if (x && String(x).length >= 4) t = t.split(x).join('***'); return t; };
  const log = (...a) => out(mask(a.join(' ')));
  const tally = { pass: 0, fail: 0, inc: 0, info: 0, skip: 0 };
  const row = (kind, label, status, extra) => {
    tally[kind]++;
    const tag = { pass: 'ผ่าน', fail: 'ไม่ผ่าน', inc: 'ไม่แน่ใจ', info: 'ข้อมูล', skip: 'ข้าม' }[kind];
    log(`[${tag}] ${label}${status === undefined ? '' : '  HTTP ' + status}${extra ? '  ' + extra : ''}`);
  };

  // ---------- แผน (dry-run และก่อนรันจริง) ----------
  log('probe-m5: ตรวจข้อมูลสำหรับ M5 แบบอ่านอย่างเดียว (Q0-Q6) ใช้ tenant API key อย่างเดียว ไม่ล็อกอินบัญชีใคร');
  log('คำขอที่จะส่ง (GET ทั้งหมด ยกเว้น POST /api/entitiesQuery/find 1 ครั้ง ซึ่งเป็นคำสั่งค้นหา):');
  log('  Q0   GET asset ParkHere-Data attributes ทั้งก้อน 1 ครั้ง (config, closed, bk_*)');
  log('  Q1   GET /api/auth/user (ดูสิทธิ์ของ key) · GET /api/customer/{Members}/users · GET /api/customer/{Staff}/users');
  log('  Q2   GET /api/tenant/{tenantId}/users');
  log('  Q3   POST /api/entitiesQuery/find (entityType USER + latestValues SERVER_ATTRIBUTE books)');
  log('  Q4   GET USER/{uid}/values/attributes/SERVER_SCOPE?keys=books ต่อผู้ใช้ที่พบ (ไม่เกิน 5 คน)');
  log('  Q5   เทียบ bk_ กับ books ในหน่วยความจำ (ไม่มีคำขอเพิ่ม ไม่พิมพ์เนื้อหา)');
  log('  Q6   จับเวลาและนับคำขอ');
  const have = { TB_API_KEY: !!cfg.tbApiKey, TB_ASSET_ID: !!cfg.assetId, TB_CUSTOMER_MEMBERS_ID: !!cfg.customerMembersId, TB_CUSTOMER_STAFF_ID: !!cfg.customerStaffId, TB_HOST: cfg.tbHost.replace(/^(https?:\/\/[^/]+).*/, '$1') };
  log('การตั้งค่า: ' + Object.entries(have).map(([k, v]) => `${k}=${v === true ? 'มี' : v === false ? 'ไม่มี' : v}`).join(' · '));
  if (!run) { log('dry-run: ยังไม่ยิงอะไร ใส่ --run เพื่อยิงจริง (เจ้าของอนุญาตก่อน)'); return 0; }
  if (!cfg.tbApiKey || !cfg.assetId || !cfg.customerMembersId) { log('หยุด: ต้องมี TB_API_KEY, TB_ASSET_ID และ TB_CUSTOMER_MEMBERS_ID'); return 1; }

  const { send, stat } = makeSender(cfg.tbHost, fetchImpl, cfg.tbTimeoutMs);
  const apiKey = 'ApiKey ' + cfg.tbApiKey.replace(/^ApiKey /, '');
  const A = '/api/plugins/telemetry/ASSET/' + encodeURIComponent(cfg.assetId) + '/values/attributes/SERVER_SCOPE';
  const U = uid => '/api/plugins/telemetry/USER/' + encodeURIComponent(uid) + '/values/attributes/SERVER_SCOPE?keys=books';
  const t0 = now(), timing = [];
  const lap = name => timing.push([name, now() - t0]);

  // ---------- Q0: config / closed / bk_ จาก asset (อ่านทั้งก้อนครั้งเดียว) ----------
  log('--- Q0: asset ParkHere-Data ---');
  const all = await send('GET', A, { auth: apiKey });
  lap('Q0');
  const items = all.status === 200 && Array.isArray(all.data) ? all.data.filter(x => x && typeof x.key === 'string') : null;
  const bkNow = [];   // [{ id, uid, s }] การจอง active ใน bk_
  if (!items) row('inc', 'Q0 อ่าน asset', all.status, 'อ่านไม่ได้ Q5 จึงสรุปไม่ได้');
  else {
    const cfgItem = items.find(x => x.key === 'config'), clItem = items.find(x => x.key === 'closed');
    const cfgVal = cfgItem ? parseVal(cfgItem.value) : undefined;
    row(cfgItem ? 'info' : 'inc', 'Q0 config', all.status, !cfgItem ? 'ไม่มีคีย์ config (ระบบใช้ค่า default)' :
      `ชนิดที่ ThingsBoard คืน = ${typeOf(cfgItem.value)}, อ่านเป็นอ็อบเจกต์ได้ = ${isObj(cfgVal) ? 'ใช่' : 'ไม่'}` + (isObj(cfgVal) ? `, คีย์ = ${Object.keys(cfgVal).filter(k => /^\w{1,20}$/.test(k)).join(',')}, ค่า = ${JSON.stringify(cfgVal).slice(0, 300)}` : ''));
    const clVal = clItem ? parseVal(clItem.value) : undefined;
    row('info', 'Q0 closed', all.status, !clItem ? 'ไม่มีคีย์ closed (= ไม่มีช่องที่ปิด)' :
      `ชนิดที่ ThingsBoard คืน = ${typeOf(clItem.value)}, จำนวนช่องที่ปิด = ${isObj(clVal) ? Object.values(clVal).filter(v => v === true).length : 'อ่านไม่ได้'}, จำนวนคีย์ทั้งหมด = ${isObj(clVal) ? Object.keys(clVal).length : '-'}`);
    const bkKeys = items.filter(x => /^bk_\d{1,2}-\d{1,3}$/.test(x.key));
    for (const it of bkKeys) {
      const arr = parseVal(it.value);
      if (Array.isArray(arr)) for (const b of arr) if (isObj(b) && (b.status === undefined || b.status === 'active') && typeof b.id === 'string' && typeof b.uid === 'string') bkNow.push({ id: b.id, uid: b.uid, s: +b.s || 0 });
    }
    for (const b of bkNow) secrets.push(b.uid);
    row('info', 'Q0 ขนาด', undefined, `คีย์ทั้งหมด ${items.length} (bk_ ${bkKeys.length}), ขนาดคำตอบ ${all.bytes} ไบต์, การจอง active ใน bk_ = ${bkNow.length}`);
  }

  // ---------- Q1: รายชื่อผู้ใช้ด้วย API key ----------
  log('--- Q1: รายชื่อผู้ใช้ (ทาง ก) ---');
  const users = new Map();   // uid -> 'members' | 'staff' | 'tenant'
  const me = await send('GET', '/api/auth/user', { auth: apiKey });
  let tenantId = null;
  if (me.status === 200 && isObj(me.data)) {
    tenantId = me.data.tenantId && me.data.tenantId.id; if (tenantId) secrets.push(tenantId);
    row(me.data.authority === 'TENANT_ADMIN' ? 'pass' : 'inc', 'Q1 สิทธิ์ของ API key', me.status, 'authority = ' + String(me.data.authority).replace(/[^\w]/g, ''));
  } else row('inc', 'Q1 สิทธิ์ของ API key', me.status, 'GET /api/auth/user ไม่ผ่าน');
  const listUsers = async (label, path, group) => {
    const r = await send('GET', path + '?pageSize=10&page=0', { auth: apiKey });
    const p = page(r.data);
    if (r.status !== 200 || !p) { row('inc', label, r.status, 'ไม่ได้ PageData (เลือกทาง ก ไม่ได้ถ้าข้อนี้ไม่ผ่าน)'); return; }
    const ids = p.data.map(uidOf).filter(Boolean);
    ids.forEach(id => { secrets.push(id); if (!users.has(id)) users.set(id, group); });
    const fields = isObj(p.data[0]) ? Object.keys(p.data[0]).filter(k => /^\w{1,30}$/.test(k)).join(',') : '-';
    row('pass', label, r.status, `ผู้ใช้ ${ids.length} คน, totalElements=${p.totalElements}, hasNext=${p.hasNext}, ฟิลด์ที่มี = ${fields}`);
  };
  await listUsers('Q1 รายชื่อ customer Members', `/api/customer/${encodeURIComponent(cfg.customerMembersId)}/users`, 'members');
  if (cfg.customerStaffId) await listUsers('Q1 รายชื่อ customer Staff', `/api/customer/${encodeURIComponent(cfg.customerStaffId)}/users`, 'staff');
  else row('skip', 'Q1 รายชื่อ customer Staff', undefined, 'ไม่ได้ตั้ง TB_CUSTOMER_STAFF_ID');
  lap('Q1');

  // ---------- Q2: ผู้ใช้ระดับ Tenant ----------
  log('--- Q2: ผู้ใช้ระดับ Tenant (master) ---');
  if (tenantId) await listUsers('Q2 รายชื่อผู้ใช้ Tenant', `/api/tenant/${encodeURIComponent(tenantId)}/users`, 'tenant');
  else row('skip', 'Q2', undefined, 'ไม่ทราบ tenantId (Q1 ไม่ผ่าน)');
  lap('Q2');

  // ---------- Q3: entity query USER + books ----------
  log('--- Q3: entity query ชนิด USER พร้อม books (ทาง ข) ---');
  const q = await send('POST', '/api/entitiesQuery/find', { auth: apiKey, body: {
    entityFilter: { type: 'entityType', entityType: 'USER' },
    pageLink: { pageSize: 10, page: 0, sortOrder: { key: { type: 'ENTITY_FIELD', key: 'createdTime' }, direction: 'DESC' } },
    entityFields: [{ type: 'ENTITY_FIELD', key: 'createdTime' }],
    latestValues: [{ type: 'SERVER_ATTRIBUTE', key: 'books' }],
    keyFilters: [],
  } });
  const qp = page(q.data);
  if (q.status !== 200 || !qp) row('inc', 'Q3 entitiesQuery/find USER', q.status, 'ใช้ไม่ได้ ใช้ทาง ก ต่อ');
  else {
    const withBooks = qp.data.filter(e => isObj(e) && isObj(e.latest) && isObj(e.latest.SERVER_ATTRIBUTE) && isObj(e.latest.SERVER_ATTRIBUTE.books));
    const sample = withBooks[0] && withBooks[0].latest.SERVER_ATTRIBUTE.books.value;
    row('pass', 'Q3 entitiesQuery/find USER', q.status, `ได้ ${qp.data.length} เอนทิตี, มี books ${withBooks.length} ราย, ชนิดของค่า books = ${typeOf(sample)}, totalElements=${qp.totalElements}, hasNext=${qp.hasNext}`);
  }
  lap('Q3');

  // ---------- Q4: books ต่อผู้ใช้ ----------
  log('--- Q4: books ต่อผู้ใช้ (ไม่พิมพ์เนื้อหา) ---');
  const booksBy = new Map();   // uid -> [{ id, status, s }]
  let readFail = 0;
  const uids = [...users.keys()].slice(0, 5);
  if (!uids.length) row('skip', 'Q4', undefined, 'ไม่พบผู้ใช้จาก Q1/Q2');
  let maxBytes = 0, maxN = 0, nActive = 0;
  for (const uid of uids) {
    const r = await send('GET', U(uid), { auth: apiKey });
    if (r.status !== 200 || !Array.isArray(r.data)) { readFail++; continue; }
    const it = r.data.find(x => x && x.key === 'books');
    const arr = it ? parseVal(it.value) : [];
    const list = Array.isArray(arr) ? arr.filter(b => isObj(b) && typeof b.id === 'string') : [];
    maxBytes = Math.max(maxBytes, r.bytes); maxN = Math.max(maxN, list.length);
    nActive += list.filter(b => b.status === 'active').length;
    booksBy.set(uid, list.map(b => ({ id: b.id, status: b.status, s: +b.s || 0 })));
  }
  if (uids.length) row(readFail ? 'inc' : 'info', 'Q4 books ต่อผู้ใช้', readFail ? 'บางราย' : 200,
    `อ่านได้ ${booksBy.size}/${uids.length} คน, ขนาดคำตอบสูงสุด ${maxBytes} ไบต์, รายการสูงสุดต่อคน ${maxN}, active รวม ${nActive}${readFail ? ', อ่านไม่ได้ ' + readFail + ' คน' : ''}`);
  lap('Q4');

  // ---------- Q5: ความขัดกัน bk_ กับ books (ในหน่วยความจำ) ----------
  log('--- Q5: ความขัดกัน bk_ กับ books ---');
  if (!items) row('skip', 'Q5', undefined, 'ไม่มีข้อมูล asset');
  else {
    const t = now(), old = s => t - s > GRACE_MS;
    const bkIds = new Set(bkNow.map(b => b.id));
    let noCopy = 0, noCopyFresh = 0, unknownOwner = 0, unread = 0, booksNoBk = 0, booksNoBkFresh = 0;
    for (const b of bkNow) {
      if (!users.has(b.uid)) { unknownOwner++; continue; }
      const list = booksBy.get(b.uid);
      if (!list) { unread++; continue; }
      if (!list.some(x => x.id === b.id)) { if (old(b.s)) noCopy++; else noCopyFresh++; }
    }
    for (const list of booksBy.values()) for (const b of list) if (b.status === 'active' && !bkIds.has(b.id)) { if (old(b.s)) booksNoBk++; else booksNoBkFresh++; }
    const bad = noCopy + unknownOwner + booksNoBk;
    row(bad ? 'info' : 'pass', 'Q5 ผลเทียบ', undefined,
      `bk_ ไม่มีสำเนาใน books (เกิน 120 วิ) = ${noCopy} (ภายใน 120 วิ ${noCopyFresh}) · bk_ ของ uid ที่ไม่พบในรายชื่อ = ${unknownOwner} · bk_ ที่อ่าน books เจ้าของไม่ได้ = ${unread} · books active ที่ไม่มี bk_ (เกิน 120 วิ) = ${booksNoBk} (ภายใน 120 วิ ${booksNoBkFresh}) · ผู้ใช้ที่เทียบได้ ${booksBy.size}`);
  }

  // ---------- Q6: เวลา / จำนวนคำขอ ----------
  log('--- Q6: เวลาและจำนวนคำขอ ---');
  const total = now() - t0;
  let prev = 0; const parts = timing.map(([n, at]) => { const d = at - prev; prev = at; return `${n} ${d} ms`; });
  row(stat.n <= 15 ? 'pass' : 'inc', 'Q6 จำนวนคำขอ', undefined, `${stat.n} คำขอ (เป้า ≤ 15), เวลารวม ${total} ms (${parts.join(', ')})`);

  log(`สรุป: ผ่าน ${tally.pass} · ไม่ผ่าน ${tally.fail} · ไม่แน่ใจ ${tally.inc} · ข้อมูล ${tally.info} · ข้าม ${tally.skip}  (ไม่มีการเขียนข้อมูลใดๆ)`);
  return tally.fail || tally.inc ? 1 : 0;
}

if (require.main === module) {
  loadDotEnv(ENV_FILE, false);
  main().then(code => process.exit(code), e => { console.error('ผิดพลาด:', e && e.message); process.exit(1); });
}
module.exports = { main, assertAllowed };
