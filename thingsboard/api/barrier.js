// M4 B2: POST /api/barrier (สมาชิก: ลดไม้กั้นของการจองตัวเองที่ยังไม่มาถึงเท่านั้น) ตาม docs/migration/M4-plan.md ข้อ 3, 4.2-4.4
// สิทธิ์/สถานะตัดสินที่เซิร์ฟเวอร์ทั้งหมด: member ส่งแค่ {f,i,down:true}; ไม่ส่งทะเบียน/uid/id การจองไปที่บอร์ด (params มีแค่ slot กับ down)
// ลำดับ: รูปแบบ 400 -> ช่องไม่มี 404 -> role 403 (ก่อนค้นการจอง) -> ล็อก -> อ่านสด -> CLOSED/CONFLICT/UNKNOWN -> NOT_YOUR_BOOKING -> ALREADY_ARRIVED -> already -> COOLDOWN -> RPC
const { ApiError, E, isObj, onlyKeys, sha } = require('./lib');

const fail = (status, code, msg) => new ApiError(status, code, msg);
const notYours = () => fail(403, 'NOT_YOUR_BOOKING', 'ไม่มีการจองที่ใช้งานอยู่ในช่องนี้');   // ข้อความเดียว ไม่บอกว่ามีของใคร (กัน IDOR)

function parse(body) {
  if (!isObj(body)) throw E.badInput('ต้องส่งข้อมูลเป็น JSON');
  onlyKeys(body, ['f', 'i', 'down', 'force'], 'สั่งไม้กั้น');
  const { f, i, down, force } = body;
  if (!Number.isInteger(f) || f < 1 || f > 99) throw E.badInput('ชั้น (f) ต้องเป็นจำนวนเต็ม');
  if (!Number.isInteger(i) || i < 0 || i > 999) throw E.badInput('ช่อง (i) ต้องเป็นจำนวนเต็ม');
  if (typeof down !== 'boolean') throw E.badInput('down ต้องเป็น true หรือ false');
  if (force !== undefined && typeof force !== 'boolean') throw E.badInput('force ต้องเป็น true หรือ false');
  return { f, i, down, hasForce: force !== undefined, force: force === true };
}

