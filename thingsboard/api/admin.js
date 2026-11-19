// M5: งานของ staff/master — PUT closed, PUT config, GET รายการจองทั้งหมด
// กฎ: route ใช้ authFresh (ถาม ThingsBoard สด) แล้วที่นี่ตรวจ role ก่อนทำอะไร + ตรวจซ้ำ "ในล็อก" (recheck) ก่อนเขียน
// การเขียน closed/config ใช้ล็อกเดียวกับการจอง/ไม้กั้น (bookings.mutex) กัน "ปิดช่อง" ชน "จอง"
// ยอดเงินไม่คำนวณที่นี่: เก็บค่าตั้งดิบเท่านั้น ยอดทุกที่มาจาก pricing.js; ห้ามรวมรายได้จาก books (books เป็นสำเนา)
const { ApiError, E, isObj, onlyKeys, sha, createCache, v } = require('./lib');
const { LIMITS } = require('./lot');
const { normPlate } = require('./store');

const fail = (status, code, msg) => new ApiError(status, code, msg);
const noPerm = () => fail(403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
const isStaff = r => !!r && (r.role === 'staff' || r.role === 'master');
const KEY_RE = /^[1-9]\d?-(0|[1-9]\d{0,2})$/;           // f-i แบบมาตรฐาน (ไม่มีเลข 0 นำหน้า)
const CONFIG_KEYS = ['rate', 'bookfee', 'freemin', 'floors', 'slots', 'noshow'];   // penalty ไม่ใช้ใน M5
const SET_MAX = 120;
const STATUSES = ['active', 'done', 'noshow', 'cancelled', 'void'];
const LIST_DEFAULT = 100, LIST_MAX = 200;

function createAdmin({ cfg, tb, lot, bookings, now = () => Date.now(), writesEnabled = false, log = console.log }) {
  const mutex = bookings.mutex;
  const masterOnly = !!cfg.configMasterOnly;
  // O1: ใครแก้ config ได้ (ค่าเดียวที่เปลี่ยนเป็น master-only ได้: env CONFIG_MASTER_ONLY=1)
  const canConfig = r => !!r && (r.role === 'master' || (!masterOnly && r.role === 'staff'));
  const line = (kind, me, result) => { try { log(`[admin] ${new Date(now()).toISOString()} ${kind} ${me && me.role} u=${me && me.uid ? sha(String(me.uid)).slice(0, 8) : '?'} ${result}`); } catch { /* log พังไม่กระทบงาน */ } };
  const guardWrites = () => { if (!writesEnabled) throw fail(503, 'WRITES_DISABLED', 'ระบบยังไม่เปิดให้แก้ค่าตั้ง'); };
  const writeRead = async fn => { try { return await fn(); } catch (e) { throw e instanceof ApiError && e.status === 502 ? upstream() : e; } };
  const upstream = () => fail(502, 'UPSTREAM', 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง (ส่งซ้ำได้ ผลไม่เพี้ยน)');
  const writeAsset = async obj => { try { await tb.writeAssetAttrs(obj); } catch (e) { lot.invalidate(); throw e instanceof ApiError && e.status === 502 ? upstream() : e; } };

  // รัน fn พร้อม log ผล (ทั้งสำเร็จและถูกปฏิเสธ)
  async function logged(kind, me, fn) {
    try { const r = await fn(); line(kind, me, r.body.noop ? 'noop' : 'ok'); delete r.body.noop; return r; }
    catch (e) { if (isStaff(me)) line(kind, me, 'rejected:' + ((e && e.code) || 'unknown')); throw e; }
  }

  const inRange = (closed, c) => Object.fromEntries(Object.keys(closed).filter(k => { const [f, i] = k.split('-').map(Number); return f <= c.floors && i < c.slots; }).map(k => [k, true]));

  // ---------- PUT /api/admin/closed ----------
  function parseClosed(body) {
    if (!isObj(body)) throw E.badInput('ต้องส่งข้อมูลเป็น JSON');
    onlyKeys(body, ['set'], 'ปิด/เปิดช่อง');
    const s = body.set;
    if (!isObj(s)) throw E.badInput('set ต้องเป็นรายการช่อง เช่น {"1-2": true}');
    const keys = Object.keys(s);
    if (!keys.length) throw E.badInput('ต้องระบุช่องอย่างน้อย 1 ช่อง');
    if (keys.length > SET_MAX) throw E.badInput(`ระบุช่องได้ไม่เกิน ${SET_MAX} ช่องต่อครั้ง`);
    for (const k of keys) {
      if (!KEY_RE.test(k)) throw E.badInput('รหัสช่องไม่ถูกต้อง (รูปแบบ ชั้น-ลำดับ เช่น 1-2)');
      if (typeof s[k] !== 'boolean') throw E.badInput('ค่าของแต่ละช่องต้องเป็น true (ปิด) หรือ false (เปิด)');
    }
    return Object.fromEntries(keys.map(k => [k, s[k]]));
  }
  async function setClosedRun(me, body, recheck) {
    if (!isStaff(me)) throw noPerm();   // ก่อนค้นข้อมูล/ตรวจเนื้อหา
    guardWrites();
    const set = parseClosed(body);
    return { status: 200, body: await mutex.run(async () => {
      if (recheck) { const r2 = await recheck(); if (!isStaff(r2)) throw noPerm(); }
      const snap = await lot.fresh(), c = snap.config;
      for (const k of Object.keys(set)) { const [f, i] = k.split('-').map(Number); if (f > c.floors || i >= c.slots) throw fail(404, 'NO_SLOT', 'ไม่พบช่องจอดนี้'); }
      const next = inRange(snap.closed, c);   // ตัดคีย์นอกช่วงทิ้งทุกครั้งที่เขียน (ไม่ให้กลับมาปิดเองเมื่อขยายลาน)
      for (const [k, closed] of Object.entries(set)) { if (closed) next[k] = true; else delete next[k]; }
      const changed = JSON.stringify(Object.keys(next).sort()) !== JSON.stringify(Object.keys(snap.closed).sort());   // snap.closed ที่มีคีย์นอกช่วง = เปลี่ยน (ตัดทิ้ง)
      if (changed) { await writeAsset({ closed: next }); lot.applyClosed(next); }
      return { serverNow: now(), closed: next, noop: !changed };
    }) };
  }
  const setClosed = (me, body, recheck) => logged('closed', me, () => setClosedRun(me, body, recheck));

  // ---------- PUT /api/admin/config ----------
  function parseConfig(body) {
    if (!isObj(body)) throw E.badInput('ต้องส่งข้อมูลเป็น JSON');
    onlyKeys(body, CONFIG_KEYS, 'ค่าตั้งลานจอด');
    const keys = Object.keys(body);
    if (!keys.length) throw E.badInput('ต้องระบุค่าที่จะแก้อย่างน้อย 1 ค่า');
    const out = {};
    for (const k of keys) {
      const n = body[k], [lo, hi] = LIMITS[k], min = k === 'rate' ? Math.max(1, lo) : lo;   // rate=0 ห้าม: pricing.js ตีความ 0 เป็น 20 ตัวเลขจะไม่ตรงกับที่คิดจริง
      if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > hi) throw E.badInput(`${k} ต้องเป็นจำนวนเต็มระหว่าง ${min} ถึง ${hi}`);
      out[k] = n;
    }
    return out;
  }
  async function setConfigRun(me, body, recheck) {
    if (!isStaff(me)) throw noPerm();
    if (!canConfig(me)) throw noPerm();
    guardWrites();
    const patch = parseConfig(body);
    return { status: 200, body: await mutex.run(async () => {
      if (recheck) { const r2 = await recheck(); if (!canConfig(r2)) throw noPerm(); }
      const snap = await lot.fresh(), cur = snap.config;
      // config เดิมต้องอ่านออก: ไม่มีคีย์เลย = เริ่มจากค่าเริ่มต้นได้, มีแต่ไม่ใช่อ็อบเจกต์ (สตริงเสีย ฯลฯ) = ปฏิเสธ ห้ามเขียนทับ (ไม่รู้ว่าของเดิมคืออะไร)
      let raw = (await writeRead(() => tb.readAssetAttrs(['config']))).config;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
      if (raw !== undefined && !isObj(raw)) throw fail(409, 'CONFIG_UNREADABLE', 'ค่าตั้งเดิมอ่านไม่ออก จึงไม่เขียนทับ ให้ผู้ดูแลระบบตรวจค่า config ใน ThingsBoard');
      const next = { ...(isObj(raw) ? raw : {}), ...cur, ...patch };   // เขียนครบ 7 คีย์ทุกครั้ง (penalty ไม่หาย) คีย์แปลกที่ไม่รู้จักคงไว้
      // ลดชั้น/ช่องที่มีการจอง active อยู่ในส่วนที่จะหาย = ปฏิเสธ (ต้องยกเลิกก่อน) นับจาก bk_ ที่อ่านสด
      if (next.floors < cur.floors || next.slots < cur.slots) {
        let n = 0;
        for (const [k, list] of Object.entries(snap.bkAll)) { const [f, i] = k.split('-').map(Number); if (f > next.floors || i >= next.slots) n += list.filter(b => b.status === 'active').length; }
        if (n) throw fail(409, 'CONFIG_HAS_BOOKINGS', `ลดขนาดลานจอดไม่ได้ ยังมีการจองที่ใช้งานอยู่ ${n} รายการในส่วนที่จะหายไป ยกเลิกก่อน`);
      }
      const changed = CONFIG_KEYS.some(k => next[k] !== cur[k]) || snap.configSource !== 'tb' || JSON.stringify(raw) !== JSON.stringify(next);   // ค่าเดิมครบและถูกต้องอยู่แล้ว = ไม่เขียน (ทำซ้ำได้)
      if (changed) { await writeAsset({ config: next }); lot.applyConfig(next); }
      // ลดขนาดแล้วตัด closed นอกช่วง (best effort หลังเขียน config: ล้ม = เหลือคีย์กำพร้าที่ไม่มีผล ถูกตัดตอนเขียน closed ครั้งหน้า)
      if (next.floors < cur.floors || next.slots < cur.slots) {
        const cl = inRange(snap.closed, next);
        if (Object.keys(cl).length !== Object.keys(snap.closed).length) { try { await tb.writeAssetAttrs({ closed: cl }); lot.applyClosed(cl); } catch { lot.invalidate(); } }
      }
      return { serverNow: now(), config: next, noop: !changed };
    }) };
  }
  const setConfig = (me, body, recheck) => logged('config', me, () => setConfigRun(me, body, recheck));

  // ---------- GET /api/admin/bookings ----------
  function parseQuery(url) {
    let u; try { u = new URL(url || '/', 'http://x'); } catch { throw E.badInput('คำค้นไม่ถูกต้อง'); }
    const q = {};
    for (const k of new Set(u.searchParams.keys())) {
      if (!['status', 'f', 'q', 'limit'].includes(k)) throw E.badInput('คำค้นมีช่องที่ไม่รองรับ: ' + k.slice(0, 20));
      const all = u.searchParams.getAll(k); if (all.length !== 1) throw E.badInput(`${k} ส่งซ้ำไม่ได้`);
      q[k] = all[0];
    }
    const out = { limit: LIST_DEFAULT };
    if (q.status !== undefined) { if (!STATUSES.includes(q.status)) throw E.badInput('status ไม่ถูกต้อง'); out.status = q.status; }
    if (q.f !== undefined) { if (!/^\d{1,2}$/.test(q.f) || +q.f < 1) throw E.badInput('f ต้องเป็นเลขชั้น'); out.f = +q.f; }
    if (q.limit !== undefined) { if (!/^\d{1,3}$/.test(q.limit) || +q.limit < 1 || +q.limit > LIST_MAX) throw E.badInput(`limit ต้องเป็นเลข 1-${LIST_MAX}`); out.limit = +q.limit; }
    if (q.q !== undefined) { out.q = v.str(q.q, 'คำค้น', 1, 30).trim(); if (!out.q) throw E.badInput('คำค้นว่าง'); }
    return out;
  }

  // รายชื่อผู้ใช้ในแอป (customer Members + Staff) ไว้รู้ว่าต้องอ่าน books ของใคร
  async function appUsers() {
    const ids = [cfg.customerMembersId, cfg.customerStaffId].filter(Boolean), users = new Map();
    for (const cid of ids) for (const u of await tb.listCustomerUsers(cid)) users.set(u.uid, u.name);
    return users;
  }
  async function build() {
    const snap = await lot.fresh();   // อ่านสดครบ (attribute + telemetry) ไม่ได้ = throw 502 ไม่ตอบรายการว่างเงียบๆ
    const users = await appUsers();
    const active = new Map();   // id -> { k, e }  ตัวจริงจาก bk_
    for (const [k, list] of Object.entries(snap.bkAll)) for (const b of list) if (b.status === 'active' && b.id) { active.set(b.id, { k, e: b }); if (b.uid && !users.has(b.uid)) users.set(b.uid, ''); }
    const uids = [...users.keys()];
    const booksOf = await Promise.all(uids.map(async uid => ({ uid, list: await bookings.store.readBooks(uid) })));   // อ่านไม่ได้ = throw 502
    const rows = new Map(), seenActive = new Set();
    const put = r => { if (!rows.has(r.id)) rows.set(r.id, r); };
    const pick = (o, name, extra) => { const r = { id: o.id, f: o.f, i: o.i, car: o.car, s: o.s, e: o.e, status: o.status, amt: o.amt === undefined ? 0 : o.amt, ownerName: name }; for (const k of ['park', 'out', 'by', 'reason']) if (o[k] !== undefined) r[k] = o[k]; if (extra) r.stale = true; return r; };
    for (const { uid, list } of booksOf) {
      const name = users.get(uid) || '';
      for (const b of list) {
        const a = active.get(b.id);
        if (a) {   // bk_ ชนะ books: ถ้า books ล้าหลัง (ไม่ใช่ active) ใส่ stale
          const [f, i] = a.k.split('-').map(Number);
          if (a.e.uid === uid) { seenActive.add(b.id); put(pick({ ...a.e, f, i }, name, b.status !== 'active')); }
        } else if (b.status === 'active') put(pick({ ...b, status: 'void' }, name, true));   // books บอก active แต่ bk_ ไม่มี: ถือ bk_ (ไม่ใช่รายการใช้งานจริง)
        else put(pick(b, name, false));
      }
    }
    for (const [id, a] of active) {   // bk_ active ที่ books ไม่มี (books ล้าหลัง)
      if (seenActive.has(id)) continue;
      const [f, i] = a.k.split('-').map(Number);
      put(pick({ ...a.e, f, i }, users.get(a.e.uid) || '', true));
    }
    const all = [...rows.values()].sort((x, y) => y.s - x.s || (x.id < y.id ? 1 : -1));
    return { all, asOf: snap.asOf, builtAt: now() };
  }
  let cache = null, inflight = null, gen = 0;
  bookings.onUserChange(() => { gen++; cache = null; });   // มีการเปลี่ยน books (จอง/ยกเลิก/จบ) = รายการเก่าทิ้ง
  async function snapshotAll() {
    if (cache && now() - cache.builtAt < cfg.adminListCacheMs) return cache;
    if (inflight) return inflight;
    const g = gen;
    inflight = build().then(r => { if (g === gen) cache = r; return r; }).finally(() => { inflight = null; });
    return inflight;
  }
  async function list(me, url) {
    if (!isStaff(me)) throw noPerm();   // role ก่อนค้นข้อมูล
    const q = parseQuery(url);
    let r;
    try { r = await snapshotAll(); } catch (e) { throw e instanceof ApiError ? e : fail(502, 'UPSTREAM', 'อ่านรายการจองไม่สำเร็จ ลองใหม่อีกครั้ง'); }
    const nq = q.q ? normPlate(q.q) : '', lq = q.q ? q.q.toLowerCase() : '';
    const rows = r.all.filter(x => (!q.status || x.status === q.status) && (!q.f || x.f === q.f)
      && (!q.q || (nq && normPlate(x.car).includes(nq)) || x.ownerName.toLowerCase().includes(lq)));
    const out = rows.slice(0, q.limit);
    return { status: 200, body: { serverNow: now(), asOf: r.asOf, total: rows.length, truncated: rows.length > out.length, staleCount: out.filter(x => x.stale).length, bookings: out } };
  }

  return { setClosed, setConfig, list, canConfig };
}
module.exports = { createAdmin };
