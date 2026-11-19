// ดูสถานะลานจอดสด (อ่านอย่างเดียว) ผ่าน parkhere-api: ล็อกอินด้วยบัญชีเจ้าของ แล้ว GET /api/lot วนทุก N วินาที
// พิมพ์สถานะรายอุปกรณ์ (online/offline/never/error) และสรุปช่อง: มีรถ / ว่าง / occ:null พร้อมเหตุผลของ null
// ไม่เขียนอะไรลง ThingsBoard เลย (ล็อกอิน = POST /api/login ของ API เท่านั้น ไม่มี signup / ไม่สร้างผู้ใช้)
//
// ใช้:  node scripts/lot-watch.js [--api <url>] [--every <วินาที>] [--once] [--all]
//   env: PARKHERE_API   ที่อยู่ API (ค่าเริ่มต้น http://localhost:10000; ชี้ Render ได้) หรือใช้ --api
//        PARKHERE_EMAIL อีเมลบัญชีเจ้าของ (ถ้าไม่ตั้ง จะถามตอนรัน)
//        PARKHERE_PASSWORD รหัสผ่าน (แนะนำไม่ตั้ง ให้พิมพ์ตอนถาม: ไม่แสดงบนจอ ไม่ลงไฟล์ ไม่ลงประวัติ)
//   --once  อ่านครั้งเดียวแล้วจบ   --all  แสดงรายช่องทุกช่อง   --every  ช่วงห่าง (ค่าเริ่มต้น 5, ต่ำสุด 2)
// ค่าเริ่มต้น 5 วินาทีต่อ 1 คำขอ: ขณะรันนี้ไม่เปิด SSE จึงไม่เกิน ~12 คำขอ/นาที ไป API (API cache ฝั่งเซิร์ฟเวอร์อยู่แล้ว)
// Render ฟรีอาจหลับ: คำขอแรกอาจนาน ~50 วินาที สคริปต์รอให้ (timeout 90 วินาที)
const readline = require('readline');

const hhmmss = ms => new Date(ms).toLocaleTimeString('th-TH', { hour12: false });
const ago = (now, t) => {
  if (!t) return 'ไม่เคยมีข้อมูล';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? s + ' วินาทีก่อน' : s < 3600 ? Math.floor(s / 60) + ' นาที ' + (s % 60) + ' วินาทีก่อน' : Math.floor(s / 3600) + ' ชม. ' + Math.floor((s % 3600) / 60) + ' นาทีก่อน';
};
const state = x => (x.occ === true ? 'มีรถ' : x.occ === false ? 'ว่าง' : 'occ:null');
const bar = x => (x.barrier === 'down' ? 'ไม้กั้นลง' : x.barrier === 'up' ? 'ไม้กั้นขึ้น' : 'ไม้กั้น?');
// เหตุผลที่ occ เป็น null (ตรงกับกฎ D5 ใน M2-api.md): ไม่ทราบสถานะ ห้ามตีเป็นว่าง
function nullReason(x) {
  if (x.conflict) return 'conflict (คีย์ซ้ำข้ามอุปกรณ์)';
  if (!x.source) return 'ไม่มีอุปกรณ์ส่งช่องนี้';
  if (x.online === false) return x.source + ' offline';
  return x.source + ' ออนไลน์แต่ไม่มีค่าของช่องนี้';
}

