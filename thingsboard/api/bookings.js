// M3: การจอง + วงจรชีวิต (มาถึง / no-show / ออก) + leave + ผู้ดูแลยกเลิก + ตัวซ่อม + รายการของฉัน
// ลำดับตรวจของ POST /api/bookings ตาม M3-plan ข้อ 9 (ล็อกแล้ว): WRITES_DISABLED -> BAD_INPUT -> CAR_UNKNOWN/PAY_UNKNOWN -> NO_SLOT -> reqId -> ล็อก(BUSY)
//   -> อ่านสด -> SLOT_TAKEN -> SLOT_CLOSED -> SLOT_CONFLICT -> SLOT_UNKNOWN -> SLOT_OCCUPIED -> CAR_BOOKED -> LIMIT -> เขียน (502 UPSTREAM)
// ลำดับเขียน (M3-data 4.1/4.2): จอง = bk_ + อ่านกลับ -> books -> อ่าน bk_ ซ้ำ · มาถึง = bk_ ใส่ arr -> books · จบ/no-show/ยกเลิก = books -> bk_ = []
// ทุกการเปลี่ยนแปลงทำใต้ล็อกเดียว (ไม่มีล็อกซ้อน) และอ่านสดซ้ำก่อนเขียนทุกครั้ง ตัดสินจาก bk_ (asset) ไม่เชื่อ books (user attribute)
const { ApiError, E, isObj, onlyKeys, createCache, createMutex, longDigits, v } = require('./lib');
const S = require('./store');
const { createStore, normPlate, upsertBook, publicBooking, visibleBooks, receiptsOf, receiptsFrom, newBookingId, newReceiptNo, rqOf } = S;
const P = require('./pricing');

const DAY = 86400000, HOLD_MS = 30 * DAY;      // e = s + 30 วัน (ไม่มีเวลาสิ้นสุดจริง)
const MAX_ACTIVE_PER_USER = 3;
const LEAVE_AFTER_FALSE_MS = 15000;           // occ:false ต่อเนื่องเท่านี้ที่เซิร์ฟเวอร์เห็น = รถออก
const ORPHAN_AGE_MS = 120000;                 // อายุขั้นต่ำก่อนตัวซ่อมแตะรายการที่ดูกำพร้า (กันชนกับคำขอที่กำลังทำงาน)
const RECON_EVERY_MS = 60000;                 // ตรวจความสอดคล้องรายการเดิมไม่ถี่กว่านี้
const REQ_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PAY_RE = /^[\w-]{1,40}$/;
const ID_RE = /^[\w-]{1,64}$/;
const NOT_CHARGED = ' ไม่มีการตัดเงิน (ระบบจำลอง)';

const fail = (status, code, msg) => new ApiError(status, code, msg);
const upstream = () => fail(502, 'UPSTREAM', 'จองไม่สำเร็จ' + NOT_CHARGED + ' ลองใหม่อีกครั้ง');
const notFound = () => fail(404, 'NOT_FOUND', 'ไม่พบรายการจองนี้');

function parseCreate(body) {
  if (!isObj(body)) throw E.badInput('ต้องส่งข้อมูลเป็น JSON');
  onlyKeys(body, ['f', 'i', 'car', 'pm', 'reqId'], 'การจอง');
  const { f, i, car, pm, reqId } = body;
  if (!Number.isInteger(f) || f < 1 || f > 99) throw E.badInput('ชั้น (f) ต้องเป็นจำนวนเต็ม');
  if (!Number.isInteger(i) || i < 0 || i > 999) throw E.badInput('ช่อง (i) ต้องเป็นจำนวนเต็ม');
  const plate = v.plate(car);
  if (typeof pm !== 'string' || !PAY_RE.test(pm) || longDigits(pm)) throw E.badInput('วิธีชำระเงินไม่ถูกต้อง');
  if (typeof reqId !== 'string' || !REQ_RE.test(reqId)) throw E.badInput('reqId ต้องเป็น A-Z a-z 0-9 _ - ยาว 8-64 ตัวอักษร');
  return { f, i, plate, pm, reqId };
}
const checkId = id => { if (typeof id !== 'string' || !ID_RE.test(id)) throw E.badInput('รหัสการจองไม่ถูกต้อง'); return id; };
const noBody = b => { if (b !== undefined && !(isObj(b) && !Object.keys(b).length)) throw E.badInput('คำขอนี้ไม่รับข้อมูลใน body'); };
function parseReason(b) {
  if (b === undefined) return 'ผู้ดูแลยกเลิก';
  if (!isObj(b)) throw E.badInput('ต้องส่งข้อมูลเป็น JSON');
  onlyKeys(b, ['reason'], 'ยกเลิกการจอง');
  if (b.reason === undefined) return 'ผู้ดูแลยกเลิก';
  const r = v.str(b.reason, 'เหตุผล', 0, 100);
  if (longDigits(r)) throw E.badInput('เหตุผลมีเลขยาวที่ไม่อนุญาต');
  return r || 'ผู้ดูแลยกเลิก';
}

