// เครื่องมือกลาง: error ภาษาไทย, rate limit, cache, ตรวจ input
const crypto = require('crypto');

class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const E = {
  badInput: m => new ApiError(400, 'BAD_INPUT', m),
  noAuth: () => new ApiError(401, 'UNAUTHORIZED', 'กรุณาเข้าสู่ระบบ'),
  badToken: () => new ApiError(401, 'TOKEN_INVALID', 'เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่'),
  expired: () => new ApiError(401, 'TOKEN_EXPIRED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'),
  upstream: () => new ApiError(502, 'UPSTREAM', 'ระบบหลังบ้านไม่ตอบสนอง ลองใหม่อีกครั้ง'),
};

// หน้าต่างเลื่อน: อนุญาต max ครั้งต่อ windowMs ต่อ key
function createLimiter(max, windowMs, now = () => Date.now()) {
  const hits = new Map();
  return {
    // ดูว่าเต็มหรือยังโดยไม่นับครั้งนี้ (ใช้ตรวจก่อนยิง ThingsBoard แล้วค่อย take เมื่อผลเป็นลบ)
    peek(key) { const t = now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs); return arr.length >= max ? { ok: false, retryMs: windowMs - (t - arr[0]) } : { ok: true }; },
    take(key) {
      const t = now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs);
      if (arr.length >= max) { hits.set(key, arr); return { ok: false, retryMs: windowMs - (t - arr[0]) }; }
      arr.push(t); hits.set(key, arr);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] >= windowMs) hits.delete(k);
      return { ok: true };
    },
  };
}

// ล็อกบัญชีหลังใส่รหัสผิดเกินกำหนด
function createLockout(maxFails, lockMs, now = () => Date.now()) {
  const m = new Map();
  return {
    check(k) { const r = m.get(k); return r && r.until > now() ? r.until - now() : 0; },
    fail(k) { const r = m.get(k) || { n: 0, until: 0 }; if (r.until && r.until <= now()) { r.n = 0; r.until = 0; } r.n++; if (r.n >= maxFails) { r.until = now() + lockMs; r.n = 0; } m.set(k, r); if (m.size > 5000) m.clear(); },
    ok(k) { m.delete(k); },
  };
}

function createCache(ttlMs, max = 2000, now = () => Date.now()) {
  const m = new Map();
  return {
    get(k) { const r = m.get(k); if (!r) return; if (r.exp <= now()) { m.delete(k); return; } return r.v; },
    set(k, v, ttl = ttlMs) { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, { v, exp: now() + ttl }); },
    del(k) { m.delete(k); },
    clear() { m.clear(); },
  };
}

// คิวต่อ key กันเขียนทับกัน (instance เดียว)
function keyedLock() {
  const tails = new Map();
  return async function run(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    let release; const mine = new Promise(r => (release = r));
    tails.set(key, prev.then(() => mine));
    await prev;
    try { return await fn(); } finally { release(); if (tails.get(key) === mine) tails.delete(key); }
  };
}

// ล็อกเดียวของ "การเปลี่ยนแปลงการจองทั้งหมด" (M3 ข้อ 14): คิวรอ <= maxQueue เกิน = BUSY (ไม่ทำงาน), รอล็อกนานเกิน maxWaitMs = BUSY
// ไม่มีล็อกซ้อน (fn ห้ามเรียก run ซ้ำ) นับงานที่กำลังทำ/รอเพื่อรอให้จบตอน SIGTERM
function createMutex({ maxQueue = 25, maxWaitMs = 15000 } = {}) {
  const queue = []; let held = false, active = 0, idleWaiters = [];
  const busy = () => new ApiError(503, 'BUSY', 'ระบบกำลังประมวลผลคำขออื่น กรุณาลองใหม่ ไม่มีการตัดเงิน (ระบบจำลอง)');
  const acquire = () => new Promise((resolve, reject) => {
    if (!held) { held = true; return resolve(); }
    if (queue.length >= maxQueue) return reject(busy());
    const w = { resolve };
    w.timer = setTimeout(() => { const i = queue.indexOf(w); if (i >= 0) queue.splice(i, 1); reject(busy()); }, maxWaitMs);
    queue.push(w);
  });
  const release = () => { const w = queue.shift(); if (w) { clearTimeout(w.timer); w.resolve(); } else held = false; };
  const settle = () => { if (!held) { const l = idleWaiters; idleWaiters = []; l.forEach(f => f()); } };
  async function run(fn) {
    await acquire();
    active++;
    try { return await fn(); } finally { active--; release(); settle(); }
  }
  // รอให้งานที่กำลังทำ/รออยู่จบ (ไม่เกิน ms) ใช้ตอนปิดระบบ
  const idle = ms => held ? new Promise(r => { const t = setTimeout(r, ms); idleWaiters.push(() => { clearTimeout(t); r(); }); }) : Promise.resolve();
  return { run, idle, stats: () => ({ held, waiting: queue.length, active }) };
}

