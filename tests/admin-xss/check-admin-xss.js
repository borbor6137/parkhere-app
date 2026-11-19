/**
 * พิสูจน์ว่า payload XSS ในข้อมูลผู้ใช้ไม่หลุดเป็นแท็กจริงในหน้า admin.html / master.html
 * รัน: node tests/admin-xss/check-admin-xss.js
 *
 * โครงสร้างปัจจุบัน (M5): ทั้งสองหน้าใช้ admin-core.js ตัวเดียว วาดข้อมูลจากคำตอบ parkhere-api (ไม่มี Firebase)
 * วิธี: รัน admin-core.js ใน vm พร้อม DOM จำลอง และ fetch จำลองที่ตอบข้อมูลที่ใส่ payload
 *       (/api/me, /api/lot, /api/live แบบ SSE, /api/admin/bookings) แล้วให้หน้าวาดเองตามเส้นทางจริง
 *       (โทเคนใน sessionStorage -> loadMe -> enter -> start -> draw / drawBookings)
 *       จากนั้นกดยกเลิกการจอง (dialog), ส่งออก CSV, ปิดช่อง และสั่งไม้กั้น เพื่อตรวจทุกจุดที่เขียน innerHTML
 * ปลอดภัย: ไม่เปิดเครือข่าย ไม่ต่อ ThingsBoard/parkhere-api จริง ไม่เปิดพอร์ตใด ๆ ข้อมูลทั้งหมดเป็นข้อมูลสมมติ
 *
 * เกณฑ์ (ไม่ลดจากของเดิม): ในทุก innerHTML ที่หน้าเขียน
 *   1) ไม่มีแท็ก img/svg/script/iframe/object/embed/style/link/base/form ที่ผู้โจมตีสร้างได้
 *   2) ไม่มี attribute on* จริง
 *   3) ไม่มีสตริง payload ดิบ (ที่มี < > " ') ปรากฏเลย (ต้องถูก escape เป็น &lt; &gt; &quot; &#39; ทั้งหมด)
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const CODE = fs.readFileSync(path.join(root, 'admin-core.js'), 'utf8');
const SLOTNAME = fs.readFileSync(path.join(root, 'slotname.js'), 'utf8');
const P = ['<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "'><script>alert(1)</script>", '</td><td onclick=alert(1)>x', '" autofocus onfocus=alert(1) x="'];
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('FAIL', m); } else console.log('ok  ', m); };
const tick = (n = 8) => new Promise(r => { let i = 0; const f = () => (++i >= n ? r() : setImmediate(f)); setImmediate(f); });

// ตรวจ HTML ที่ได้: แท็กอันตรายจริง / attribute on* จริง / payload ดิบหลุดมา
const BADTAG = /<\s*(img|svg|script|iframe|object|embed|style|link|base|form|meta|math)\b/i;
// attribute on* "จริง" = ชื่อ attribute ของแท็กที่ parse ได้ (ตัดค่าในเครื่องหมายคำพูดออกก่อน เพราะข้อความที่ถูก escape อยู่ใน title/aria-label ได้)
const TAG = /<[a-z][^\s>\/]*((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
const evAttr = h => { for (const m of h.matchAll(TAG)) if (/(^|[\s"'\/])on\w+\s*=/i.test(m[1].replace(/"[^"]*"|'[^']*'/g, '""'))) return true; return false; };
const live = h => BADTAG.test(h) || evAttr(h);
const rawLeak = h => P.find(p => h.includes(p)) || (/"\s*(autofocus|onfocus|onclick)\s*=?/i.test(h) && 'attr-breakout') || null;

function mkEl(reg, id) {
  const cls = new Set();
  return {
    id, _h: '', _t: '', dataset: {}, style: {}, children: [], value: '', disabled: false, hidden: false, type: 'text', className: '',
    set innerHTML(v) { this._h = String(v); reg.html.push([id, this._h]); }, get innerHTML() { return this._h; },
    set textContent(v) { this._t = String(v); }, get textContent() { return this._t; },
    classList: { contains: c => cls.has(c), add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, f) => { (f === undefined ? !cls.has(c) : f) ? cls.add(c) : cls.delete(c); } },
    appendChild(c) { this.children.push(c); reg.appended.push(c); return c; }, remove() {}, focus() {}, click() {}, setAttribute() {}, addEventListener() {}, removeEventListener() {},
    querySelector(s) { this._q = this._q || {}; return this._q[s] || (this._q[s] = mkEl(reg, id + '>' + s)); }, querySelectorAll() { return [mkEl(reg, id + '>all')]; }, closest: () => null,
    get lastElementChild() { return this._l || (this._l = mkEl(reg, id + '>last')); }
  };
}

async function run(file) {
  console.log('==', file);
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const page = (/data-page="(\w+)"/.exec(html) || [])[1], roles = (/data-roles="([^"]+)"/.exec(html) || [])[1];
  ok(!!page && !!roles && /<script src="admin-core\.js(\?v=\d+)?"/.test(html) && /<script src="slotname\.js(\?v=\d+)?"/.test(html) && html.indexOf('slotname.js') < html.indexOf('admin-core.js') &&!/<script>[^<]/.test(html), file + ' ใช้ admin-core.js และไม่มี inline script (page=' + page + ')');
  ok(!/firebase|db\.ref/i.test(html + CODE.replace(/ไม่มี Firebase/g, '')), file + ' ไม่มี firebase / db.ref ในโค้ดที่รัน');

  const reg = { html: [], appended: [], blobs: [], calls: [] };
  const els = {};
  const el = id => els[id] || (els[id] = mkEl(reg, id));
  const body = mkEl(reg, 'body'); body.dataset = { page, roles };
  const document = {
    getElementById: el, querySelectorAll: () => [], querySelector: () => el('_q'), createElement: t => mkEl(reg, '<' + t + '>'),
    body, head: mkEl(reg, 'head'), addEventListener() {}, activeElement: null, hidden: false
  };

  const now = Date.now();
  // ข้อมูลสมมติที่ใส่ payload ในทุกฟิลด์ที่ผู้ใช้ควบคุมได้ (ชื่อ ทะเบียน อีเมล เหตุผล id) และฟิลด์ที่เซิร์ฟเวอร์อาจส่งมา
  const E30 = now + 30 * 864e5;   // e จริงของระบบ = s + 30 วัน (ที่กันช่อง) ห้ามโผล่บนจอ/CSV
  const OUT = now - 1e5;
  const fd = t => new Date(t).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
  const hb = (id, over) => Object.assign({ id, f: 1, i: 1, s: now - 6e5, e: E30, status: 'active', amt: 20, park: 5,
    ownerName: P[0], car: P[1], ownerEmail: P[2], reason: P[3], u: P[4] }, over);
  const bookings = [
    hb('b1'),
    hb('b2', { i: 2, status: 'cancelled', reason: P[0], ownerName: P[4], car: P[2] }),
    hb('b3', { i: 3, status: 'done', amt: P[0], park: P[1], f: P[2] }),
    hb('b4', { i: P[0], status: P[1], ownerName: '=HYPERLINK("http://x")', car: '@SUM(1+1)' }),
    hb('b5', { stale: true, ownerName: '+cmd|calc', car: '-2+3' }),
    hb('b8', { i: 4, status: 'done', ownerName: 'DONEROW', car: 'DN1', out: OUT, min: 10, park: 0 }),
    hb('b9', { i: 5, status: 'cancelled', ownerName: 'CANCROW', car: 'CN1' }),   // ไม่มี out -> "—"
    hb('b6', { id: P[0], ownerName: P[1], car: P[2] }),                  // id ผิดรูปแบบ ต้องไม่มีปุ่มยกเลิกที่ฝัง id ดิบ
    { id: 'b7', f: 1, i: 0, s: now - 1e5, e: now + 1e5, status: 'active', ownerName: '', car: null }
  ];
  const slots = [];
  for (let f = 1; f <= 2; f++) for (let i = 0; i < 6; i++) slots.push({ k: f + '-' + i, f, i, occ: i === 1 ? true : (i === 2 || i === 5) ? null : false, barrier: i === 1 ? 'down' : 'up', closed: i === 3,
    bookings: i >= 4 ? [] : [{ id: 'x', status: 'active', s: now - 1e5, e: now + 1e5, ownerName: P[0], car: P[1] }], note: P[0] });
  slots.push({ k: '1-abc', f: 1, i: 'abc' }, { k: '1-99999', f: 1, i: 99999 }, { k: '-1-2', f: -1, i: 2 }, { k: P[0], f: 1, i: 9 }, { k: '1-' + P[1], f: 1, i: 10 }, { k: '9-9', f: P[0], i: P[1] });   // key ผิดรูปแบบ ต้องถูกทิ้ง/ไม่ทำให้พัง
  const lot = { slots, config: { rate: 20, bookfee: 20, freemin: 30, floors: 2, slots: 4, noshow: 30, name: P[0] }, closed: { '1-3': true, [P[0]]: true }, board: { status: P[1] }, stale: false };
  const me = { id: 'u1', role: 'master', name: P[0], email: P[1], configEditable: true };

  const enc = new TextEncoder();
  const sse = 'event: snapshot\ndata: ' + JSON.stringify(lot) + '\n\n' +
    'event: slot\ndata: ' + JSON.stringify({ k: '1-1', occ: true, barrier: 'down', ownerName: P[0] }) + '\n\n' +
    'event: slot\ndata: ' + JSON.stringify({ k: P[0], occ: true }) + '\n\n' +
    'event: bookings\ndata: ' + JSON.stringify({ k: '1-1', bookings: [hb('s1')] }) + '\n\n' +
    'event: board\ndata: ' + JSON.stringify({ board: { status: P[2] } }) + '\n\n' +
    'event: config\ndata: ' + JSON.stringify({ config: { rate: P[0], floors: P[1] } }) + '\n\n' +
    'event: closed\ndata: ' + JSON.stringify({ closed: { [P[0]]: true } }) + '\n\n';
  const json = (status, o) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => o });

  const ctx = {
    document, console, Math, Date, JSON, Object, Array, String, Number, Set, Map, Promise, Error, Symbol, isFinite, parseInt, encodeURIComponent, TextDecoder, AbortController, URLSearchParams,
    location: { hostname: 'x.test', search: '', href: '', reload() {} }, sessionStorage: { getItem: () => JSON.stringify({ t: 'fake-token' }), setItem() {}, removeItem() {} },
    innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {}, requestAnimationFrame() {},
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},   // ไม่รันตัวจับเวลา: ทุกอย่างขับเคลื่อนด้วยมือ
    Blob: function (parts) { reg.blobs.push(parts.join('')); }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    PH_API_BASE: 'http://api.invalid',                       // โดเมน .invalid + fetch จำลอง: ไม่มีทางออกเครือข่าย
    fetch: async (url, opt) => {
      const u = String(url).replace('http://api.invalid', ''); reg.calls.push([opt && opt.method || 'GET', u]);
      if (/^http/.test(u)) throw new Error('ห้ามออกเครือข่ายจริง: ' + u);
      if (u === '/api/me') return json(200, me);
      if (u.startsWith('/api/lot')) return json(200, lot);
      if (u.startsWith('/api/admin/bookings')) return json(200, { bookings, total: 7, truncated: true, staleCount: 1, serverNow: now });
      if (u === '/api/admin/barrier' || u === '/api/admin/closed') return json(409, { error: { code: 'X', message: P[0] } });
      if (u.startsWith('/api/bookings/')) return json(409, { error: { code: 'X', message: P[1] } });   // ข้อความผิดพลาดจากเซิร์ฟเวอร์ที่มี payload
      if (u === '/api/live') {
        let sent = false;
        return { ok: true, status: 200, body: { getReader: () => ({ read: () => sent ? new Promise(() => {}) : (sent = true, Promise.resolve({ done: false, value: enc.encode(sse) })) }) } };
      }
      return json(404, { error: { code: 'NOT_FOUND' } });
    }
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SLOTNAME, ctx, { filename: 'slotname.js' });   // เหมือนหน้าจริง: slotname.js โหลดก่อน admin-core.js
  vm.runInContext(CODE, ctx, { filename: 'admin-core.js' });
  await tick(40);

  ok(el('app').classList.contains('on'), file + ' เข้าหน้าแอปได้จากเซสชันจำลอง (role จาก /api/me)');
  ok(reg.calls.some(c => c[1].startsWith('/api/admin/bookings')) && reg.calls.some(c => c[1] === '/api/live'), file + ' หน้าโหลดรายการจองและ SSE ผ่าน API จำลอง');
  ok(reg.calls.every(c => c[1].startsWith('/api/')), file + ' คำขอทุกตัวไปที่ /api/* เท่านั้น');

  // ขับ UI เพิ่ม: ค้นหา, ยกเลิกการจอง (dialog), ส่งออก CSV, ปิดช่อง, สั่งไม้กั้น
  el('q').value = 'x'; el('q').oninput && el('q').oninput(); el('q').value = ''; el('q').oninput && el('q').oninput();
  const dlg0 = reg.appended.length;
  if (el('rows').onclick) { el('rows').onclick({ target: { closest: () => ({ dataset: { c: 'b1' } }) } }); await tick(5); }
  ok(reg.appended.length > dlg0, file + ' กดยกเลิกการจอง -> เปิด dialog ยืนยัน (เห็นผลก่อนทำ)');
  el('csv').onclick && el('csv').onclick();
  const pressK = k => ({ target: { closest: s => (s.includes('.s[data-k]') ? { dataset: { k } } : null) } });
  const fl = el('floors');
  if (fl.onclick) { fl.onclick(pressK('1-1')); await tick(5); fl.onclick(pressK(P[0])); await tick(3); }
  el('bmode').onclick && el('bmode').onclick();
  if (fl.onclick) { fl.onclick(pressK('1-1')); await tick(5); fl.onclick(pressK('1-2')); await tick(5); }
  await tick(10);

  // ---- ตรวจทุก innerHTML ที่หน้าเขียนตลอดการทำงาน ----
  const seen = {};
  for (const [id, h] of reg.html) (seen[id] = seen[id] || []).push(h);
  for (const id of ['rows', 'recent', 'cards', 'floors', 'occ']) {
    const hs = seen[id] || [];
    ok(hs.some(h => h.length > 80), file + ' #' + id + ' ถูกวาดจริง (' + hs.length + ' ครั้ง) ไม่ใช่ตรวจของว่าง');
    ok(hs.every(h => !live(h)), file + ' #' + id + ' ไม่มีแท็ก/attribute อันตราย');
    ok(hs.every(h => !rawLeak(h)), file + ' #' + id + ' ไม่มี payload ดิบหลุด (escape ครบ)');
  }
  const all = reg.html.map(x => x[1]);
  ok(all.every(h => !live(h)), file + ' innerHTML ทุกจุดรวม ' + all.length + ' ครั้ง ไม่มีแท็ก/attribute อันตราย');
  ok(all.every(h => !rawLeak(h)), file + ' innerHTML ทุกจุด ไม่มี payload ดิบ');
  ok(all.some(h => h.includes('&lt;img')), file + ' payload ถูก escape เป็น &lt;img (พิสูจน์ว่า payload ถึงจุดวาดจริง)');
  ok(all.some(h => h.includes('&quot;&gt;&lt;svg')), file + ' payload ที่มี "> ถูก escape เป็น &quot;&gt;');
  const dlgs = reg.appended.filter(c => c._h);
  ok(dlgs.length > 0 && dlgs.every(c => !live(c._h) && !rawLeak(c._h)), file + ' dialog ยืนยัน ' + dlgs.length + ' ตัว (ชื่อผู้จอง/ทะเบียนที่มี payload) ปลอดภัย');
  const rowsHtml = (seen.rows || []).join('');
  ok(/data-c="b1"/.test(rowsHtml) && !/data-c="[^"]*[<>' ][^"]*"/.test(rowsHtml), file + ' data-c มีแต่ id ปลอดภัย (id ที่มี payload ไม่มีปุ่มยกเลิก)');
  ok(el('mail').textContent === me.email, file + ' อีเมลแสดงด้วย textContent (ไม่ผ่าน innerHTML)');
  ok(['mail', 'err', 'bkwarn', 'tot', 'qsrv'].every(id => !(seen[id] || []).length), file + ' mail/err/bkwarn/tot ไม่เคยถูกเขียนด้วย innerHTML');
  const notes = reg.appended.filter(c => c.className === 'nt');
  ok(notes.length > 0 && notes.every(c => !c._h), file + ' แจ้งเตือน/ข้อความผิดพลาดจากเซิร์ฟเวอร์ (' + notes.length + ' ตัว) ใช้ textContent ไม่ผ่าน innerHTML');
  const csv = (reg.blobs[0] || '').replace(/^﻿/, '');
  ok(csv.length > 0, file + ' ส่งออก CSV ได้');
  ok(!/(^|,)"[=+\-@]/m.test(csv), file + ' CSV ไม่มีเซลล์ที่ขึ้นต้นด้วย = + - @ (กัน formula injection)');
  ok(csv.includes('"\'=HYPERLINK') && csv.includes('"\'@SUM') && csv.includes('"\'+cmd'), file + ' CSV ใส่ \' นำหน้าเซลล์ที่เป็นสูตร');
  // คอลัมน์ "ออก": ห้ามแสดง e (s+30 วัน) ไม่ว่าจอหรือ CSV
  ok(!rowsHtml.includes(fd(E30)) && !csv.includes(fd(E30)), file + ' ไม่แสดง e (s+30 วัน) ในตารางและ CSV');
  ok(!/<th>สิ้นสุด<\/th>|data-l="สิ้นสุด"/.test(rowsHtml + html) && /<th>ออก<\/th>/.test(html) && csv.split('\n')[0].includes('"ออก"') && !csv.split('\n')[0].includes('สิ้นสุด'), file + ' หัวคอลัมน์ "ออก" (หน้าและ CSV) ไม่ใช้ "สิ้นสุด"');
  ok(/data-l="ออก">ยังไม่ออก</.test(rowsHtml) && /"ยังไม่ออก"/.test(csv), file + ' การจอง active แสดง "ยังไม่ออก" (หน้าและ CSV)');
  const rowOf = n => (rowsHtml.match(new RegExp('<tr>(?:(?!</tr>).)*' + n + '(?:(?!</tr>).)*</tr>', 's')) || [''])[0];
  ok(rowOf('DONEROW').includes('data-l="ออก">' + fd(OUT)) && csv.includes('"' + fd(OUT) + '"'), file + ' จบแล้วแสดงเวลาออกจริง (out) ทั้งหน้าและ CSV');
  ok(/data-l="ออก">—</.test(rowOf('CANCROW')), file + ' จบแล้วแต่ไม่มี out แสดง "—"');
  const fh = (seen.floors || []).join('');
  if (process.env.DBG) console.log(fh.slice(0, 1500), '\nROWS', rowsHtml.match(/F[0-9?]-[A-Z?]/g));
  // ชื่อช่องใหม่: 6 ช่อง/ชั้น A1 A2 B1 B2 C1 C2 ตรงกับ index 0..5, เลนคั่นกลาง, สถานะไม่ใช้สีอย่างเดียว
  const nm = [...fh.matchAll(/data-k="1-(\d)"[^>]*>([A-Z]\d)</g)].map(m => m[1] + '=' + m[2]);
  ok(['0=A1', '1=A2', '2=B1', '3=B2', '4=C1', '5=C2'].every(x => nm.includes(x)), file + ' ผังใช้ชื่อ A1..C2 ตาม index 0..5 (' + [...new Set(nm)].join(',') + ')');
  ok(!/>D1</.test(fh) && /class="ln"/.test(fh), file + ' ไม่มีช่อง D1 และมีเลนคั่นกลาง');
  ok(/<small>✓ ว่าง<\/small>/.test(fh) && /<small>🚗 มีรถ<\/small>/.test(fh) && /<small>❔ ไม่ทราบ<\/small>/.test(fh) && /<small>🔒 ปิด<\/small>/.test(fh), file + ' สถานะมีไอคอน+ข้อความ ไม่ใช้สีอย่างเดียว');
  ok(!/data-k="[^"]*(abc|99999|-1-2)/.test(fh), file + ' คีย์ผิดรูปแบบ (1-abc, 1-99999, -1-2) ไม่ถูกวาดเป็นช่อง');
  // ชื่อช่องผิดรูปแบบในตารางการจอง ต้องเป็น ? ไม่โยน error ไม่เดาชื่อเอง
  ok(/F1-\?/.test(rowsHtml) && /F\?-\?/.test(rowsHtml), file + ' ตารางการจอง: i/f ผิดรูปแบบแสดงเป็น F1-? / F?-? ไม่ใช่ชื่อที่เดา');
  ok(/F1-A2/.test(rowsHtml) && /F1-B1/.test(rowsHtml), file + " ตารางการจองใช้ชื่อช่องเดียวกับผัง (F1-A2 / F1-B1)");
  ok(/F1-A2/.test(csv) && /F1-B1/.test(csv) && !/F1-[A-Z][34]/.test(csv), file + ' CSV ใช้ชื่อช่องเดียวกับผัง');
  ok((seen.floors || []).every(h => [...h.matchAll(/data-k="([^"]*)"/g)].every(m => /^\d{1,2}-\d{1,3}$/.test(m[1]))), file + ' ผังมีแต่ data-k รูปแบบ f-i (KRE กรองแล้ว)');
}

(async () => {
  for (const f of ['admin.html', 'master.html']) await run(f);
  console.log(fail ? '\nล้มเหลว ' + fail + ' ข้อ' : '\nผ่านทั้งหมด');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