// M4 B3: + ตัวจับเวลายกเอง 60 วิ, hook รถออก, ยกหลังยกเลิกการจอง, log รายคำสั่ง (docs/migration/M4-plan.md ข้อ 4.5, 4.6, 4.8)
// opts.log: ฟังก์ชันรับข้อความ (ค่าเริ่มต้น console.log); opts.timers: { set, clear } ฉีดตัวจับเวลา (ค่าเริ่มต้น = setTimeout/clearTimeout ของระบบ อ่านตอนเรียก)
function createBarrier({ cfg, tb, lot, mutex, now = () => Date.now() }, opts = {}) {
  const log = opts.log || (m => console.log(m));
  const setT = (fn, ms) => (opts.timers ? opts.timers.set : setTimeout)(fn, ms), clrT = h => (opts.timers ? opts.timers.clear : clearTimeout)(h);
  const raiseMs = cfg.barrierAutoRaiseMs !== undefined ? cfg.barrierAutoRaiseMs : 60000;
  const timers = new Map();   // ช่อง -> ตัวจับเวลา 60 วิ (เฉพาะคำสั่งลดของ member)
  const busy = new Set();     // ช่องที่กำลังยกอัตโนมัติ (กันยิงซ้ำจากหลาย snapshot/หลาย hook)
  let booted = false;
  const last = new Map();   // ช่อง -> เวลาที่ส่ง RPC ล่าสุด (คูลดาวน์ต่อช่อง) ใช้ร่วมกันทั้งคำสั่งผู้ใช้และการยกอัตโนมัติ
  const cool = cfg.barrierCooldownMs;
  const mark = k => { last.set(k, now()); if (last.size > 2000) last.delete(last.keys().next().value); };
  // log บรรทัดเดียวต่อคำสั่ง: เวลา ช่อง ทิศทาง role uid ย่อ (hash 8 ตัว) ผล เหตุ -- ไม่มีอีเมล ทะเบียน หรือ id การจอง
  const line = (k, down, role, uid, result, why) => { try { log(`[barrier] t=${new Date(now()).toISOString()} slot=${k} down=${down} role=${role} uid=${uid ? sha(String(uid)).slice(0, 8) : '-'} result=${result} why=${why}`); } catch { /* log ไม่ทำให้คำสั่งล้ม */ } };
  const clearTimer = k => { const h = timers.get(k); if (h !== undefined) { clrT(h); timers.delete(k); } };
  const devOf = x => x && x.source && (cfg.devices || []).find(d => d.name === x.source);

  // ยกอัตโนมัติ (timer / รถออก / หลังยกเลิก): ส่ง RPC ยกไปอุปกรณ์เจ้าของช่อง ไม่ผ่านคูลดาวน์ของผู้ใช้แต่บันทึกเวลาไว้ ไม่โยน error (คืนผลเป็นสตริง)
  async function autoRaise(k, x, why) {
    if (!tb.barrierEnabled) return 'unchanged';
    const dev = devOf(x);
    if (!dev) { line(k, false, 'system', null, 'skip-nodev', why); return 'unchanged'; }
    if (busy.has(k)) return 'unchanged';
    busy.add(k);
    try {
      mark(k);
      await tb.rpcOneway(dev.id, { method: 'setBarrier', params: { slot: k, down: false } });
      line(k, false, 'system', null, 'ok', why); return 'released';
    } catch (e) { line(k, false, 'system', null, 'error:' + ((e && e.code) || 'unknown'), why); return 'failed'; }
    finally { busy.delete(k); }
  }
  // ตัดสินยกจาก snapshot: ต้องลดอยู่ + รถไม่อยู่จริง (occ===false) ห้ามยกเมื่อ occ เป็น null (ไม่ทราบสถานะ) หรือ true
  const raisable = x => !!x && x.barrier === 'down' && x.occ === false && !x.conflict && x.online === true;

  // ครบเวลา: อ่านสดเอง (ไม่พึ่งผู้ดู) แล้วยกถ้ารถยังไม่เข้า
  function startTimer(k) {
    clearTimer(k);
    if (!(raiseMs > 0) || !tb.barrierEnabled) return;
    const h = setT(() => {
      timers.delete(k);
      mutex.run(async () => {
        const x = (await lot.fresh()).slots[k];
        if (!raisable(x)) { line(k, false, 'system', null, x && x.occ === true ? 'skip-occupied' : 'skip', 'auto-timer'); return; }
        await autoRaise(k, x, 'auto-timer');
      }).catch(e => line(k, false, 'system', null, 'error:' + ((e && e.code) || 'unknown'), 'auto-timer'));
    }, raiseMs);
    if (h && typeof h.unref === 'function') h.unref();
    timers.set(k, h);
  }

  // รถออก (occ true->false ขณะลดอยู่): lot ตรวจ transition ให้แล้ว (occ เป็น null ไม่เข้า hook)
  const IDLE_DOWN = process.env.BARRIER_IDLE_DOWN === '1';   // เดโม: ไม่มีการจอง = ไม้กั้นลด, จอง = ยก, member กดลดในเว็บ
  const offLeave = lot.onCarLeave(({ k, snap }) => { clearTimer(k); if (IDLE_DOWN) return undefined; const x = snap.slots[k]; return raisable(x) ? autoRaise(k, x, 'auto-leave') : undefined; });
  // บรรเทารีสตาร์ต: snapshot แรกหลังเริ่มระบบ เจอช่องลดอยู่ + ไม่มีรถ + มีการจองที่ยังไม่มาถึง -> เริ่มนับ 60 วิ (ช่องที่ staff ลดโดยไม่มีการจองไม่ถูกยก)
  const offBoot = lot.observe(snap => {
    if (booted) return; booted = true;
    if (!tb.barrierEnabled) return;
    for (const k of Object.keys(snap.slots)) { const b = (snap.bkAll[k] || []).find(e => e.status === 'active' && !e.arr); if (b && raisable(snap.slots[k]) && !timers.has(k)) startTimer(k); }
  });

  async function sendIdle(k, x, down, why) {
    try { mark(k); await tb.rpcOneway(devOf(x).id, { method: 'setBarrier', params: { slot: k, down } }); line(k, down, 'system', null, 'ok', why); return 'released'; }
    catch (e) { line(k, down, 'system', null, 'error:' + ((e && e.code) || 'unknown'), why); return 'failed'; }
  }
  // เดโม: ซิงก์ทุก 15 วิ -- มีการจองที่รถยังไม่มา = ยก, ไม่มีการจอง = ลด (ข้ามช่องที่ member เพิ่งกดลด/มีรถ/ออฟไลน์)
  let syncing = false;
  async function idleSync() {
    if (!IDLE_DOWN || !tb.barrierEnabled || syncing) return;
    syncing = true;
    try {
      await mutex.run(async () => {
        const snap = await lot.fresh();
        for (const k of Object.keys(snap.slots)) {
          const x = snap.slots[k];
          if (!x || !x.online || x.occ !== false || x.conflict || !devOf(x) || timers.has(k) || snap.closed[k]) continue;
          const t = now(), prev = last.get(k); if (prev !== undefined && t - prev < 20000) continue;
          const want = (snap.bkAll[k] || []).some(e => e.status === 'active' && !e.arr) ? 'up' : 'down';
          if (x.barrier === want) continue;
          await sendIdle(k, x, want === 'down', 'idle-sync');
        }
      });
    } catch { /* รอบหน้าลองใหม่ */ } finally { syncing = false; }
  }
  const syncH = IDLE_DOWN ? setInterval(idleSync, 15000) : null;
  if (syncH && typeof syncH.unref === 'function') syncH.unref();
  async function leaveSim(k) {   // เดโม: ออกจากลานจอด -> ตัวจำลองตั้งช่องว่าง + ไม้กั้นลด
    try { const x = (await lot.fresh()).slots[k], dev = devOf(x); if (!dev || dev.name !== 'sim') return;
      mark(k); await tb.rpcOneway(dev.id, { method: 'setSlot', params: { slot: k, occ: false } });
      if (x.barrier !== 'down') await tb.rpcOneway(dev.id, { method: 'setBarrier', params: { slot: k, down: true } });
      line(k, true, 'system', null, 'ok', 'leave-sim'); } catch (e) { line(k, true, 'system', null, 'error:' + ((e && e.code) || 'unknown'), 'leave-sim'); }
  }
  async function raiseOnBook(k) {   // เรียกหลังจองสำเร็จ (นอกล็อก) ล้มเหลวไม่กระทบการจอง
    if (!IDLE_DOWN || !tb.barrierEnabled) return;
    try { await mutex.run(async () => { const x = (await lot.fresh()).slots[k]; if (x && x.barrier !== 'up' && x.occ === false && x.online && devOf(x)) await sendIdle(k, x, false, 'book-raise'); }); } catch { /* ไม่ย้อนการจอง */ }
  }
  // หลังยกเลิกการจอง (เรียกนอกล็อกการจอง): ลดอยู่และรถไม่อยู่ -> ยก; ล้มเหลวไม่ย้อนการยกเลิก คืน released|unchanged|failed
  async function release(k) {
    if (!tb.barrierEnabled) return 'unchanged';
    try {
      return await mutex.run(async () => { clearTimer(k); const x = (await lot.fresh()).slots[k]; if (IDLE_DOWN) return x && x.barrier === 'up' && x.occ === false && x.online && devOf(x) ? sendIdle(k, x, true, 'cancel-lower') : 'unchanged'; return raisable(x) ? autoRaise(k, x, 'cancel-release') : 'unchanged'; });
    } catch (e) { line(k, false, 'system', null, 'error:' + ((e && e.code) || 'unknown'), 'cancel-release'); return 'failed'; }
  }

  // member ลดไม้กั้น (me มาจาก authUser เท่านั้น)
  async function memberDownRun(me, body) {
    if (!tb.barrierEnabled) throw fail(503, 'BARRIER_DISABLED', 'ยังไม่เปิดให้สั่งไม้กั้น');   // ก่อนเรียก ThingsBoard ทุกชนิด
    const p = parse(body);
    const k = p.f + '-' + p.i;
    const cf = (await lot.get()).config;
    if (p.f > cf.floors || p.i >= cf.slots) throw fail(404, 'NO_SLOT', 'ไม่พบช่องจอดนี้');
    if (me.role !== 'member' || p.down !== true || p.hasForce) throw fail(403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');   // ก่อนค้นการจอง
    return mutex.run(async () => {
      const snap = await lot.fresh(), x = snap.slots[k];
      if (!x) throw fail(404, 'NO_SLOT', 'ไม่พบช่องจอดนี้');
      if (snap.closed[k]) throw fail(409, 'SLOT_CLOSED', 'ช่องนี้ปิดใช้งานอยู่');
      if (x.conflict) throw fail(409, 'SLOT_CONFLICT', 'สถานะช่องนี้ขัดแย้งกัน กรุณาติดต่อผู้ดูแล');
      const dev = x.source && (cfg.devices || []).find(d => d.name === x.source);
      if (snap.stale || x.occ === null || !x.online || !dev) throw fail(409, 'SLOT_UNKNOWN', 'ไม่ทราบสถานะช่องนี้ (บอร์ดไม่ออนไลน์) ลองใหม่ภายหลัง');
      const b = (snap.bkAll[k] || []).filter(e => e.status === 'active').sort((a, c) => a.s - c.s)[0];
      if (!b || !b.uid || b.uid !== me.uid) throw notYours();
      if (b.arr || x.occ === true) throw fail(409, 'ALREADY_ARRIVED', 'รถมาถึงช่องนี้แล้ว ลดไม้กั้นไม่ได้');
      const base = { serverNow: now(), f: p.f, i: p.i };
      if (x.barrier === 'down') return { status: 200, body: { ...base, sent: false, already: true } };   // snapshot สดบอกลดอยู่แล้ว ไม่ยิง RPC
      const t = now(), prev = last.get(k);
      if (prev !== undefined && t - prev < cool) { const sec = Math.max(1, Math.ceil((cool - (t - prev)) / 1000)); throw new ApiError(429, 'COOLDOWN', `เพิ่งสั่งช่องนี้ไป ลองใหม่ใน ${sec} วินาที`, { 'Retry-After': String(sec) }); }
      mark(k);
      await tb.rpcOneway(dev.id, { method: 'setBarrier', params: { slot: k, down: true } });
      if (IDLE_DOWN && dev.name === 'sim') {   // เดโม: ลดไม้กั้น = ถือว่าจอดแล้ว (ตัวจำลองตั้งช่องเป็นมีรถ)
        clearTimer(k); try { await tb.rpcOneway(dev.id, { method: 'setSlot', params: { slot: k, occ: true } }); } catch { /* ไม่ย้อนคำสั่งไม้กั้น */ }
      } else startTimer(k);   // ตั้งหลังส่งสำเร็จเท่านั้น (ล้ม = ไม่ตั้ง) และเฉพาะ member; staff ลดเองไม่ตั้ง
      return { status: 200, body: { ...base, sent: true } };   // "ส่งแล้ว" ไม่ใช่ "ลดแล้ว": ผลจริงมาจาก bar_ ทาง SSE
    });
  }
  // เดโม (ตัวจำลอง): ปุ่ม "จอดแล้ว" ของเจ้าของการจอง -> สั่งตัวจำลองตั้งช่องเป็นมีรถ (RPC setSlot) แทนเซนเซอร์
  async function memberParked(me, body) {
    if (!tb.barrierEnabled) throw fail(503, 'BARRIER_DISABLED', 'ยังไม่เปิดให้สั่งไม้กั้น');
    if (!isObj(body) || !Number.isInteger(body.f) || !Number.isInteger(body.i)) throw fail(400, 'BAD_INPUT', 'ข้อมูลไม่ถูกต้อง');
    if (me.role !== 'member') throw fail(403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
    const k = body.f + '-' + body.i;
    return mutex.run(async () => {
      const snap = await lot.fresh(), x = snap.slots[k];
      if (!x) throw fail(404, 'NO_SLOT', 'ไม่พบช่องจอดนี้');
      const dev = devOf(x);
      if (!dev || dev.name !== 'sim') throw fail(409, 'SLOT_UNKNOWN', 'ช่องนี้ไม่ใช่ตัวจำลอง');
      const bk = (snap.bkAll[k] || []).filter(e => e.status === 'active').sort((a, c) => a.s - c.s)[0];
      if (!bk || bk.uid !== me.uid) throw notYours();
      if (bk.arr || x.occ === true) throw fail(409, 'ALREADY_ARRIVED', 'รถมาถึงช่องนี้แล้ว');
      await tb.rpcOneway(dev.id, { method: 'setSlot', params: { slot: k, occ: true } });
      clearTimer(k); line(k, true, me.role, me.uid, 'ok', 'parked');
      return { status: 200, body: { serverNow: now(), sent: true } };
    });
  }
  // ห่อด้วย log รายคำสั่ง (ทั้งที่สำเร็จและถูกปฏิเสธ); k สำหรับ log อ่านจาก body แบบปลอดภัยเท่านั้น
  async function memberDown(me, body) {
    const kk = isObj(body) && Number.isInteger(body.f) && Number.isInteger(body.i) ? body.f + '-' + body.i : '?';
    try {
      const r = await memberDownRun(me, body);
      line(kk, true, me.role, me.uid, r.body.already ? 'already' : 'ok', 'user'); return r;
    } catch (e) { line(kk, true, me && me.role, me && me.uid, 'rejected:' + ((e && e.code) || 'unknown'), 'user'); throw e; }
  }
  // ---------- M4 B4: staff/master (path แยกจาก member) ----------
  const isStaff = r => !!r && (r.role === 'staff' || r.role === 'master');
  const noPerm = () => fail(403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
  const inCooldown = k => { const prev = last.get(k); return prev !== undefined && now() - prev < cool; };
  const cooldownErr = k => { const sec = Math.max(1, Math.ceil((cool - (now() - last.get(k))) / 1000)); return new ApiError(429, 'COOLDOWN', `เพิ่งสั่งช่องนี้ไป ลองใหม่ใน ${sec} วินาที`, { 'Retry-After': String(sec) }); };

  // สั่งรายช่อง (ลด/ยก): role ตรวจสดนอกล็อก (route ใช้ authFresh) + ตรวจซ้ำในล็อก (recheck) ก่อนส่ง RPC; ไม่ตั้ง auto-raise
  // ช่องปิดใช้งานสั่งได้; occ===true ต้อง force; ยกเมื่อ occ ไม่ทราบ (null) ต้อง force; ลดเมื่อ occ ไม่ทราบ (null, รวมบอร์ดออฟไลน์) ปฏิเสธเสมอ (D5)
  async function staffSetRun(me, body, recheck) {
    if (!isStaff(me)) throw noPerm();   // L1: member 403 ก่อน 400/404/503
    if (!tb.barrierEnabled) throw fail(503, 'BARRIER_DISABLED', 'ยังไม่เปิดให้สั่งไม้กั้น');
    const p = parse(body);
    const k = p.f + '-' + p.i;
    const cf = (await lot.get()).config;
    if (p.f > cf.floors || p.i >= cf.slots) throw fail(404, 'NO_SLOT', 'ไม่พบช่องจอดนี้');
    return mutex.run(async () => {
      if (recheck) { const r2 = await recheck(); if (!isStaff(r2)) throw noPerm(); }
      const snap = await lot.fresh(), x = snap.slots[k];
      if (!x) throw fail(404, 'NO_SLOT', 'ไม่พบช่องจอดนี้');
      if (x.conflict) throw fail(409, 'SLOT_CONFLICT', 'สถานะช่องนี้ขัดแย้งกัน ตรวจบอร์ดก่อนสั่ง');
      // D5 (M5): ลดไม้กั้นเมื่อไม่ทราบว่ามีรถหรือไม่ (occ===null) ปฏิเสธเสมอ แม้ force (ตรวจผลไม่ได้ว่ารถชนไม้กั้นหรือไม่)
      if (p.down && x.occ === null) throw fail(409, 'SLOT_UNKNOWN', 'ไม่ทราบว่ามีรถอยู่ในช่องหรือไม่ (บอร์ดไม่ส่งสัญญาณ) ลดไม้กั้นไม่ได้');
      const dev = devOf(x);
      if (!dev) throw fail(409, 'SLOT_UNKNOWN', 'ไม่ทราบบอร์ดที่คุมช่องนี้ ยังสั่งไม่ได้');
      if (!p.force && x.occ === true) throw fail(409, 'SLOT_OCCUPIED', 'ยังมีรถจอดอยู่ในช่องนี้ ยืนยันอีกครั้งถ้าต้องการสั่ง');
      if (!p.force && !p.down && x.occ === null) throw fail(409, 'SLOT_OCCUPIED', 'ไม่ทราบว่ามีรถอยู่หรือไม่ ยืนยันอีกครั้งถ้าต้องการยกไม้กั้น');
      const base = { serverNow: now(), f: p.f, i: p.i };
      if (!snap.stale && x.online === true && x.barrier === (p.down ? 'down' : 'up')) return { status: 200, body: { ...base, sent: false, already: true } };   // ข้อมูลสดเท่านั้น
      if (inCooldown(k)) throw cooldownErr(k);
      mark(k);
      await tb.rpcOneway(dev.id, { method: 'setBarrier', params: { slot: k, down: p.down } });
      return { status: 200, body: { ...base, sent: true } };
    });
  }
  async function staffSet(me, body, recheck) {
    const kk = isObj(body) && Number.isInteger(body.f) && Number.isInteger(body.i) ? body.f + '-' + body.i : '?', dn = isObj(body) ? body.down : '?';
    try {
      const r = await staffSetRun(me, body, recheck);
      line(kk, dn, me.role, me.uid, r.body.already ? 'already' : 'ok', 'staff'); return r;
    } catch (e) { if (isStaff(me)) line(kk, dn, me && me.role, me && me.uid, 'rejected:' + ((e && e.code) || 'unknown'), 'staff'); throw e; }
  }

  // ยกทุกช่องที่ snapshot สดว่าลดอยู่ (ไม่เกิน 36 RPC ต่อครั้ง); occ ไม่ใช่ false ต้อง force (ไม่ทราบ = ไม่ยก)
  const RAISE_ALL_MAX = 36;
  async function staffRaiseAllRun(me, body, recheck) {
    if (!isStaff(me)) throw noPerm();   // L1
    if (!tb.barrierEnabled) throw fail(503, 'BARRIER_DISABLED', 'ยังไม่เปิดให้สั่งไม้กั้น');
    let force = false;
    if (body !== undefined && body !== null) {
      if (!isObj(body)) throw E.badInput('ต้องส่งข้อมูลเป็น JSON');
      onlyKeys(body, ['force'], 'ยกไม้กั้นทั้งหมด');
      if (body.force !== undefined && typeof body.force !== 'boolean') throw E.badInput('force ต้องเป็น true หรือ false');
      force = body.force === true;
    }
    return mutex.run(async () => {
      if (recheck) { const r2 = await recheck(); if (!isStaff(r2)) throw noPerm(); }
      const snap = await lot.fresh();
      if (snap.stale) throw fail(409, 'SLOT_UNKNOWN', 'ข้อมูลลานจอดไม่สด ไม่ทราบว่าช่องใดลดอยู่ ลองใหม่ภายหลัง');
      const results = [], jobs = [];
      for (const k of Object.keys(snap.slots)) {
        const x = snap.slots[k]; if (x.barrier !== 'down') continue;
        const [f, i] = k.split('-').map(Number), dev = devOf(x);
        let code = null;
        if (x.conflict) code = 'SLOT_CONFLICT';
        else if (!dev) code = 'SLOT_UNKNOWN';
        else if (!force && x.occ !== false) code = x.occ === true ? 'SLOT_OCCUPIED' : 'SLOT_UNKNOWN';
        else if (inCooldown(k)) code = 'COOLDOWN';
        else if (jobs.length >= RAISE_ALL_MAX) code = 'TOO_MANY';
        if (code) { results.push({ f, i, ok: false, code }); line(k, false, me.role, me.uid, 'rejected:' + code, 'staff-raise-all'); continue; }
        mark(k); jobs.push({ f, i, k, dev });
      }
      const out = await Promise.allSettled(jobs.map(j => tb.rpcOneway(j.dev.id, { method: 'setBarrier', params: { slot: j.k, down: false } })));
      out.forEach((o, n) => {
        const j = jobs[n];
        if (o.status === 'fulfilled') { results.push({ f: j.f, i: j.i, ok: true }); line(j.k, false, me.role, me.uid, 'ok', 'staff-raise-all'); }
        else { const c = (o.reason && o.reason.code) || 'UPSTREAM'; results.push({ f: j.f, i: j.i, ok: false, code: c }); line(j.k, false, me.role, me.uid, 'error:' + c, 'staff-raise-all'); }
      });
      results.sort((a, b) => a.f - b.f || a.i - b.i);
      return { status: 200, body: { serverNow: now(), results } };
    });
  }
  async function staffRaiseAll(me, body, recheck) {
    try { return await staffRaiseAllRun(me, body, recheck); }
    catch (e) { if (isStaff(me)) line('*', false, me && me.role, me && me.uid, 'rejected:' + ((e && e.code) || 'unknown'), 'staff-raise-all'); throw e; }
  }
  return { raiseOnBook, leaveSim, memberParked, memberDown, staffSet, staffRaiseAll, mark, line, release, stop() { for (const k of [...timers.keys()]) clearTimer(k); offLeave(); offBoot(); if (syncH) clearInterval(syncH); }, pendingTimers: () => timers.size };
}
module.exports = { createBarrier };
