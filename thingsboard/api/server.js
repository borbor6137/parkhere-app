// parkhere-api (M1: auth + me, M2: lot + live + healthz) เซิร์ฟเวอร์ HTTP ไม่พึ่งแพ็กเกจเสริม
// รันแยก: node api/server.js (api เป็นผู้คุมไม้กั้นเมื่อเปิด BARRIER_RPC=1)
const http = require('http');
const { loadConfig, startupSummary, missing, loadDotEnv } = require('./config');
const { createRoutes } = require('./routes');
const { ApiError, createLimiter, ipKey } = require('./lib');

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX_BODY = 10 * 1024;

const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

function createServer(cfg, routes = createRoutes(cfg)) {
  const allowed = o => (cfg.allowLocalhost !== false && LOCAL.test(o)) || cfg.webOrigins.includes(o);
  const send = (res, status, body, extra = {}) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(s);
  };
  const ipOf = req => {
    if (cfg.trustProxy) { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); if (x.length) return ipKey(x[x.length - 1]); }   // ตัวขวาสุดคือที่ proxy ของ Render เติมให้ (IPv6 ใช้ /64)
    return ipKey(req.socket.remoteAddress || '?');
  };
  const readBody = req => new Promise((resolve, reject) => {
    let n = 0, over = false; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { if (!over) { over = true; chunks.length = 0; reject(new ApiError(413, 'TOO_LARGE', 'ข้อมูลใหญ่เกินไป')); } } else if (!over) chunks.push(c); });
    req.on('end', () => {
      if (!n) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ApiError(400, 'BAD_JSON', 'รูปแบบ JSON ไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });

  const table = {
    'POST /api/signup': routes.signup, 'POST /api/login': routes.login, 'POST /api/refresh': routes.refresh, 'POST /api/forgot': routes.forgot,
    'GET /api/me': routes.getMe, 'PUT /api/me': routes.putMe,
    'GET /api/lot': routes.getLot, 'POST /api/bookings': routes.createBooking, 'POST /api/barrier': routes.barrierDown, 'POST /api/parked': routes.parked, 'POST /api/admin/barrier': routes.adminBarrier, 'POST /api/admin/barrier/raise-all': routes.adminBarrierRaiseAll,'PUT /api/admin/closed': routes.adminClosed, 'PUT /api/admin/config': routes.adminConfig, 'GET /api/admin/bookings': routes.adminBookings, 'GET /healthz': routes.health,
  };
  const rawTable = { 'GET /api/live': routes.live };   // handler ที่ตอบเอง (SSE)
  table['GET /api/me/bookings'] = routes.getMyBookings;
  // เส้นทางที่มีพารามิเตอร์ใน path (id ตรวจรูปแบบใน handler: ผิดรูป = 400 BAD_INPUT)
  const paramRoutes = [
    { method: 'POST', re: /^\/api\/bookings\/([^/]+)\/leave$/, h: routes.leaveBooking },
    { method: 'DELETE', re: /^\/api\/bookings\/([^/]+)$/, h: routes.cancelBooking },
  ];
  const apiIp = createLimiter(cfg.apiIpLimit, 60000);   // เพดาน IP ก่อนตรวจตัวตน ทุก /api/* (กันยิง JWT ปลอมรัว ๆ ไปถึง ThingsBoard)

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = {};
    if (origin) {
      if (!allowed(origin)) return send(res, 403, { error: { code: 'ORIGIN', message: 'ไม่อนุญาตให้เรียกจากเว็บนี้' } });
      Object.assign(cors, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '600', 'Access-Control-Expose-Headers': 'Retry-After' });   // ให้เว็บคนละโดเมนอ่าน Retry-After ของ 429/503 ได้ (header อื่นที่เว็บอ่านเป็น safelisted อยู่แล้ว)
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    try {
      const path = (req.url || '').split('?')[0];
      req.clientIp = ipOf(req);   // ให้ routes ใช้คีย์ IP เดียวกัน (เพดานโทเคนถูกปฏิเสธ)
      if (path.startsWith('/api/')) {
        const lim = apiIp.take(ipOf(req));
        if (!lim.ok) { const sec = Math.max(1, Math.ceil(lim.retryMs / 1000)); throw new ApiError(429, 'RATE_LIMIT', `ส่งคำขอถี่เกินไป ลองใหม่ใน ${sec} วินาที`, { 'Retry-After': String(sec) }); }
      }
      const raw = rawTable[req.method + ' ' + path];
      if (raw) { await raw(req, res, { ip: ipOf(req), cors }); return; }
      let h = table[req.method + ' ' + path], params = [];
      if (!h) {
        const pr = paramRoutes.find(r => r.method === req.method && r.re.test(path));
        if (pr) { h = pr.h; params = [safeDecode(pr.re.exec(path)[1])]; }
      }
      if (!h) {
        if (Object.keys(table).concat(Object.keys(rawTable)).some(k => k.endsWith(' ' + path)) || paramRoutes.some(r => r.re.test(path))) throw new ApiError(405, 'METHOD', 'ไม่รองรับวิธีเรียกนี้');
        throw new ApiError(404, 'NOT_FOUND', 'ไม่พบ endpoint');
      }
      const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' ? await readBody(req) : undefined;
      const out = await h(req, { body, ip: ipOf(req), params });
      send(res, out.status, out.body, cors);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }   // stream เปิดไปแล้ว ส่ง JSON error ไม่ได้
      if (e instanceof ApiError) return send(res, e.status, { error: { code: e.code, message: e.message } }, { ...cors, ...(e.extra || {}) });
      console.error('api error:', e && e.message);   // ไม่พิมพ์ header/key
      send(res, 500, { error: { code: 'INTERNAL', message: 'เกิดข้อผิดพลาดในระบบ ลองใหม่อีกครั้ง' } }, cors);
    }
  });
}

if (require.main === module) {
  loadDotEnv();   // รันในเครื่อง: อ่าน thingsboard/.env (บน Render ไม่มีไฟล์ ใช้ env ของ service)
  const cfg = loadConfig(), miss = missing(cfg);
  if (miss.length) { console.error('ขาดค่า env:', miss.join(', ')); process.exit(1); }
  startupSummary(cfg).forEach(l => (l.startsWith('คำเตือน') ? console.warn : console.log)(l));
  const routes = createRoutes(cfg), srv = createServer(cfg, routes);
  console.log('โหมดเขียนการจอง:', routes.writesEnabled ? 'เปิด (BOOKINGS_WRITE=1)' : 'ปิด (ตอบ 503 WRITES_DISABLED)');
  console.log('โหมดสั่งไม้กั้นบอร์ดจริง:', routes.barrierEnabled ? 'เปิด (BARRIER_RPC=1)' : 'ปิด (ตอบ 503 BARRIER_DISABLED ไม่ส่ง RPC)');
  // SIGTERM: รองานเขียนการจองที่ค้างให้เสร็จไม่เกิน 10 วินาที แล้วค่อยปิด (ทำซ้ำได้ ถ้าตัดกลางทางตัวซ่อมเก็บกวาด)
  process.on('SIGTERM', () => { srv.close(); routes.drain(10000).then(() => { routes.close(); process.exit(0); }); setTimeout(() => process.exit(0), 12000).unref(); });
  srv.listen(cfg.port, () => console.log('parkhere-api listening on', cfg.port));
}
module.exports = { createServer };