// ตัดสินการเปลี่ยนสถานะของรายการ active หนึ่งรายการจากสถานะช่อง (ฟังก์ชันล้วน ไม่มีผลข้างเคียง)
// occ:null (บอร์ดหลุด/ขัดแย้ง/ไม่รู้) ไม่ใช่ตัวตัดสินเด็ดขาด: ไม่ตีเป็น no-show/ออก
function decide(b, slot, snap, t, falseSince) {
  if (!slot || snap.stale || slot.occ === null || slot.conflict) return null;
  if (!b.arr) {
    if (slot.occ === true) return { kind: 'arrive', at: t };
    if (t - b.s >= snap.config.noshow * 60000) return { kind: 'noshow', out: t };   // ที่ 29:59.999 ยังไม่ใช่ ที่ 30:00.000 ใช่
    return null;
  }
  if (slot.occ === false && falseSince !== undefined && t - falseSince >= LEAVE_AFTER_FALSE_MS) return { kind: 'done', out: falseSince };
  return null;
}

function createBookings({ cfg, tb, lot, now = () => Date.now(), writesEnabled = false }) {
  const store = createStore(cfg, tb);
  const mutex = createMutex({ maxQueue: cfg.bookQueueMax, maxWaitMs: cfg.bookLockWaitMs });
  const reqs = createCache(10 * 60000, 2000, now);   // "uid:reqId" -> { sig, p }  ผูก uid (SR-26) 10 นาที LRU <= 2000
  const pendingRq = new Map();                        // rq -> จำนวนคำขอที่กำลังทำ (ตัวซ่อมไม่ปล่อย bk_ ของคำขอที่ยังรออยู่)
  const idIndex = new Map();                          // bookingId -> { uid } (ให้ผู้ดูแลค้นด้วย id; หายเมื่อรีสตาร์ต)
  const falseSince = new Map();                       // bookingId -> เวลาที่เซิร์ฟเวอร์เห็น occ:false ครั้งแรกของช่วงต่อเนื่อง
  const reconTried = new Map();
  const userListeners = [];
  const bootAt = now();

  const guardWrites = () => { if (!writesEnabled) throw fail(503, 'WRITES_DISABLED', 'ระบบจองยังไม่เปิดใช้งาน' + NOT_CHARGED); };
  // ความล้มเหลวจากฝั่ง ThingsBoard = 502 ข้อความ "ไม่มีการตัดเงิน"; รหัสของเรา (4xx/503) ผ่านตามเดิม
  const wrap = async (fn, mk = upstream) => { try { return await fn(); } catch (e) { throw e instanceof ApiError && e.status === 502 ? mk() : e; } };
  const emit = (uid, books) => { for (const fn of userListeners) { try { fn(uid, books); } catch { /* ผู้ฟังพัง ไม่กระทบการจอง */ } } };
  const remember = (id, uid) => { idIndex.delete(id); idIndex.set(id, { uid }); if (idIndex.size > 5000) idIndex.delete(idIndex.keys().next().value); };
  const logErr = where => e => console.warn(`[life] ${where} ล้มเหลว: ${e && e.code ? e.code : 'error'}`);

  const replayBody = (b, serverNow) => ({ serverNow, booking: publicBooking(b), receipt: receiptsOf(b).find(r => r.kind === 'book') || null });
  const resultBody = (b, kind) => ({ serverNow: now(), booking: publicBooking(b), receipt: receiptsOf(b).find(r => r.kind === kind) || null });
  const fromBk = (e, f, i) => { const o = { id: e.id, f, i, car: e.car, s: e.s, e: e.e, status: 'active', amt: e.amt === undefined ? 0 : e.amt, pm: e.pm || 'pp', rno: e.rno || newReceiptNo() }; if (e.rq) o.rq = e.rq; if (e.arr !== undefined) o.arr = e.arr; return o; };

  // ---------- การเขียนที่ใช้ร่วมกัน (เรียกใต้ล็อกเท่านั้น) ----------
  async function clearBk(f, i, id) {
    const cur = await store.readBk(f, i), rest = cur.filter(b => b.id !== id);
    if (rest.length !== cur.length) { await store.writeBk(f, i, rest); lot.applyBk(f + '-' + i, rest); }
  }
  // จบรายการ: books (สถานะปลายทาง) -> bk_ = []  ทำซ้ำได้  e = รายการ bk_ (ตัวจริง ไม่เชื่อ books)
  async function doEnd(uid, e, f, i, patch) {
    const books = await store.readBooks(uid);
    const entry = { ...fromBk(e, f, i), ...patch };
    const list = upsertBook(books, entry);
    await store.writeBooks(uid, list);
    await clearBk(f, i, e.id);
    emit(uid, list);
    return entry;
  }
  async function doArrive(uid, e, f, i, at) {
    const cur = await store.readBk(f, i), mine = cur.find(b => b.id === e.id && b.status === 'active');
    if (!mine || mine.arr) return;
    const next = cur.map(b => (b.id === e.id ? { ...b, arr: at } : b));
    await store.writeBk(f, i, next); lot.applyBk(f + '-' + i, next);
    const books = await store.readBooks(uid), b = books.find(x => x.id === e.id);
    const entry = b ? { ...b, arr: at } : { ...fromBk(mine, f, i), arr: at };
    const list = upsertBook(books, entry);
    await store.writeBooks(uid, list); emit(uid, list);
  }

  // ---------- ตัวซ่อม (R1 R2 R4; R3 อยู่ใน repairBooks) ----------
  async function reconcileEntry(E, f, i) {
    const age = now() - E.s;
    let books;
    try { books = await store.readBooks(E.uid); } catch { return 'kept'; }   // อ่านไม่ได้ = ไม่ตัดสินใจ
    const b = books.find(x => x.id === E.id);
    if (!b) {
      if (E.arr) { const list = upsertBook(books, fromBk(E, f, i)); await store.writeBooks(E.uid, list); emit(E.uid, list); return 'fixed'; }   // ข้อ 31(ก): มี arr = สร้างสำเนาใหม่ ไม่ปล่อย
      if (age <= ORPHAN_AGE_MS || pendingRq.has(E.rq)) return 'kept';
      if (cfg.bookReconDelayMs > 0) await new Promise(r => setTimeout(r, cfg.bookReconDelayMs));
      let again; try { again = await store.readBooks(E.uid); } catch { return 'kept'; }
      if (again.some(x => x.id === E.id)) return 'kept';
      await clearBk(f, i, E.id); return 'released';                       // R1
    }
    if (b.status !== 'active') {
      // R2: books (user attribute) บอกว่าจบแล้ว แต่ bk_ ค้าง. ถ้ารถมาถึงแล้ว (arr) ห้ามเชื่อ books: ผู้ใช้ปลอมสถานะเพื่อหลบค่าจอดได้ (F-3)
      // -> ทำเหมือน R1 คือสร้างสำเนา active จาก bk_ ให้ leave/sweep จบด้วยค่าจอดที่เซิร์ฟเวอร์คำนวณ (ถ้าเป็นเศษจากการล้มกลางทางจริง จะจบซ้ำด้วยผลที่เซิร์ฟเวอร์คิดเอง)
      if (E.arr) { const list = upsertBook(books, fromBk(E, f, i)); await store.writeBooks(E.uid, list); emit(E.uid, list); return 'fixed'; }
      await clearBk(f, i, E.id); return 'released';
    }
    if (E.arr && b.arr !== E.arr) { const list = upsertBook(books, { ...b, arr: E.arr }); await store.writeBooks(E.uid, list); emit(E.uid, list); return 'fixed'; }   // R4
    return 'kept';
  }
  // R3: books ของผู้ใช้เป็น active แต่ bk_ ไม่มี id นั้น (และอายุเกินกำหนด) = void
  async function repairBooks(uid, books, snap) {
    const orphan = (b, sn) => b.status === 'active' && now() - b.s > ORPHAN_AGE_MS && !(sn.bkAll[b.f + '-' + b.i] || []).some(x => x.id === b.id);
    if (!writesEnabled || !books.some(b => orphan(b, snap))) return books;
    try {
      return await mutex.run(async () => {
        const sn = await lot.fresh(), bs = await store.readBooks(uid); let list = bs, changed = false;
        for (const b of bs) if (orphan(b, sn)) { list = upsertBook(list, { ...b, status: 'void', out: Math.max(now(), b.s) }); changed = true; }
        if (changed) { await store.writeBooks(uid, list); emit(uid, list); }
        return list;
      });
    } catch { return books; }
  }

  // ---------- วงจรชีวิต ----------
  function track(snap) {
    const t = now(), live = new Set();
    for (const [k, list] of Object.entries(snap.bkAll || {})) for (const b of list) {
      if (b.id) { remember(b.id, b.uid); live.add(b.id); }
      if (b.status !== 'active') continue;
      const slot = snap.slots[k];
      if (b.arr && slot && slot.occ === false && !snap.stale) { if (!falseSince.has(b.id)) falseSince.set(b.id, t); }
      else falseSince.delete(b.id);   // true/null คั่นกลางรีเซ็ตตัวนับ
    }
    for (const id of [...falseSince.keys()]) if (!live.has(id)) falseSince.delete(id);
  }
  function scan(snap, only) {
    const t = now(), out = [];
    for (const [k, list] of Object.entries(snap.bkAll || {})) for (const b of list) {
      if (b.status !== 'active' || (only && b.uid !== only)) continue;
      const d = decide(b, snap.slots[k], snap, t, falseSince.get(b.id));
      if (d) out.push({ ...d, k, entry: b });
      else if (t - b.s > ORPHAN_AGE_MS && t - (reconTried.get(b.id) || 0) >= RECON_EVERY_MS) out.push({ kind: 'reconcile', k, entry: b });
    }
    return out;
  }
  // ทำทีละรายการใต้ล็อก: อ่านสดซ้ำ ตัดสินซ้ำ แล้วเขียน (ถ้าเงื่อนไขหายไปแล้ว = ข้าม)
  async function apply(c) {
    const [f, i] = c.k.split('-').map(Number), id = c.entry.id;
    const snap = await lot.fresh(); track(snap);
    const cur = (snap.bkAll[c.k] || []).find(b => b.id === id && b.status === 'active'); if (!cur) return;
    if (c.kind === 'reconcile') { reconTried.set(id, now()); await reconcileEntry(cur, f, i); return; }
    const d = decide(cur, snap.slots[c.k], snap, now(), falseSince.get(id));
    if (!d || d.kind !== c.kind) return;
    if (d.kind === 'arrive') return doArrive(cur.uid, cur, f, i, c.at <= now() ? c.at : now());
    if (d.kind === 'noshow') { await doEnd(cur.uid, cur, f, i, { status: 'noshow', out: Math.max(d.out, cur.s) }); return; }
    const out = Math.max(d.out, cur.s);
    await doEnd(cur.uid, cur, f, i, { status: 'done', out, min: P.parkMinutes(cur.s, out), park: P.parkFee(snap.config, cur.s, out) });
  }
  const canWrite = () => writesEnabled && now() - bootAt >= cfg.bookSweepDelayMs;   // หลังเริ่มระบบรอก่อนเขียนอัตโนมัติ (SR-42)
  let running = false, pendingSnap = null;
  async function sweep(snap) {
    if (running) { pendingSnap = snap; return; }
    running = true;
    try {
      for (let n = 0; n < 3 && snap; n++) {
        pendingSnap = null;
        for (const c of scan(snap)) await mutex.run(() => apply(c)).catch(logErr('sweep'));
        snap = pendingSnap;
      }
    } finally { running = false; }
  }
  const stopObserve = lot.observe(snap => { track(snap); if (canWrite()) sweep(snap).catch(logErr('sweep')); });
  async function lazyFor(uid) {   // ก่อนตอบรายการของผู้ใช้: ประเมินรายการของเขาเอง (รอให้เสร็จ)
    if (!canWrite()) return;
    try { const snap = await lot.get(); track(snap); for (const c of scan(snap, uid)) await mutex.run(() => apply(c)).catch(logErr('lazy')); } catch { /* อ่านไม่ได้ก็ตอบตามที่มี */ }
  }

  // ---------- จอง ----------
  async function writeUnderLock(me, p, rq, car) {
    const snap = await lot.fresh();
    const k = p.f + '-' + p.i, bkAll = snap.bkAll || {};
    const books = await store.readBooks(me.uid);

    // ซ้ำ reqId หลังรีสตาร์ต/แคชหาย: ตอบผลเดิมจาก books (หรือเติมให้ครบถ้าเขียนครึ่งทาง) ก่อนตรวจช่อง
    const done = books.find(b => b.rq === rq && b.status !== 'void');
    if (done) {
      if (done.f !== p.f || done.i !== p.i || normPlate(done.car) !== normPlate(car.plate) || done.pm !== p.pm) throw fail(409, 'REQ_REUSED', 'คำขอซ้ำไม่ตรงกับครั้งก่อน กรุณาลองใหม่');
      return { replay: true, body: replayBody(done, now()) };
    }
    for (const [key, list] of Object.entries(bkAll)) {
      const half = list.find(b => b.uid === me.uid && b.rq === rq && b.status === 'active');
      if (!half) continue;
      const [hf, hi] = key.split('-').map(Number);
      if (hf !== p.f || hi !== p.i || normPlate(half.car) !== normPlate(car.plate) || half.pm !== p.pm) throw fail(409, 'REQ_REUSED', 'คำขอซ้ำไม่ตรงกับครั้งก่อน กรุณาลองใหม่');
      const entry = fromBk(half, hf, hi);
      const list2 = upsertBook(books, entry);
      await store.writeBooks(me.uid, list2); emit(me.uid, list2);   // เติมให้ครบ (ทำซ้ำได้)
      return { replay: true, body: replayBody(entry, now()) };
    }

    // ตรวจช่อง: ความแน่นอนมาก่อนความไม่แน่นอน (SLOT_TAKEN ก่อน UNKNOWN)
    const slot = snap.slots[k]; let active = (bkAll[k] || []).filter(b => b.status === 'active');
    if (active.length) {   // ตัวซ่อม R1/R2: ถ้ารายการเดิมกำพร้า/จบแล้ว ปล่อยแล้วทำต่อ ไม่งั้นช่องค้างเพราะเขียนครึ่งทาง
      const r = await reconcileEntry(active[0], p.f, p.i);
      if (r === 'released') active = [];
    }
    if (active.length) throw fail(409, 'SLOT_TAKEN', 'ช่องนี้ถูกจองไปแล้ว');
    if (snap.closed[k]) throw fail(409, 'SLOT_CLOSED', 'ช่องนี้ปิดใช้งาน');
    if (!slot) throw fail(404, 'NO_SLOT', 'ไม่พบช่องจอดนี้');
    if (slot.conflict) throw fail(409, 'SLOT_CONFLICT', 'ข้อมูลช่องนี้ขัดแย้งกัน จองไม่ได้ชั่วคราว');
    if (slot.occ === null || snap.stale) throw fail(409, 'SLOT_UNKNOWN', 'ไม่ทราบสถานะช่องนี้ (บอร์ดไม่ส่งสัญญาณ) จองไม่ได้ชั่วคราว');
    if (slot.occ === true) throw fail(409, 'SLOT_OCCUPIED', 'มีรถจอดอยู่ในช่องนี้แล้ว');

    // เพดานนับเฉพาะการจองของผู้ใช้คนนี้ จาก bk_ ที่อ่านสด (ปลอมผ่าน books ไม่ได้) ไม่บอกอะไรเกี่ยวกับการจองของคนอื่น (ข้อ 18)
    const mine = Object.values(bkAll).flat().filter(b => b.uid === me.uid && b.status === 'active');
    if (mine.some(b => normPlate(b.car) === normPlate(car.plate))) throw fail(409, 'CAR_BOOKED', 'รถคันนี้มีการจองอยู่แล้ว');
    if (mine.length >= MAX_ACTIVE_PER_USER) throw fail(409, 'LIMIT', 'จองได้ไม่เกิน 3 ช่องพร้อมกัน');

    const s = now();
    const entry = { id: newBookingId(), f: p.f, i: p.i, car: car.plate, s, e: s + HOLD_MS, status: 'active', amt: P.bookFee(snap.config), pm: p.pm, rno: newReceiptNo(), rq };
    const bkEntry = { id: entry.id, uid: me.uid, car: entry.car, s, e: entry.e, status: 'active', amt: entry.amt, pm: entry.pm, rno: entry.rno, rq };
    // ถอน bk_ ของเราเมื่อยังเป็นของเรา (ใช้ตอนล้มกลางทาง) ถอนไม่ได้ = ปล่อยให้ตัวซ่อมเก็บกวาด
    const release = async () => { try { await clearBk(p.f, p.i, entry.id); } catch { /* ตัวซ่อมเก็บ */ } };

    try { await store.writeBk(p.f, p.i, [bkEntry]); } catch (e) { await release(); throw e; }
    let back;
    try { back = await store.readBk(p.f, p.i); } catch (e) { await release(); throw e; }
    if (back.length !== 1 || back[0].id !== entry.id) throw fail(409, 'SLOT_TAKEN', 'ช่องนี้ถูกจองไปแล้ว');   // ไม่ใช่ของเรา: ไม่ย้อนเขียนทับของคนอื่น
    const newBooks = upsertBook(books, entry);
    try { await store.writeBooks(me.uid, newBooks); } catch (e) { await release(); throw e; }
    let again;
    try { again = await store.readBk(p.f, p.i); } catch (e) { await release(); throw e; }
    if (again.length !== 1 || again[0].id !== entry.id) {   // สองกระบวนการทับกัน: ถอนสำเนาของเราออกจาก books แล้วยอมแพ้
      try { await store.writeBooks(me.uid, books.filter(b => b.id !== entry.id)); } catch { /* ตัวซ่อม R3 */ }
      throw fail(409, 'SLOT_TAKEN', 'ช่องนี้ถูกจองไปแล้ว');
    }
    lot.applyBk(k, [bkEntry]); remember(entry.id, me.uid);
    emit(me.uid, newBooks);
    return { replay: false, body: replayBody(entry, now()) };
  }

  async function create(me, body) {
    guardWrites();
    const p = parseCreate(body);
    // อ่านสดจากบัญชีของผู้ใช้เอง (ไม่เชื่อ cache/client)
    const prof = await wrap(() => tb.readAttrs(me.uid, ['cars', 'pays']));
    const cars = Array.isArray(prof.cars) ? prof.cars : [], pays = Array.isArray(prof.pays) ? prof.pays : [];
    const car = cars.find(c => isObj(c) && typeof c.plate === 'string' && normPlate(c.plate) === normPlate(p.plate));
    if (!car) throw fail(400, 'CAR_UNKNOWN', 'ไม่พบรถคันนี้ในบัญชีของคุณ');
    if (p.pm !== 'pp' && !pays.some(x => isObj(x) && x.id === p.pm)) throw fail(400, 'PAY_UNKNOWN', 'ไม่พบวิธีชำระเงินนี้');
    const cur = await wrap(() => lot.get());
    if (p.f > cur.config.floors || p.i >= cur.config.slots) throw fail(404, 'NO_SLOT', 'ไม่พบช่องจอดนี้');

    // reqId ผูก uid: ซ้ำ + payload เดิม = ผลเดิม (รอถ้ายังทำอยู่), ซ้ำ + payload ต่าง = REQ_REUSED
    const key = me.uid + ':' + p.reqId, sig = p.f + '|' + p.i + '|' + normPlate(car.plate) + '|' + p.pm;
    const hit = reqs.get(key);
    if (hit) {
      if (hit.sig !== sig) throw fail(409, 'REQ_REUSED', 'คำขอซ้ำไม่ตรงกับครั้งก่อน กรุณาลองใหม่');
      return { status: 200, body: await hit.p };
    }
    const rq = rqOf(p.reqId);
    pendingRq.set(rq, (pendingRq.get(rq) || 0) + 1);
    const task = mutex.run(() => wrap(() => writeUnderLock(me, p, rq, car)));
    const bodyP = task.then(r => r.body); bodyP.catch(() => {});   // ผู้รอซ้ำเป็นคนรับ error ถ้ามี ไม่ให้เป็น unhandled
    reqs.set(key, { sig, p: bodyP });
    try {
      const r = await task;
      return { status: r.replay ? 200 : 201, body: r.body };
    } catch (e) {
      const c = reqs.get(key); if (c && c.p === bodyP) reqs.del(key);   // ล้ม = ไม่จำ ให้ลองใหม่ด้วย reqId เดิมได้
      throw e;
    } finally { const n = (pendingRq.get(rq) || 1) - 1; if (n > 0) pendingRq.set(rq, n); else pendingRq.delete(rq); }
  }

  // ---------- ออกจากช่อง (ผู้ใช้กดเอง) ----------
  async function leave(me, id, body, release) {   // release (เดโม BARRIER_IDLE_DOWN): ออกแล้วลดไม้กั้นกลับ
    let ck = null;
    const r = await leaveRun(me, id, body, k => { ck = k; });
    if (ck && release) { try { await release(ck); } catch { /* ไม่ย้อนการออก */ } }
    return r;
  }
  async function leaveRun(me, id, body, onKey) {
    guardWrites(); checkId(id); noBody(body);
    return { status: 200, body: await wrap(() => mutex.run(async () => {
      const books = await store.readBooks(me.uid), b = books.find(x => x.id === id && x.status !== 'void');
      if (onKey && b && b.status !== 'done') onKey(b.f + '-' + b.i);
      if (!b) throw notFound();
      if (b.status === 'done') return resultBody(b, 'park');   // ซ้ำ = ผลเดิม
      if (b.status !== 'active') throw fail(409, 'NOT_ACTIVE', 'รายการนี้สิ้นสุดแล้ว');
      const e = (await store.readBk(b.f, b.i)).find(x => x.id === id && x.uid === me.uid && x.status === 'active');   // ตัวจริงอยู่ที่ bk_
      if (!e) throw notFound();
      // ออกได้ทั้งก่อนและหลังรถมาถึง (เหมือนเว็บเดิม finish()): out = ตอนนี้, นาทีนับจากเวลาเริ่มการจอง (ขั้นต่ำ 1), ค่าจอด = ราคา(max(0, นาที - freemin)), ไม่คืนค่าจอง
      const out = Math.max(now(), e.s), cfgNow = (await lot.get()).config;
      const entry = await doEnd(me.uid, e, b.f, b.i, { status: 'done', out, min: P.parkMinutes(e.s, out), park: P.parkFee(cfgNow, e.s, out) });
      return resultBody(entry, 'park');
    }), () => fail(502, 'UPSTREAM', 'บันทึกการออกไม่สำเร็จ ลองใหม่อีกครั้ง (ส่งซ้ำได้ ไม่เกิดรายการซ้ำ)')) };
  }

  // ---------- ผู้ดูแลยกเลิก (staff/master) ----------
  // recheck: () => Promise<me> ตรวจสิทธิ์สดจาก TB (ไม่ใช้ cache) ทำ "ในล็อก" ก่อนเขียนอะไร ถอดสิทธิ์ระหว่างรอคิวจึงไม่รอด (N-4)
  async function cancelRun(me, id, body, recheck, note) {
    if (me.role !== 'staff' && me.role !== 'master') throw fail(403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');   // ตรวจ role ก่อนค้น id
    guardWrites(); checkId(id);
    const reason = parseReason(body);
    return { status: 200, body: await wrap(() => mutex.run(async () => {
      if (recheck) { const now2 = await recheck(); if (now2.role !== 'staff' && now2.role !== 'master') throw fail(403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้'); }
      const snap = await lot.fresh(); track(snap);
      let k = null, e = null;
      for (const [key, list] of Object.entries(snap.bkAll)) { const f = list.find(b => b.id === id && b.status === 'active'); if (f) { k = key; e = f; break; } }
      if (e) {
        const [f, i] = k.split('-').map(Number);
        note(k);   // จดช่องที่ยกเลิกจริง (ไม่ใช่ replay) ให้ cancel() ปล่อยไม้กั้นหลังพ้นล็อก
        const entry = await doEnd(e.uid, e, f, i, { status: 'cancelled', by: 'admin', bu: me.uid, reason, out: Math.max(now(), e.s) });
        return resultBody(entry, 'refund');
      }
      const known = idIndex.get(id); if (!known) throw notFound();
      const b = (await store.readBooks(known.uid)).find(x => x.id === id && x.status !== 'void');
      if (!b || b.status === 'active') throw notFound();
      if (b.status === 'cancelled') return resultBody(b, 'refund');   // ซ้ำ = ผลเดิม ไม่มีใบเสร็จติดลบใบที่สอง
      throw fail(409, 'NOT_ACTIVE', 'รายการนี้สิ้นสุดแล้ว');
    }), () => fail(502, 'UPSTREAM', 'ยกเลิกไม่สำเร็จ ลองใหม่อีกครั้ง (ส่งซ้ำได้ ไม่เกิดรายการซ้ำ)')) };
  }

  // M4 B3: release(k) = ปล่อยไม้กั้นช่อง k ถ้าลดอยู่และรถไม่อยู่ (เรียกหลังพ้นล็อกการจอง ล้มเหลวไม่ย้อนการยกเลิก) ผลใส่ใน response.barrier
  async function cancel(me, id, body, recheck, release) {
    let ck = null;
    const r = await cancelRun(me, id, body, recheck, k => { ck = k; });
    if (ck && release) { let b = 'failed'; try { b = await release(ck); } catch { /* ไม่ย้อนการยกเลิก */ } r.body.barrier = b; }
    return r;
  }

  // ---------- รายการของฉัน (GET /api/me/bookings และ SSE mine) ----------
  const mineFrom = books => ({ serverNow: now(), books: visibleBooks(books), rcp: receiptsFrom(books) });
  async function mineOf(uid) {
    await lazyFor(uid);
    let books = await store.readBooks(uid);
    try { books = await repairBooks(uid, books, await lot.get()); } catch { /* ซ่อมไม่ได้ก็ตอบตามที่มี */ }
    return mineFrom(books);
  }

  return {
    create, leave, cancel, mineOf, mineFrom, mutex, store, guardWrites, writesEnabled,
    onUserChange: fn => userListeners.push(fn),
    clearReqCache: () => reqs.clear(),   // จำลองรีสตาร์ตในเทสต์
    stop: () => { stopObserve(); },
    idle: ms => mutex.idle(ms),
    MAX_ACTIVE_PER_USER,
  };
}

module.exports = { createBookings, parseCreate, decide };
