// M2: สถานะลานจอด (อ่านจาก ThingsBoard อย่างเดียว) + cache + poller ที่ทำงานเฉพาะตอนมีคนเปิด live
// ที่มาของข้อมูล
//   device ParkHere-Lot (+ ParkHere-Sim ถ้าตั้ง; หลายอุปกรณ์ได้) latest telemetry: slot_{f}-{i} (มีรถ), bar_{f}-{i} (1=ลด 0=ยก), hb (ทุก 20 วิ)
//   asset  ParkHere-Data SERVER_SCOPE attributes: config, closed, bk_{f}-{i}
// ไม่เขียนอะไรลง ThingsBoard เลย
const { ApiError, isObj } = require('./lib');

const DEFAULTS = { floors: 3, slots: 6, rate: 20, penalty: 20, bookfee: 20, freemin: 30, noshow: 30 };   // ค่าเดียวกับที่ script.js ใช้ตอนอ่าน config ไม่ได้
const LIMITS = { floors: [1, 10], slots: [1, 60], rate: [0, 100000], penalty: [0, 100000], bookfee: [0, 100000], freemin: [0, 1440], noshow: [0, 1440] };
const OFFLINE_MS = 90000;     // hb เก่ากว่า 90 วิ = ไม่มีสัญญาณ (ตามสัญญา BOARD_API) นับแยกรายอุปกรณ์
const STALE_MS = 10000;       // ข้อมูลจาก ThingsBoard เก่ากว่านี้ = บอกผู้ใช้ว่า stale
const HIDDEN_STATUS = new Set(['cancelled', 'noshow', 'done', 'void']);   // ไม่แสดงบนแผนที่ (การจองที่จบแล้วต้องไม่ค้างเป็น "จองแล้ว")

const truthy = v => v === true || v === 1 || v === '1' || v === 'true';
const slotKeyOk = k => /^\d{1,2}-\d{1,3}$/.test(k);

function parseJson(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return undefined; } }

// config จาก attribute + ค่า default ต่อคีย์ที่ขาด/ผิดรูป
function normalizeConfig(raw) {
  const o = parseJson(raw), src = isObj(o) ? o : {};
  const config = {}, defaulted = [];
  for (const k of Object.keys(DEFAULTS)) {
    const n = src[k], [lo, hi] = LIMITS[k];
    if (typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi) config[k] = n;
    else { config[k] = DEFAULTS[k]; defaulted.push(k); }
  }
  return { config, defaulted, source: defaulted.length === Object.keys(DEFAULTS).length ? 'default' : defaulted.length ? 'partial' : 'tb' };
}

function normalizeClosed(raw) {
  const o = parseJson(raw), out = {};
  if (isObj(o)) for (const [k, v] of Object.entries(o)) if (slotKeyOk(k) && v === true) out[k] = true;
  return out;
}

// bk_{f}-{i}: รับเฉพาะรายการที่รูปร่างถูกต้อง ไม่เชื่อค่าที่อ่านมา (มีข้อมูลส่วนตัว: uid, car)
// รายการ bk_ (ใช้ภายในเซิร์ฟเวอร์) เก็บฟิลด์ที่ API ต้องใช้: arr, amt, pm, rno, rq ด้วย (เฉพาะที่รูปแบบถูกต้อง)
// keepHidden=true ใช้ตอนตัดสินใจจอง/ซ่อม (เห็นทุกสถานะ) ปกติ (แผนที่) ซ่อนสถานะที่จบแล้ว
// ส่งออกให้ผู้ใช้ผ่าน bookingsFor() เท่านั้น ซึ่งเลือกคีย์ตรงตัว (allowlist ไม่ใช้ spread) ห้ามส่งรายการภายในออกไปตรง ๆ
function normalizeBookings(raw, keepHidden = false) {
  const a = parseJson(raw), out = [];
  if (!Array.isArray(a)) return out;
  for (const b of a.slice(0, 200)) {
    if (!isObj(b) || !Number.isFinite(+b.s) || !Number.isFinite(+b.e) || +b.e <= +b.s) continue;
    const status = typeof b.status === 'string' && /^[a-z_]{1,20}$/.test(b.status) ? b.status : 'active';
    if (!keepHidden && HIDDEN_STATUS.has(status)) continue;
    const o = {
      id: typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) ? b.id : '',
      uid: typeof b.uid === 'string' ? b.uid.slice(0, 64) : '',
      car: typeof b.car === 'string' ? b.car.slice(0, 20) : '',
      s: +b.s, e: +b.e, status,
    };
    if (Number.isInteger(b.amt) && b.amt >= 0 && b.amt <= 100000) o.amt = b.amt;
    if (typeof b.pm === 'string' && /^[\w-]{1,40}$/.test(b.pm)) o.pm = b.pm;
    if (typeof b.rno === 'string' && /^PH\d{8}$/.test(b.rno)) o.rno = b.rno;
    if (typeof b.rq === 'string' && /^[0-9a-f]{12}$/.test(b.rq)) o.rq = b.rq;
    if (typeof b.arr === 'number' && Number.isFinite(b.arr) && b.arr > 0) o.arr = b.arr;
    out.push(o);
  }
  return out;
}

