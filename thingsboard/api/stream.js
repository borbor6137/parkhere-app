// M2: Server-Sent Events สำหรับ GET /api/live (ยืนยันตัวตนด้วย Authorization: Bearer ผ่าน fetch-streaming ก่อนเข้ามาที่นี่)
// ส่งสถานะเต็ม (event snapshot) ตอนเชื่อมต่อ แล้วส่งเฉพาะส่วนที่เปลี่ยน ping ทุก livePingMs กัน proxy ตัดการเชื่อมต่อ
const { ApiError } = require('./lib');

// mine = { get(uid), from(books), onChange(fn) }: event mine ของเจ้าของ (M3) ไม่ส่งข้ามผู้ใช้
function createHub(cfg, lot, now = () => Date.now(), mine = null) {
  const byUser = new Map();   // uid -> Set<conn> (เรียงตามเวลาเปิด)
  let total = 0;
  const MAX_BUFFER = 256 * 1024;

  async function open(req, res, me, cors = {}) {
    if (total >= cfg.liveMaxTotal) throw new ApiError(503, 'BUSY', 'มีผู้ใช้งานสถานะสดเต็มแล้ว ลองใหม่อีกสักครู่');
    const snap = await lot.get();   // ถ้า TB ไม่ตอบและยังไม่มี cache จะ throw ก่อนส่ง header (ได้ JSON error ปกติ)
    const set = byUser.get(me.uid) || new Set(); byUser.set(me.uid, set);
    while (set.size >= cfg.liveMaxPerUser) set.values().next().value.end('replaced');   // เปิดแท็บ/หน้าใหม่: ตัดการเชื่อมต่อที่เก่าสุดของคนนี้

    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    if (res.socket) { res.socket.setTimeout(0); res.socket.setNoDelay(true); }

    let closed = false, unsub = () => {}, pingT = null;
    const write = (event, data) => {
      if (closed) return;
      const ok = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (!ok && res.writableLength > MAX_BUFFER) cleanup();   // ลูกข่ายช้า/ค้าง: ตัดทิ้งไม่สะสมหน่วยความจำ
    };
    function cleanup() {
      if (closed) return; closed = true;
      clearInterval(pingT); unsub(); set.delete(conn); total--;
      if (!set.size) byUser.delete(me.uid);
      if (!res.writableEnded) res.destroy();
    }
    const conn = {
      end(reason) { if (closed) return; try { write('end', { reason }); res.end(); } catch { /* ปิดอยู่แล้ว */ } cleanup(); },
    };
    set.add(conn); total++;

    conn.pushMine = books => write('mine', mine.from(books));
    write('snapshot', { ...lot.view(snap, me.uid), serverNow: now() });
    if (mine) mine.get(me.uid).then(m => write('mine', m)).catch(() => { /* เว็บเรียก GET /api/me/bookings เป็นตาข่ายรองได้ */ });
    unsub = lot.subscribe((events, s) => {
      for (const ev of events) {
        if (ev.type === 'slot') write('slot', { k: ev.k, ...s.slots[ev.k] });
        else if (ev.type === 'board') write('board', { board: s.board, boards: s.boards });
        else if (ev.type === 'closed') write('closed', { closed: s.closed });
        else if (ev.type === 'config') write('config', { config: s.config, configSource: s.configSource, defaulted: s.defaulted });
        else if (ev.type === 'upstream') write('upstream', { stale: s.stale, asOf: s.asOf });
        else if (ev.type === 'bookings') write('bookings', { k: ev.k, bookings: lot.bookingsFor(s.bookings[ev.k], me.uid) });
      }
    });
    pingT = setInterval(() => {
      if (me.exp && now() >= me.exp) return conn.end('token-expired');   // JWT หมดอายุ: ให้ client ต่ออายุแล้วเชื่อมใหม่
      write('ping', { t: now() });
    }, cfg.livePingMs);
    pingT.unref && pingT.unref();
    req.on('close', cleanup); res.on('close', cleanup);
  }
  if (mine) mine.onChange((uid, books) => { for (const c of [...(byUser.get(uid) || [])]) c.pushMine && c.pushMine(books); });
  return { open, count: () => total, closeAll() { for (const s of [...byUser.values()]) for (const c of [...s]) c.end('shutdown'); } };
}
module.exports = { createHub };