// lot = body ของ GET /api/lot; prev = lot รอบก่อน (ถ้ามี) -> บรรทัดข้อความ
function renderLot(lot, now, { all = false, prev = null } = {}) {
  const out = [];
  const nb = lot.board || {};
  out.push(`[${hhmmss(now)}] รวม: ${nb.status || '?'}  ข้อมูลอ่านล่าสุด ${ago(now, lot.asOf)}${lot.stale ? '  ** stale (ThingsBoard อ่านไม่ได้ ใช้ข้อมูลเก่า) **' : ''}  config=${lot.configSource || '?'}`);
  const slots = Array.isArray(lot.slots) ? lot.slots : [];
  for (const b of lot.boards || []) {
    const mine = slots.filter(x => x.source === b.id);
    const n = { t: mine.filter(x => x.occ === true).length, f: mine.filter(x => x.occ === false).length, nl: mine.filter(x => x.occ === null).length };
    out.push(`  อุปกรณ์ ${String(b.id).padEnd(4)} ${String(b.status).toUpperCase().padEnd(7)} hb ล่าสุด ${ago(now, b.lastSeen)}  ช่องของอุปกรณ์นี้ ${mine.length} (มีรถ ${n.t} / ว่าง ${n.f} / occ:null ${n.nl})`);
  }
  if (!(lot.boards || []).length) out.push('  (ไม่มีอุปกรณ์ในรายการ boards)');
  const c = { t: 0, f: 0, nl: 0 }; const nulls = [];
  for (const x of slots) { if (x.occ === true) c.t++; else if (x.occ === false) c.f++; else { c.nl++; nulls.push(x); } }
  out.push(`  ช่องทั้งหมด ${slots.length}: มีรถ ${c.t} / ว่าง ${c.f} / occ:null ${c.nl}`);
  if (nulls.length) {
    const by = {};
    for (const x of nulls) (by[nullReason(x)] = by[nullReason(x)] || []).push(x.k);
    for (const [why, ks] of Object.entries(by)) out.push(`    occ:null เพราะ ${why}: ${ks.length > 12 ? ks.slice(0, 12).join(',') + ' …(+' + (ks.length - 12) + ')' : ks.join(',')}`);
  }
  const bk = slots.reduce((s, x) => s + ((x.bookings || []).length), 0);
  const closed = slots.filter(x => x.closed).map(x => x.k);
  if (bk || closed.length) out.push(`  การจองที่เห็น ${bk} รายการ · ช่องปิด ${closed.length ? closed.join(',') : '-'}`);
  if (all) for (const x of slots) out.push(`    ${x.k.padEnd(5)} ${state(x).padEnd(7)} ${bar(x).padEnd(10)} ที่มา ${x.source || '-'}${x.occ === null ? '  (' + nullReason(x) + ')' : ''}`);
  if (prev && Array.isArray(prev.slots)) {
    const was = Object.fromEntries(prev.slots.map(x => [x.k, x]));
    for (const x of slots) { const p = was[x.k]; if (p && (p.occ !== x.occ || p.barrier !== x.barrier)) out.push(`  เปลี่ยน ${x.k}: ${state(p)}/${bar(p)} -> ${state(x)}/${bar(x)}`); }
    const pb = Object.fromEntries((prev.boards || []).map(b => [b.id, b.status]));
    for (const b of lot.boards || []) if (pb[b.id] && pb[b.id] !== b.status) out.push(`  เปลี่ยน อุปกรณ์ ${b.id}: ${pb[b.id]} -> ${b.status}`);
  }
  return out;
}

// ไคลเอนต์ API: ล็อกอิน (เก็บ token ในหน่วยความจำเท่านั้น) + อ่าน lot + ล็อกอินใหม่เมื่อ token หมดอายุ
function createWatcher({ base, email, password, fetchImpl = globalThis.fetch, timeoutMs = 90000 }) {
  base = String(base).replace(/\/+$/, '');
  let token = '';
  const j = async (path, { method = 'GET', body, auth } = {}) => {
    const h = { Accept: 'application/json' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth) h.Authorization = 'Bearer ' + auth;
    const r = await fetchImpl(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { /* ไม่ใช่ JSON */ }
    return { status: r.status, data: d };
  };
  const errText = r => (r.data && r.data.error ? `${r.data.error.code}: ${r.data.error.message}` : 'HTTP ' + r.status);
  async function login() {
    const r = await j('/api/login', { method: 'POST', body: { email, password } });
    if (r.status !== 200 || !r.data || !r.data.token) throw new Error('ล็อกอินไม่สำเร็จ (' + errText(r) + ')');
    token = r.data.token; return r.data.user && r.data.user.role;
  }
  async function lot() {
    if (!token) await login();
    let r = await j('/api/lot', { auth: token });
    if (r.status === 401) { await login(); r = await j('/api/lot', { auth: token }); }
    if (r.status !== 200 || !r.data) throw new Error('อ่าน /api/lot ไม่สำเร็จ (' + errText(r) + ')');
    return r.data;
  }
  return { login, lot };
}

function ask(q, hidden) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); };   // ไม่แสดงตัวอักษรที่พิมพ์
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); res(a); });
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const base = arg('--api', env.PARKHERE_API || 'http://localhost:10000');
  const every = Math.max(2, Number(arg('--every', 5)) || 5) * 1000, once = argv.includes('--once'), all = argv.includes('--all');
  const email = env.PARKHERE_EMAIL || (await ask('อีเมลบัญชีเจ้าของ: ', false)).trim();
  const password = env.PARKHERE_PASSWORD || (await ask('รหัสผ่าน (ไม่แสดงบนจอ): ', true));
  if (!email || !password) { console.error('ต้องมีอีเมลและรหัสผ่าน'); process.exit(1); }
  const w = createWatcher({ base, email, password });
  console.log(`API: ${base}  (อ่านอย่างเดียว กด Ctrl+C เพื่อหยุด)`);
  const role = await w.login();
  console.log('ล็อกอินแล้ว บทบาท: ' + (role || '?'));
  let prev = null, stop = false;
  process.on('SIGINT', () => { stop = true; console.log('\nหยุดแล้ว'); process.exit(0); });
  do {
    try { const lot = await w.lot(); console.log(renderLot(lot, Date.now(), { all, prev }).join('\n')); prev = lot; }
    catch (e) { console.error(`[${hhmmss(Date.now())}] ${e.message}`); if (once) process.exit(1); }
    if (once || stop) break;
    await new Promise(r => setTimeout(r, every));
  } while (!stop);
}

module.exports = { renderLot, nullReason, createWatcher };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
