// เส้นทาง M1: signup / login / refresh / forgot / me
const { ApiError, E, ipKey, decodeJwt, sha, isObj, onlyKeys, createCache, createLimiter, createLockout, keyedLock, v } = require('./lib');
const { createTb } = require('./tb');
const { createLot } = require('./lot');
const { createHub } = require('./stream');
const { createBookings } = require('./bookings');
const { createBarrier } = require('./barrier');
const { createAdmin } = require('./admin');

// opts.writesEnabled: สวิตช์เขียนการจอง (เทสต์ส่งตรงนี้; ปกติมาจาก cfg.bookingsWrite = env BOOKINGS_WRITE=1) ค่าเริ่มต้น = ปิด
function createRoutes(cfg, tbIn, now = () => Date.now(), opts = {}) {
  const tb = tbIn || createTb(cfg, undefined, { barrierEnabled: opts.barrierEnabled });   // opts.barrierEnabled: เทสต์เปิดสั่งบอร์ดกับ mock เท่านั้น (ปกติ = cfg.barrierRpc)
  const writesEnabled = opts.writesEnabled !== undefined ? !!opts.writesEnabled : !!cfg.bookingsWrite;
  const authCache = createCache(cfg.authCacheMs, 2000, now);
  const ipLimit = createLimiter(cfg.ipLimit, cfg.ipWindowMs, now);
  const forgotLimit = createLimiter(5, 60000, now);
  const lockout = createLockout(cfg.lockFails, cfg.lockMs, now);
  const lock = keyedLock();
  const lot = createLot(cfg, tb, now);
  const bookings = createBookings({ cfg, tb, lot, now, writesEnabled });
  const hub = createHub(cfg, lot, now, { get: uid => bookings.mineOf(uid), from: bookings.mineFrom, onChange: bookings.onUserChange });
  const authNeg = createCache(cfg.authNegCacheMs, 2000, now);   // JWT ที่ ThingsBoard ปฏิเสธแล้ว (hash) จำ 30 วิ: ยิงซ้ำไม่ถึง TB
  const badTok = createLimiter(cfg.badTokenIpMax, 60000, now);   // โทเคนที่ TB ปฏิเสธ ต่อ IP: เต็มแล้วตอบ 429 โดยไม่ยิง TB (N-1)
  const putRate = createLimiter(cfg.putRateMax, cfg.userRateWindowMs, now);   // PUT /api/me ต่อ uid (N-2)
  const leaveRate = createLimiter(cfg.leaveRateMax, cfg.userRateWindowMs, now);   // leave + DELETE: 20/นาที/uid
  const barrierRate = createLimiter(cfg.barrierRateMax, cfg.userRateWindowMs, now);   // POST /api/barrier: member 6/นาที/uid (นับทุกคำขอที่ผ่านตรวจตัวตน)
  const barrierAdminRate = createLimiter(cfg.barrierAdminRateMax, cfg.userRateWindowMs, now);   // /api/admin/barrier* : staff/master 20/นาที/uid (แยกจาก member)
  const adminWriteRate = createLimiter(cfg.adminWriteRateMax, cfg.userRateWindowMs, now);   // M5 PUT closed/config: staff/master 20/นาที/uid (นับทุกคำขอที่ผ่านตรวจตัวตนและเป็น staff)
  const adminListRate = createLimiter(cfg.adminListRateMax, cfg.userRateWindowMs, now);   // M5 GET รายการจองทั้งหมด 12/นาที/uid
  const barrier = createBarrier({ cfg, tb, lot, mutex: bookings.mutex, now }, { log: opts.barrierLog, timers: opts.barrierTimers });
  const admin = createAdmin({ cfg, tb, lot, bookings, now, writesEnabled, log: opts.adminLog });

  // 429 ทุกตัวมี Retry-After (วินาที) และข้อความไทยบอกวินาที
  const rateError = retryMs => { const sec = Math.max(1, Math.ceil(retryMs / 1000)); return new ApiError(429, 'RATE_LIMIT', `ส่งคำขอถี่เกินไป ลองใหม่ใน ${sec} วินาที`, { 'Retry-After': String(sec) }); };
  const limitIp = (lim, ip) => { const r = lim.take(ip); if (!r.ok) throw rateError(r.retryMs); };
  const bookRate = createLimiter(cfg.bookRateMax, cfg.userRateWindowMs, now);   // ต่อ uid: นับทุกคำขอที่ผ่านตรวจตัวตน (รวมที่ได้ 400/409)
  // F-4: เพดานการอ่านต่อ uid (แยกตามชนิด) + ตัดการอ่านของผู้ใช้เมื่อคำขอ ThingsBoard รวมต่อนาทีเกินงบ (จอง/ออก/ยกเลิกไม่ถูกตัด)
  const meRate = createLimiter(cfg.meRateMax, cfg.userRateWindowMs, now), mineRate = createLimiter(cfg.meRateMax, cfg.userRateWindowMs, now), liveRate = createLimiter(cfg.meRateMax, cfg.userRateWindowMs, now);
  const shed = () => { if (tb.load && tb.load() >= cfg.tbBudget) throw new ApiError(503, 'BUSY', 'ระบบหนาแน่น กรุณาลองใหม่ในอีกสักครู่', { 'Retry-After': '5' }); };
  const limitUser = (lim, uid) => { const r = lim.take(uid); if (!r.ok) throw rateError(r.retryMs); };
  const bodyOf = (b, keys, name) => { if (!isObj(b)) throw E.badInput('ต้องส่งข้อมูลเป็น JSON'); onlyKeys(b, keys, name); return b; };
  const bearer = req => { const m = /^Bearer (\S+)$/.exec(req.headers.authorization || ''); if (!m) throw E.noAuth(); return m[1]; };

  const inApp = u => {
    const cid = u.customerId && u.customerId.id;
    return u.authority === 'TENANT_ADMIN' || (u.authority === 'CUSTOMER_USER' && (cid === cfg.customerMembersId || (cfg.customerStaffId && cid === cfg.customerStaffId)));
  };
  // บทบาทตัดสินจากฝั่ง ThingsBoard (authority + customer) ไม่ใช่จากอีเมลหรือสิ่งที่ client ส่งมา
  const roleOf = u => u.authority === 'TENANT_ADMIN' ? 'master'
    : (u.customerId && cfg.customerStaffId && u.customerId.id === cfg.customerStaffId) ? 'staff' : 'member';
  // group "Customer Users" ของ customer Members (ใช้ TB_MEMBERS_GROUP_ID ถ้าตั้งไว้ ไม่งั้นค้นตามชื่อแล้วจำไว้)
  let groupCache;
  async function membersGroup() {
    if (cfg.membersGroupId) return cfg.membersGroupId;
    if (groupCache !== undefined) return groupCache;
    const r = await tb.admin(`/api/entityGroups/CUSTOMER/${encodeURIComponent(cfg.customerMembersId)}/USER`);
    const g = r.ok && Array.isArray(r.data) ? r.data.find(x => x && x.name === 'Customer Users' && x.id) : null;
    if (!g) { console.warn(`[signup] หา group Customer Users ของ Members ไม่พบ (status=${r.status}) ตั้ง TB_MEMBERS_GROUP_ID แทน`); return null; }   // ไม่ cache ความล้มเหลว
    return (groupCache = g.id.id);
  }
  const safeLog = d => String(typeof d === 'string' ? d : (d && d.message) || '').replace(/[^\s@]+@[^\s@]+/g, '<email>').replace(/[A-Za-z0-9_-]{24,}/g, '<x>').slice(0, 200);
  const pairOf =d => ({ token: d.token, refreshToken: d.refreshToken });
  const forbidden = () => new ApiError(403, 'FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์ใช้ ParkHere');

  // ตรวจ JWT ผ่าน ThingsBoard (GET /api/auth/user) แล้ว cache สั้นๆ; uid มาจากที่นี่เท่านั้น
  // opts.fresh: ข้าม authCache แล้วถาม ThingsBoard ใหม่ (ใช้กับการเปลี่ยนแปลงโดย staff/master: ถอดสิทธิ์แล้วมีผลทันที F-1/SR-10)
  async function authUser(req, opts = {}) {
    const jwt = bearer(req);
    const p = decodeJwt(jwt);
    if (!p) throw E.badToken();
    if (typeof p.exp === 'number' && p.exp * 1000 <= now()) throw E.expired();
    const k = sha(jwt), neg = authNeg.get(k);
    if (neg) throw neg === 'expired' ? E.expired() : E.badToken();
    const hit = opts.fresh ? undefined : authCache.get(k);
    if (hit) return hit;
    const ip = req.clientIp || ipKey(req.socket && req.socket.remoteAddress);
    const pk = badTok.peek(ip); if (!pk.ok) throw rateError(pk.retryMs);
    const r = await tb.asUser(jwt, '/api/auth/user');
    if (r.status === 401) { badTok.take(ip); const ex = /expired/i.test(JSON.stringify(r.data)); authNeg.set(k, ex ? 'expired' : 'bad'); throw ex ? E.expired() : E.badToken(); }
    if (!r.ok || !isObj(r.data) || !r.data.id) throw E.upstream();
    if (!inApp(r.data)) throw forbidden();
    const me = { uid: r.data.id.id, email: r.data.email, firstName: r.data.firstName || '', role: roleOf(r.data), exp: typeof p.exp === 'number' ? p.exp * 1000 : 0 };
    const left = typeof p.exp === 'number' ? p.exp * 1000 - now() : cfg.authCacheMs;
    authCache.set(k, me, Math.max(1000, Math.min(cfg.authCacheMs, left)));
    return me;
  }

  const authFresh = req => authUser(req, { fresh: true });
  // S1: ปฏิเสธ member จากแคช authUser (ไม่เรียก ThingsBoard ซ้ำทุกคำขอ); staff/master ตรวจสดเหมือนเดิม (ถอดสิทธิ์มีผลทันที) member ที่เพิ่งได้เลื่อนรอแคชหมดอายุ ≤ AUTH_CACHE_MS
  const staffFresh = async req => { const c = await authUser(req); return c.role === 'staff' || c.role === 'master' ? authFresh(req) : c; };

  async function loadMe(me) {
    const a = await tb.readAttrs(me.uid, ['profile', 'cars', 'pays']);
    const profile = isObj(a.profile) ? a.profile : {};
    return { id: me.uid, email: me.email, role: me.role, configEditable: admin.canConfig(me), name: profile.name || me.firstName,
      cars: Array.isArray(a.cars) ? a.cars : [], pays: Array.isArray(a.pays) ? a.pays : [] };
  }

  return {
    authUser, authFresh, lot, hub, writesEnabled, bookings, tb, barrierEnabled: !!tb.barrierEnabled,
    barrier,
    close() { hub.closeAll(); barrier.stop(); bookings.stop(); lot.stop(); },
    // ปิดระบบ: รองานเขียนที่ค้างให้เสร็จไม่เกิน ms (SIGTERM)
    drain: ms => bookings.idle(ms),

    // ไม่ต้องล็อกอิน ไม่เรียก ThingsBoard ไม่เปิดเผยอะไรนอกจากสถานะและเวลาที่รัน
    async health() { return { status: 200, body: { ok: true, uptime: Math.round(process.uptime()) } }; },

    // M2: สถานะลานจอดทั้งหมด (ต้องมี Bearer); ผู้ใช้เห็น car/id เฉพาะการจองของตัวเอง
    async getLot(req) { const me = await authUser(req); return { status: 200, body: { ...lot.view(await lot.get(), me.uid), serverNow: now() } }; },

    // M2: SSE (จัดการ response เอง) ยืนยันตัวตนก่อนเปิด stream; error ก่อนส่ง header ได้ JSON ปกติ
    async live(req, res, ctx) { const me = await authUser(req); limitUser(liveRate, me.uid); shed(); await hub.open(req, res, me, ctx.cors); },

    // M3: จอง (ลำดับตรวจดู bookings.js และ docs/migration/M3-api.md)
    async createBooking(req, ctx) { const me = await authUser(req); limitUser(bookRate, me.uid); const out = await bookings.create(me, ctx.body); const bd = ctx.body || {}; if (out && out.status < 300 && Number.isInteger(bd.f) && Number.isInteger(bd.i)) barrier.raiseOnBook(bd.f + '-' + bd.i); return out; },

    // M3: ออกจากช่อง / ผู้ดูแลยกเลิก (เพดานร่วม 20/นาที/uid) / รายการของฉัน
    async leaveBooking(req, ctx) { const me = await authUser(req); limitUser(leaveRate, me.uid); return bookings.leave(me, ctx.params[0], ctx.body, process.env.BARRIER_IDLE_DOWN === '1' ? barrier.leaveSim : undefined); },
    // staff/master: ตรวจ role สดจาก ThingsBoard ทุกครั้งที่จะเขียน (ไม่ใช้ authCache 60 วิ) ใน bookings.cancel; member ไม่ต้องถามซ้ำ (cache บอกว่าไม่ใช่ staff = 403 อยู่แล้ว)
    // และตรวจซ้ำ "ในล็อก" ก่อนเขียน (recheck) กันถอดสิทธิ์ระหว่างรอคิว (N-4) M5: ทุก endpoint ของ staff ต้องทำแบบเดียวกัน
    async cancelBooking(req, ctx) { const me = await authUser(req); limitUser(leaveRate, me.uid); return bookings.cancel(me, ctx.params[0], ctx.body, () => authFresh(req), barrier.release); },
    // M4: member ลดไม้กั้นของการจองตัวเองที่ยังไม่มาถึง (ลำดับตรวจดู barrier.js); บอร์ดจริงสั่งได้เมื่อ BARRIER_RPC=1 เท่านั้น
    async parked(req, ctx) { const me = await authFresh(req); limitUser(barrierRate, me.uid); return barrier.memberParked(me, ctx.body); },
    async barrierDown(req, ctx) { const me = await authFresh(req); limitUser(barrierRate, me.uid); return barrier.memberDown(me, ctx.body); },
    // M4 B4: staff/master ลด/ยกรายช่อง และยกทั้งหมด; authFresh + recheck ในล็อก (ไม่เชื่อ authCache); member = 403
    async adminBarrier(req, ctx) { const me = await authFresh(req); limitUser(barrierAdminRate, me.uid); return barrier.staffSet(me, ctx.body, () => authFresh(req)); },
    async adminBarrierRaiseAll(req, ctx) { const me = await authFresh(req); limitUser(barrierAdminRate, me.uid); return barrier.staffRaiseAll(me, ctx.body, () => authFresh(req)); },
    // M5: staff/master เท่านั้น; authFresh + ตรวจ role ก่อนค้นข้อมูล (member = 403 ก่อนนับเพดาน) + recheck ในล็อกของ PUT
    async adminClosed(req, ctx) { const me = await staffFresh(req); if (me.role === 'staff' || me.role === 'master') limitUser(adminWriteRate, me.uid); return admin.setClosed(me, ctx.body, () => authFresh(req)); },
    async adminConfig(req, ctx) { const me = await staffFresh(req); if (me.role === 'staff' || me.role === 'master') limitUser(adminWriteRate, me.uid); return admin.setConfig(me, ctx.body, () => authFresh(req)); },
    async adminBookings(req) { const me = await staffFresh(req); if (me.role === 'staff' || me.role === 'master') { limitUser(adminListRate, me.uid); shed(); } return admin.list(me, req.url); },
    async getMyBookings(req) { const me = await authUser(req); limitUser(mineRate, me.uid); shed(); return { status: 200, body: await bookings.mineOf(me.uid) }; },

    async signup(req, ctx) {
      limitIp(ipLimit, ctx.ip);
      const b = bodyOf(ctx.body, ['email', 'password', 'name', 'plate'], 'สมัครสมาชิก');
      const em = v.email(b.email), pw = v.password(b.password), name = v.text(b.name, 'ชื่อ', 1, 40);
      const car = b.plate === undefined || b.plate === '' ? null : v.plate(b.plate);
      const gid = await membersGroup();
      const q = '?sendActivationMail=false' + (gid ? '&entityGroupId=' + encodeURIComponent(gid) : '');
      const cu = await tb.admin('/api/user' + q, { method: 'POST', body: { email: em, authority: 'CUSTOMER_USER', firstName: name, customerId: { id: cfg.customerMembersId, entityType: 'CUSTOMER' } } });
      if (!cu.ok) {
        const t = JSON.stringify(cu.data);
        if (cu.status === 400 && /already|exist|present/i.test(t)) throw new ApiError(409, 'EMAIL_TAKEN', 'อีเมลนี้ถูกใช้สมัครแล้ว');
        if (cu.status === 402 || (cu.data && cu.data.subscriptionErrorCode != null) || /limit|maximum|exceed|quota|reached|too many|upgrade/i.test(t)) throw new ApiError(503, 'QUOTA', 'ระบบรับสมาชิกเต็มแล้ว กรุณาติดต่อผู้ดูแล');
        if (cu.status >= 400 && cu.status < 500) throw new ApiError(400, 'SIGNUP_REJECTED', 'สมัครไม่สำเร็จ ตรวจอีเมลแล้วลองใหม่');
        throw E.upstream();
      }
      const uid = cu.data.id.id;
      try {
        // PE: ผู้ใช้ที่ไม่อยู่ใน group ที่มี role จะไม่มีสิทธิ์ PROFILE:WRITE และ TB เงียบๆ ไม่ส่งอีเมลรีเซ็ต (ตอบ 200 เสมอ) -> ใส่ group ซ้ำอีกชั้น (idempotent)
        if (gid) { const g = await tb.admin(`/api/entityGroup/${encodeURIComponent(gid)}/addEntities`, { method: 'POST', body: [uid] }); if (!g.ok) console.warn(`[forgot-fix] addEntities ไม่สำเร็จ status=${g.status}`); }
        const al = await tb.admin(`/api/user/${encodeURIComponent(uid)}/activationLink`, { accept: '*/*' });   // TB ตอบ text/plain ถ้าส่ง Accept: application/json จะได้ 406
        const link = typeof al.data === 'string' ? al.data : '';
        const token = al.ok && /[?&]activateToken=([^&\s]+)/.exec(link);
        if (!token) throw E.upstream();
        const act = await tb.anon('/api/noauth/activate?sendActivationMail=false', { method: 'POST', body: { activateToken: decodeURIComponent(token[1]), password: pw } });
        if (!act.ok) {
          if (act.status === 400) throw new ApiError(400, 'WEAK_PASSWORD', 'รหัสผ่านไม่ผ่านเงื่อนไขของระบบ ลองตั้งให้ยาวและคาดเดายากขึ้น');
          throw E.upstream();
        }
        const attrs = { profile: { name, created: now() }, cars: car ? [{ plate: car }] : [], pays: [] };
        await tb.writeAttrs(uid, attrs);
        let tokens = act.data && act.data.token ? pairOf(act.data) : null;
        if (!tokens) {   // เผื่อ activate ไม่คืน token
          const l = await tb.anon('/api/auth/login', { method: 'POST', body: { username: em, password: pw } });
          if (!l.ok) throw E.upstream();
          tokens = pairOf(l.data);
        }
        return { status: 201, body: { ...tokens, user: { id: uid, email: em, role: 'member', name, cars: attrs.cars, pays: [] } } };
      } catch (e) {
        await tb.admin('/api/user/' + encodeURIComponent(uid), { method: 'DELETE' }).catch(() => {});   // ไม่ทิ้งบัญชีครึ่งๆ กลางๆ
        throw e;
      }
    },

    async login(req, ctx) {
      limitIp(ipLimit, ctx.ip);
      const b = bodyOf(ctx.body, ['email', 'password'], 'เข้าสู่ระบบ');
      const em = v.email(b.email);
      if (typeof b.password !== 'string' || !b.password || b.password.length > 128) throw E.badInput('กรุณากรอกรหัสผ่าน');
      const left = lockout.check(em);
      if (left) throw new ApiError(429, 'ACCOUNT_LOCKED', `ใส่รหัสผ่านผิดหลายครั้ง บัญชีถูกพักชั่วคราว ลองใหม่ใน ${Math.ceil(left / 60000)} นาที`);
      const r = await tb.anon('/api/auth/login', { method: 'POST', body: { username: em, password: b.password } });
      if (r.status === 401 || r.status === 400) { lockout.fail(em); throw new ApiError(401, 'INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'); }
      if (!r.ok || !r.data || !r.data.token) throw E.upstream();
      lockout.ok(em);
      const u = await tb.asUser(r.data.token, '/api/auth/user');
      if (!u.ok || !isObj(u.data) || !u.data.id) throw E.upstream();
      if (!inApp(u.data)) throw forbidden();
      return { status: 200, body: { ...pairOf(r.data), user: { id: u.data.id.id, email: u.data.email, role: roleOf(u.data), name: u.data.firstName || '' } } };
    },

    async refresh(req, ctx) {
      limitIp(ipLimit, ctx.ip);
      const b = bodyOf(ctx.body, ['refreshToken'], 'ต่ออายุเซสชัน');
      if (typeof b.refreshToken !== 'string' || b.refreshToken.length < 10 || b.refreshToken.length > 4096) throw E.badInput('refreshToken ไม่ถูกต้อง');
      const r = await tb.anon('/api/auth/token', { method: 'POST', body: { refreshToken: b.refreshToken } });
      if (r.status >= 400 && r.status < 500) throw new ApiError(401, 'REFRESH_INVALID', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
      if (!r.ok || !r.data || !r.data.token) throw E.upstream();
      return { status: 200, body: pairOf(r.data) };
    },

    // ตอบเหมือนกันเสมอ (ไม่บอกว่าอีเมลมีในระบบหรือไม่); ThingsBoard ส่งอีเมลจริงเมื่อตั้ง mail server ไว้
    async forgot(req, ctx) {
      limitIp(forgotLimit, ctx.ip);
      const b = bodyOf(ctx.body, ['email'], 'ลืมรหัสผ่าน');
      const em = v.email(b.email);
      // log สถานะ/ข้อความของ TB เท่านั้น (ไม่ log อีเมล/token) แต่ตอบผู้ใช้เหมือนเดิม
      try {
        const r = await tb.anon('/api/noauth/resetPasswordByEmail', { method: 'POST', body: { email: em } });
        const msg = r.ok ? '' : safeLog(r.data);
        console.log(`[forgot] TB resetPasswordByEmail status=${r.status}${msg ? ' error=' + msg : ''}`);
      } catch (e) { console.warn(`[forgot] TB resetPasswordByEmail ล้มเหลว: ${e && e.code ? e.code : 'error'}`); }
      return { status: 200, body: { ok: true, message: 'ถ้าอีเมลนี้มีบัญชีอยู่ ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้ (ตรวจกล่องสแปมด้วย)' } };
    },

    async getMe(req) { const me = await authUser(req); limitUser(meRate, me.uid); shed(); return { status: 200, body: await loadMe(me) }; },

    async putMe(req, ctx) {
      const me = await authUser(req); limitUser(putRate, me.uid);
      const b = bodyOf(ctx.body, ['name', 'cars', 'pays'], 'โปรไฟล์');
      if (!Object.keys(b).length) throw E.badInput('ไม่มีข้อมูลที่จะแก้ไข');
      const upd = {};
      if (b.name !== undefined) upd.name = v.text(b.name, 'ชื่อ', 1, 40);
      if (b.cars !== undefined) upd.cars = v.cars(b.cars);
      if (b.pays !== undefined) { v.pays(b.pays); upd.pays = b.pays; }   // ตรวจรูปร่างก่อนเข้าล็อก/ก่อนยิง TB (ผิดรูป = 400 โดยไม่ถึง TB) แล้วตรวจ id ใต้ล็อกหลังอ่าน id เดิม
      await lock(me.uid, async () => {
        const w = {};
        if (upd.name !== undefined) { const a = await tb.readAttrs(me.uid, ['profile']); w.profile = { ...(isObj(a.profile) ? a.profile : {}), name: upd.name }; }
        if (upd.cars) w.cars = upd.cars;
        if (upd.pays) {   // id บัตรรับเฉพาะที่มีอยู่แล้ว (อ่านสด) ที่เหลือเซิร์ฟเวอร์สร้างเอง ห้ามให้ client กำหนด id/เลขยาว (F-2)
          const a = await tb.readAttrs(me.uid, ['pays']);
          w.pays = v.pays(upd.pays, (Array.isArray(a.pays) ? a.pays : []).map(x => isObj(x) ? x.id : undefined));
        }
        await tb.writeAttrs(me.uid, w);
      });
      return { status: 200, body: await loadMe(me) };
    },
  };
}
module.exports = { createRoutes };