function createLot(cfg, tb, now = () => Date.now()) {
  const devices = cfg.devices || [];
  const enabled = devices.length > 0 && !!cfg.assetId;
  // แมปช่อง -> ชื่ออุปกรณ์ (config): cfg.slotMap {'1-1':'lot'} ; ช่องที่ไม่อยู่ในแมป = cfg.slotDefault (ค่าเริ่ม 'sim' ถ้าตั้ง TB_SIM_DEVICE_ID ไม่งั้น 'lot' = โหมดอุปกรณ์เดียวแบบเดิม)
  const slotMap = cfg.slotMap || { '1-1': 'lot' };
  const slotDefault = cfg.slotDefault || (devices.some(d => d.name === 'sim') ? 'sim' : 'lot');
  const deviceFor = k => slotMap[k] || slotDefault;
  const om = cfg.offlineMs || {};
  const offlineFor = d => om[d.name] || om.other || OFFLINE_MS;   // เกณฑ์ไม่มีสัญญาณของอุปกรณ์นั้น (lot 90 วิ / sim 150 วิ)
  // tel[name] = { data, at } ข้อมูลล่าสุดที่อ่านสำเร็จของแต่ละอุปกรณ์
  const tel = {};
  let attrs = null, attrsAt = 0, snap = null, inflight = null, retryAfter = 0, fails = 0, warned = false, lastGoodAt = 0;
  let lastRun = { ok: false, startedAt: 0, attrsFetched: false };   // ผลรอบอ่านล่าสุด (ใช้ตัดสินว่า fresh() ได้ข้อมูลสดครบจริง)
  const warnedConflict = new Set();
  const listeners = new Set(), observers = new Set(), leaveHooks = new Set();
  let timer = null;

  async function fetchTel(d) {
    const r = await tb.admin(`/api/plugins/telemetry/DEVICE/${encodeURIComponent(d.id)}/values/timeseries`);
    if (!r.ok || !isObj(r.data)) throw new ApiError(502, 'UPSTREAM', 'อ่านสถานะบอร์ดไม่สำเร็จ');
    return r.data;
  }
  async function fetchAttrs() {
    const r = await tb.admin(`/api/plugins/telemetry/ASSET/${encodeURIComponent(cfg.assetId)}/values/attributes/SERVER_SCOPE`);
    if (!r.ok || !Array.isArray(r.data)) throw new ApiError(502, 'UPSTREAM', 'อ่านข้อมูลลานจอดไม่สำเร็จ');
    const out = {};
    for (const a of r.data) if (a && typeof a.key === 'string' && (a.key === 'config' || a.key === 'closed' || /^bk_\d{1,2}-\d{1,3}$/.test(a.key))) out[a.key] = a.value;
    return out;
  }

  // telemetry ของหนึ่งอุปกรณ์ -> { occ:{k:bool}, bar:{k:bool}, lastSeen }
  function parseDevice(data) {
    let hbTs = 0, anyTs = 0; const occ = {}, bar = {};
    for (const [key, arr] of Object.entries(data)) {
      const p = Array.isArray(arr) && isObj(arr[0]) ? arr[0] : null;
      if (!p) continue;
      const ts = +p.ts || 0; if (ts > anyTs) anyTs = ts;
      let m;
      if (key === 'hb') hbTs = ts;
      else if ((m = /^slot_(\d{1,2}-\d{1,3})$/.exec(key))) occ[m[1]] = truthy(p.value);
      else if ((m = /^bar_(\d{1,2}-\d{1,3})$/.exec(key))) bar[m[1]] = truthy(p.value);
    }
    return { occ, bar, lastSeen: hbTs || anyTs || null };
  }

  function build() {
    const t = now();
    const { config, defaulted, source: configSource } = normalizeConfig(attrs.config);
    // สถานะรายอุปกรณ์: เวลาล่าสุด = hb (ไม่มี hb ใช้ telemetry ตัวใหม่สุด ตามสัญญา BOARD_API); เก่ากว่าเกณฑ์รายอุปกรณ์ (lot 90 วิ, sim 150 วิ) = offline
    const boards = [], parsed = {};
    for (const d of devices) {
      const p = tel[d.name] ? parseDevice(tel[d.name].data) : null;
      parsed[d.name] = p;
      const lastSeen = p ? p.lastSeen : null, online = !!lastSeen && t - lastSeen < offlineFor(d);
      boards.push({ id: d.name, status: !p ? 'error' : !lastSeen ? 'never' : online ? 'online' : 'offline', online, lastSeen });
    }
    const anyOnline = boards.some(b => b.online);
    const board = {
      status: anyOnline ? 'online' : boards.some(b => b.status === 'offline') ? 'offline' : boards.every(b => b.status === 'error') ? 'error' : 'never',
      online: anyOnline, lastSeen: boards.reduce((m, b) => Math.max(m, b.lastSeen || 0), 0) || null,
    };
    const byName = Object.fromEntries(boards.map(b => [b.id, b]));
    const closed = normalizeClosed(attrs.closed);
    const slots = {}, bookings = {}, bkAll = {};
    for (let f = 1; f <= config.floors; f++) for (let i = 0; i < config.slots; i++) {
      const k = f + '-' + i;
      // เจ้าของช่อง = อุปกรณ์ตามแมป config (deviceFor) เท่านั้น: slot_/bar_ ของคีย์นี้ที่อุปกรณ์อื่นส่งมาถูกตัดทิ้ง (เช่น Lot ส่ง 1-2, 1-5, 1-6)
      // ไม่มีอุปกรณ์เจ้าของใน cfg.devices = source null (ไม่ทราบสถานะ)
      const ownerName = deviceFor(k), source = ownerName && byName[ownerName] ? ownerName : null;
      const conflict = false;                                    // เจ้าของคงที่ตาม config -> ไม่มี conflict ข้ามอุปกรณ์อีก (คงฟิลด์ไว้ให้สัญญาเดิม)
      const p = source && byName[source].online ? parsed[source] : null;   // ออฟไลน์รายอุปกรณ์: ช่องของอุปกรณ์นั้น = null ไม่กระทบอุปกรณ์อื่น
      slots[k] = {
        occ: p && k in p.occ ? p.occ[k] : null,                // ออฟไลน์/ไม่มีค่า/conflict = null ไม่ใช่ "ว่าง"
        barrier: p && k in p.bar ? (p.bar[k] ? 'down' : 'up') : null,
        source, online: source ? !!byName[source].online : null, conflict,
      };
      if (attrs['bk_' + k] !== undefined) {
        const all = normalizeBookings(attrs['bk_' + k], true); if (all.length) bkAll[k] = all;   // bkAll = ทุกสถานะ (ภายในเซิร์ฟเวอร์เท่านั้น)
        const b = all.filter(x => !HIDDEN_STATUS.has(x.status)); if (b.length) bookings[k] = b;
      }
    }
    return { asOf: lastGoodAt, stale: t - lastGoodAt > STALE_MS, board, boards, config, configSource, defaulted, closed, slots, bookings, bkAll };
  }

  function diff(a, b) {
    const ev = [];
    for (const k of Object.keys(b.slots)) {
      const x = a.slots[k], y = b.slots[k];
      if (!x || x.occ !== y.occ || x.barrier !== y.barrier || x.source !== y.source || x.online !== y.online || x.conflict !== y.conflict) ev.push({ type: 'slot', k });
    }
    if (JSON.stringify(a.boards) !== JSON.stringify(b.boards)) ev.push({ type: 'board' });
    if (JSON.stringify(a.closed) !== JSON.stringify(b.closed)) ev.push({ type: 'closed' });
    if (JSON.stringify(a.config) !== JSON.stringify(b.config) || a.configSource !== b.configSource) ev.push({ type: 'config' });
    if (a.stale !== b.stale) ev.push({ type: 'upstream' });
    for (const k of new Set([...Object.keys(a.bookings), ...Object.keys(b.bookings)])) {
      if (JSON.stringify(a.bookings[k] || []) !== JSON.stringify(b.bookings[k] || [])) ev.push({ type: 'bookings', k });
    }
    return ev;
  }

  // ตั้ง snapshot ใหม่ แล้วแจ้งผู้ดู (SSE) เฉพาะส่วนที่เปลี่ยน
  function publish(next) {
    const prev = snap; snap = next;
    // M4 hook รถออก: occ true->false (ค่าจริงทั้งสองฝั่ง ไม่ใช่ null) ขณะไม้กั้นลดอยู่ -> แจ้งผู้ฟัง (ผู้ฟังตัดสินเองว่าจะยกหรือไม่ ที่นี่ไม่ยิง RPC)
    if (prev && leaveHooks.size) for (const k of Object.keys(next.slots)) {
      const x = prev.slots[k], y = next.slots[k];
      if (x && x.occ === true && y.occ === false && y.barrier === 'down' && !y.conflict) for (const fn of [...leaveHooks]) { try { Promise.resolve(fn({ k, source: y.source, snap: next })).catch(e => console.warn('[lot] leave hook error:', e && e.message)); } catch (e) { console.warn('[lot] leave hook error:', e && e.message); } }
    }
    for (const fn of [...observers]) { try { fn(next); } catch (e) { console.warn('[lot] observer error:', e && e.message); } }   // ผู้สังเกต (วงจรชีวิตการจอง) ทำงานทุก snapshot ใหม่ แม้ไม่มีคนเปิด live
    if (prev && listeners.size) { const ev = diff(prev, next); if (ev.length) for (const fn of [...listeners]) { try { fn(ev, next); } catch (e) { console.warn('[lot] listener error:', e && e.message); } } }
  }
  // หลังเราเขียน bk_ สำเร็จ: ใส่ค่าที่เขียนลงสำเนาในหน่วยความจำทันที (ไม่ยิง TB เพิ่ม) แผนที่/SSE จึงเห็นการจองทันที ไม่ต้องรอรอบอ่านถัดไป
  function applyBk(k, list) { if (!attrs) return; attrs['bk_' + k] = list; if (snap) publish(build()); }
  // M5: หลังเราเขียน closed / config สำเร็จ (ใต้ bookings.mutex): ใส่ค่าลงสำเนาในหน่วยความจำทันที -> SSE ส่ง event closed / config ให้ทุกคน
  function applyClosed(obj) { if (!attrs) return; attrs.closed = obj; if (snap) publish(build()); }
  function applyConfig(obj) { if (!attrs) return; attrs.config = obj; if (snap) publish(build()); }

  // อ่าน telemetry ทุกอุปกรณ์ขนานกัน ทุกครั้ง; attributes เมื่อเก่ากว่า lotAttrMs (หรือ force)
  // อุปกรณ์หนึ่งอ่านไม่ได้ = ใช้ของเก่าของมัน (ค่อย ๆ กลายเป็น offline ตามเวลา hb) หรือสถานะ error ถ้ายังไม่เคยอ่านได้ ไม่ทำให้ทั้งลานล้ม
  // ล้มเพราะอ่าน attributes ไม่ได้และไม่มีของเก่า หรือไม่มีอุปกรณ์ไหนอ่านได้เลย = throw
  function refresh(force) {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const t = now();
        const needAttrs = force || !attrs || t - attrsAt >= cfg.lotAttrMs;
        lastRun = { ok: false, startedAt: t, attrsFetched: needAttrs };
        const [attrR, ...telR] = await Promise.allSettled([needAttrs ? fetchAttrs() : Promise.resolve(null), ...devices.map(fetchTel)]);
        let err = null, allOk = attrR.status === 'fulfilled';
        telR.forEach((r, n) => { if (r.status === 'fulfilled') tel[devices[n].name] = { data: r.value, at: now() }; else { allOk = false; err = err || r.reason; } });
        if (attrR.status === 'fulfilled') { if (attrR.value) { attrs = attrR.value; attrsAt = now(); } } else err = err || attrR.reason;
        if (allOk) { lastRun.ok = true; lastGoodAt = now(); fails = 0; retryAfter = 0; if (warned) { warned = false; console.log('[lot] ThingsBoard กลับมาอ่านได้'); } }
        else {
          fails++; retryAfter = now() + Math.min(15000, 1000 * 2 ** Math.min(fails, 4));
          if (!warned) { warned = true; console.warn('[lot] ThingsBoard อ่านไม่ได้บางส่วน/ทั้งหมด:', err && err.message); }
          if (!attrs || !Object.keys(tel).length) throw err instanceof ApiError ? err : new ApiError(502, 'UPSTREAM', 'ระบบหลังบ้านไม่ตอบสนอง ลองใหม่อีกครั้ง');
        }
        publish(build());
      } finally { inflight = null; }
    })();
    return inflight;
  }

  // สถานะปัจจุบัน: ใช้ cache ถ้ายังสด (ขณะมีคนเปิด live = ผลของ poller)
  async function get() {
    if (!enabled) throw new ApiError(503, 'NOT_CONFIGURED', 'ระบบลานจอดยังไม่ได้ตั้งค่า');
    const maxAge = listeners.size ? cfg.lotPollMs * 3 : cfg.lotCacheMs;
    if (snap && now() - lastGoodAt < maxAge) return snap;
    if (snap && now() < retryAfter) { snap = build(); return snap; }   // TB ล้มอยู่: ไม่ยิงซ้ำถี่ ๆ
    await refresh(false);
    return snap;
  }

  // อ่านสดทั้งหมด (attribute ของลาน + telemetry ทุกอุปกรณ์) เพื่อตัดสินใจจอง/เปลี่ยนสถานะ: ห้ามใช้ cache 5 วิ (AC-2)
  // ต่างจาก get(): ถ้าอ่านได้ไม่ครบ (บอร์ดใดล้ม/attribute ล้ม) = throw 502 ไม่ใช้ของเก่า
  async function fresh() {
    if (!enabled) throw new ApiError(503, 'NOT_CONFIGURED', 'ระบบลานจอดยังไม่ได้ตั้งค่า');
    const t0 = now();
    for (let n = 0; n < 3; n++) {
      if (inflight) await inflight.catch(() => {});   // รอรอบที่เริ่มก่อนหน้า (อาจเก่า) จบก่อน แล้วอ่านใหม่
      try { await refresh(true); } catch (e) { if (n === 2) throw e; continue; }
      if (lastRun.ok && lastRun.attrsFetched && lastRun.startedAt >= t0) return snap;
    }
    throw new ApiError(502, 'UPSTREAM', 'ระบบหลังบ้านไม่ตอบสนอง ลองใหม่อีกครั้ง');
  }

  function loop() {
    timer = null;
    if (!listeners.size) return;
    const wait = fails ? Math.max(cfg.lotPollMs, retryAfter - now()) : cfg.lotPollMs;
    refresh(false).catch(() => {}).finally(() => { if (listeners.size && !timer) timer = setTimeout(loop, wait); });
  }
  function subscribe(fn) {
    listeners.add(fn);
    if (!timer && !inflight) timer = setTimeout(loop, cfg.lotPollMs);
    return () => { listeners.delete(fn); if (!listeners.size && timer) { clearTimeout(timer); timer = null; } };
  }

  // มุมมองต่อผู้ใช้: ไม่มี uid/id/car ของคนอื่น
  function bookingsFor(list, uid) {
    return (list || []).map(b => b.uid && b.uid === uid
      ? { id: b.id, car: b.car, s: b.s, e: b.e, status: b.status, mine: true }
      : { s: b.s, e: b.e, status: b.status, mine: false });
  }
  function view(s, uid) {
    const slots = [];
    for (const k of Object.keys(s.slots)) {
      const [f, i] = k.split('-').map(Number), x = s.slots[k];
      slots.push({ k, f, i, occ: x.occ, barrier: x.barrier, source: x.source, online: x.online, conflict: x.conflict, closed: !!s.closed[k], bookings: bookingsFor(s.bookings[k], uid) });
    }
    return { asOf: s.asOf, stale: s.stale, board: s.board, boards: s.boards, config: s.config, configSource: s.configSource, defaulted: s.defaulted, closed: s.closed, slots };
  }
  // API ภายใน (ไม่ผูกกับ HTTP route): การจองที่ใช้งานอยู่ (status active) ของช่อง k จาก snapshot ล่าสุด คืนสำเนา หรือ null
  // มีหลายรายการ = เลือกที่เริ่มเร็วสุด; รายการมี uid/car จึงห้ามส่งออกให้ client ตรงๆ (ใช้ bookingsFor ถ้าต้องส่ง)
  function activeBookingOf(k) {
    if (!snap || typeof k !== 'string' || !slotKeyOk(k)) return null;
    const a = (snap.bkAll[k] || []).filter(b => b.status === 'active').sort((p, q) => p.s - q.s)[0];
    return a ? { ...a } : null;
  }
  const stop = () => { listeners.clear(); if (timer) clearTimeout(timer); timer = null; };

  return { enabled, get, fresh, applyBk, applyClosed, applyConfig, observe: fn => { observers.add(fn); return () => observers.delete(fn); }, activeBookingOf, onCarLeave: fn => { leaveHooks.add(fn); return () => leaveHooks.delete(fn); }, subscribe, view, bookingsFor, stop, listenerCount: () => listeners.size, invalidate: () => { attrsAt = 0; } };
}

module.exports = { createLot, normalizeConfig, normalizeClosed, normalizeBookings, DEFAULTS, LIMITS, OFFLINE_MS };