// คีย์ IP สำหรับจำกัดอัตรา: IPv4 ตามเดิม, IPv4-mapped IPv6 เป็น IPv4, IPv6 ใช้ /64 (ผู้ใช้หนึ่งราย/เครือข่ายถือ /64 ได้ทั้งก้อน หมุนที่อยู่ไม่ช่วยหลบเพดาน) (N-1)
function ipKey(ip) {
  let s = String(ip || '?').trim().toLowerCase().replace(/%.*$/, '');
  const m4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s); if (m4) return m4[1];
  if (!s.includes(':')) return s;
  const parts = s.split('::'); if (parts.length > 2) return s;
  const h = parts[0] ? parts[0].split(':') : [], t = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const g = parts.length === 2 ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  if (g.length !== 8 || g.some(x => !/^[0-9a-f]{1,4}$/.test(x))) return s;
  return g.slice(0, 4).map(x => parseInt(x, 16).toString(16)).join(':') + '::/64';
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function decodeJwt(tok) {
  const p = String(tok).split('.');
  if (p.length !== 3 || p.some(x => !x)) return null;
  try { const o = JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8')); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

// ---- ตรวจ input ----
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const noCtl = s => !/[\u0000-\u001f\u007f<>]/.test(s);
function str(v, name, min, max) {
  if (typeof v !== 'string') throw E.badInput(name + ' ต้องเป็นข้อความ');
  const s = v.trim();
  if (s.length < min || s.length > max) throw E.badInput(name + (min ? ` ต้องยาว ${min}-${max} ตัวอักษร` : ` ยาวได้ไม่เกิน ${max} ตัวอักษร`));
  if (!noCtl(s)) throw E.badInput(name + ' มีอักขระที่ไม่อนุญาต');
  return s;
}
function email(v) {
  const s = str(v, 'อีเมล', 3, 254).toLowerCase();
  if (!EMAIL_RE.test(s)) throw E.badInput('รูปแบบอีเมลไม่ถูกต้อง');
  return s;
}
function password(v) {
  if (typeof v !== 'string' || v.length < 8 || v.length > 64) throw E.badInput('รหัสผ่านต้องยาว 8-64 ตัวอักษร');
  return v;
}
function onlyKeys(o, allowed, name) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw E.badInput(`${name} มีช่องที่ไม่รองรับ: ${k}`);
}
// เลขยาวคล้ายเลขบัตร (N-3): ปรับ NFKC (เลขเต็มความกว้าง) ตัดอักขระความกว้างศูนย์ นับตัวเลขทุกระบบ (Unicode Nd: อารบิก ไทย อารบิกอินดิก ฯลฯ)
//  - ข้อความสั้น (<= 40 ตัวอักษร): ตัวเลขรวม >= 13 ตัว = เลขยาว ไม่ว่าคั่นด้วยอะไร (. _ / , เว้นวรรค ตัวอักษร)
//  - ข้อความยาวกว่านั้น (เช่น reason 100 ตัว): ต้องเป็นสายตัวเลข >= 13 ตัวที่คั่นกันไม่เกินทีละ 2 อักขระ (กันวันที่/เวลาธรรมดาถูกปฏิเสธ)
const longDigits = v => {
  const t = String(v).normalize('NFKC').replace(/[​-‏⁠﻿]/g, '').replace(/\p{Nd}/gu, 'D');
  const n = (t.match(/D/g) || []).length;
  if (n < 13) return false;
  return t.length <= 40 || /D(?:[^D]{0,2}D){12,}/.test(t);
};

// ข้อความอิสระที่ผู้ใช้กรอก (ชื่อ ชื่อรถ ฯลฯ): ห้ามมีเลขยาวคล้ายเลขบัตร (SR-36/37)
function text(v, name, min, max) {
  const s = str(v, name, min, max);
  if (longDigits(s)) throw E.badInput(name + ' มีเลขยาวที่ไม่อนุญาต (ห้ามใส่เลขบัตร)');
  return s;
}
function plate(v) {
  const s = str(v, 'ทะเบียนรถ', 1, 12);
  if (longDigits(s)) throw E.badInput('ทะเบียนรถไม่ถูกต้อง');
  return s;
}
function cars(v) {
  if (!Array.isArray(v) || v.length > 10) throw E.badInput('รถต้องเป็นรายการไม่เกิน 10 คัน');
  return v.map(c => {
    if (!isObj(c)) throw E.badInput('ข้อมูลรถไม่ถูกต้อง');
    onlyKeys(c, ['plate', 'label'], 'รถ');
    const o = { plate: plate(c.plate) };
    if (c.label !== undefined) o.label = text(c.label, 'ชื่อรถ', 0, 30);
    return o;
  });
}
// บัตรเดโม: เก็บได้แค่ label, brand, last4 เท่านั้น
// existingIds: id บัตรที่เก็บอยู่แล้วของผู้ใช้คนนี้ (อ่านสดจาก ThingsBoard) id ที่ไคลเอนต์ส่งมารับเฉพาะที่ตรงกับของเดิม นอกนั้นเซิร์ฟเวอร์สร้างใหม่ (F-2)
const newPayId = taken => { for (;;) { const id = crypto.randomBytes(6).toString('hex'); if (!taken.has(id)) { taken.add(id); return id; } } };
function pays(v, existingIds = []) {
  const known = new Set(existingIds.filter(x => typeof x === 'string' && !longDigits(x))), used = new Set();
  if (!Array.isArray(v) || v.length > 10) throw E.badInput('วิธีชำระเงินต้องเป็นรายการไม่เกิน 10 รายการ');
  return v.map(p => {
    if (!isObj(p)) throw E.badInput('ข้อมูลบัตรไม่ถูกต้อง');
    onlyKeys(p, ['id', 'label', 'brand', 'last4'], 'บัตร (ห้ามส่งเลขบัตรเต็มหรือ CVV)');
    if (typeof p.last4 !== 'string' || !/^\d{4}$/.test(p.last4)) throw E.badInput('last4 ต้องเป็นตัวเลข 4 หลักท้ายเท่านั้น');
    const label = str(p.label, 'ชื่อบัตร', 1, 30), brand = str(p.brand === undefined ? '' : p.brand, 'ยี่ห้อบัตร', 0, 20);
    if (longDigits(label) || longDigits(brand)) throw E.badInput('ห้ามใส่เลขบัตรเต็ม');
    if (p.id !== undefined && typeof p.id !== 'string') throw E.badInput('id ไม่ถูกต้อง');
    const id = typeof p.id === 'string' && known.has(p.id) && !used.has(p.id) ? p.id : newPayId(known);   // id ซ้ำในรายการเดียวกัน = ใบหลังได้ id ใหม่ (ไม่มี id ซ้ำสองใบ)
    used.add(id);
    return { id, label, brand, last4: p.last4 };
  });
}

module.exports = { ipKey, longDigits, ApiError, E, createLimiter, createLockout, createCache, keyedLock, createMutex, sha, decodeJwt, isObj, onlyKeys, v: { str, text, email, password, plate, cars, pays } };
