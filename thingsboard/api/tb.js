// ไคลเอนต์ ThingsBoard REST: admin = ApiKey ของ tenant (เซิร์ฟเวอร์เท่านั้น), user = JWT ของผู้ใช้, anon = ไม่ต้องล็อกอิน
// header ของ API key ตามเอกสาร: X-Authorization: ApiKey <key>
const { ApiError } = require('./lib');

// opts.barrierEnabled: เทสต์ใช้เปิดกับ mock เท่านั้น (ไม่ใช้ env); ไม่ระบุ = ตาม cfg.barrierRpc (env BARRIER_RPC=1)
function createTb(cfg, fetchImpl = globalThis.fetch, opts = {}) {
  const barrierEnabled = opts.barrierEnabled !== undefined ? !!opts.barrierEnabled : !!cfg.barrierRpc;
  const apiKey = cfg.tbApiKey && (/^ApiKey /.test(cfg.tbApiKey) ? cfg.tbApiKey : 'ApiKey ' + cfg.tbApiKey);
  const sent = [];   // เวลาของคำขอที่ยิง ThingsBoard (ทุกชนิด) ย้อนหลัง 60 วิ ใช้เป็นตัววัดงบ (F-4/SR-22)
  const trim = () => { const t = Date.now(); while (sent.length && t - sent[0] >= 60000) sent.shift(); };
  const load = () => { trim(); return sent.length; };
  const count = status => { if (status === 401) return; trim(); sent.push(Date.now()); };   // คำขอที่ TB ตอบ 401 (โทเคนปลอม) ไม่นับเข้างบ: ใช้ DoS ตัวตัดงบไม่ได้ (N-1)
  async function call(path, { method = 'GET', auth, body, accept = 'application/json' } = {}) {
    const headers = { Accept: accept };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) headers['X-Authorization'] = auth;
    let r, text;
    try {
      r = await fetchImpl(cfg.tbHost + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(cfg.tbTimeoutMs) });
      text = await r.text();
    } catch (e) { count(0); throw new ApiError(502, 'UPSTREAM', 'ระบบหลังบ้านไม่ตอบสนอง ลองใหม่อีกครั้ง'); }
    count(r.status);
    let data = text; try { data = text ? JSON.parse(text) : null; } catch { /* เป็นข้อความธรรมดา */ }
    return { status: r.status, ok: r.ok, data };
  }
  const admin = (path, o) => call(path, { ...o, auth: apiKey });
  const asUser = (jwt, path, o) => call(path, { ...o, auth: 'Bearer ' + jwt });
  const anon = (path, o) => call(path, o);
  const attrPath = (uid, tail) => `/api/plugins/telemetry/USER/${encodeURIComponent(uid)}/${tail}`;
  // ส่ง RPC oneway ไปอุปกรณ์ (เส้นทางเดียวที่ API ใช้สั่งบอร์ด) ตัวป้องกันชั้นล่าง: สวิตช์ปิด = throw ก่อน fetch ไม่ว่าโค้ดข้างบนจะตรวจหรือไม่
  // (เข้มกว่าแผน 4.7 เล็กน้อย: ปิด = ห้ามแม้ host เป็น mock เพื่อพิสูจน์ RPC 0 ครั้งได้ เทสต์ต้องเปิดเองผ่าน opts)
  // 504/409 จาก ThingsBoard = บอร์ดไม่ออนไลน์ (ตามสัญญา BOARD_API) -> BOARD_OFFLINE 502; อย่างอื่นที่ไม่ ok -> UPSTREAM 502
  async function rpcOneway(deviceId, { method, params } = {}, timeoutMs = 10000) {
    if (!barrierEnabled) throw new ApiError(503, 'BARRIER_DISABLED', 'ยังไม่เปิดให้สั่งไม้กั้น');
    if (typeof deviceId !== 'string' || !/^[\w-]{1,64}$/.test(deviceId) || typeof method !== 'string' || !/^\w{1,40}$/.test(method)) throw new ApiError(400, 'BAD_INPUT', 'คำสั่งบอร์ดไม่ถูกต้อง');
    const r = await admin(`/api/rpc/oneway/${encodeURIComponent(deviceId)}`, { method: 'POST', body: { method, params: params === undefined ? {} : params, timeout: timeoutMs } });
    if (r.status === 504 || r.status === 409) throw new ApiError(502, 'BOARD_OFFLINE', 'ส่งคำสั่งไปไม้กั้นไม่ได้ (บอร์ดไม่ออนไลน์) ลองอีกครั้ง');
    if (!r.ok) throw new ApiError(502, 'UPSTREAM', 'ระบบหลังบ้านไม่ตอบสนอง ลองใหม่อีกครั้ง');
    return { status: r.status };
  }
  return {
    admin, asUser, anon, load, rpcOneway, barrierEnabled,
    // user attributes (SERVER_SCOPE) ของผู้ใช้คนนั้นเท่านั้น
    async readAttrs(uid, keys) {
      const r = await admin(attrPath(uid, 'values/attributes/SERVER_SCOPE?keys=' + keys.map(encodeURIComponent).join(',')));
      if (!r.ok) throw new ApiError(502, 'UPSTREAM', 'อ่านข้อมูลผู้ใช้ไม่สำเร็จ');
      const out = {};
      for (const a of Array.isArray(r.data) ? r.data : []) out[a.key] = a.value;
      return out;
    },
    // asset ParkHere-Data (bk_* ของการจอง): อ่านสดเฉพาะคีย์ที่ระบุ (ไม่ผ่าน cache ของ lot) คีย์ผ่าน encodeURIComponent เสมอ
    async readAssetAttrs(keys) {
      const r = await admin(`/api/plugins/telemetry/ASSET/${encodeURIComponent(cfg.assetId)}/values/attributes/SERVER_SCOPE?keys=` + keys.map(encodeURIComponent).join(','));
      if (!r.ok || !Array.isArray(r.data)) throw new ApiError(502, 'UPSTREAM', 'อ่านข้อมูลการจองไม่สำเร็จ');
      const out = {};
      for (const a of r.data) if (a && typeof a.key === 'string') out[a.key] = a.value;
      return out;
    },
    async writeAssetAttrs(obj) {
      const r = await admin(`/api/plugins/telemetry/ASSET/${encodeURIComponent(cfg.assetId)}/attributes/SERVER_SCOPE`, { method: 'POST', body: obj });
      if (!r.ok) throw new ApiError(502, 'UPSTREAM', 'บันทึกข้อมูลการจองไม่สำเร็จ');
    },
    // ผู้ใช้ใน customer หนึ่ง (GET /api/customer/{id}/users) คืน [{uid, name}] เท่านั้น (ไม่คืนอีเมล) อ่านไม่ได้ = 502 ไม่คืนรายการว่างเงียบๆ
    async listCustomerUsers(customerId) {
      const out = [];
      for (let page = 0; page < 5; page++) {
        const r = await admin(`/api/customer/${encodeURIComponent(customerId)}/users?pageSize=100&page=${page}`);
        if (!r.ok || !r.data || !Array.isArray(r.data.data)) throw new ApiError(502, 'UPSTREAM', 'อ่านรายชื่อผู้ใช้ไม่สำเร็จ');
        for (const u of r.data.data) if (u && u.id && typeof u.id.id === 'string') out.push({ uid: u.id.id, name: typeof u.firstName === 'string' ? u.firstName.slice(0, 40) : '' });
        if (!r.data.hasNext) break;
      }
      return out;
    },
    async writeAttrs(uid, obj) {
      const r = await admin(attrPath(uid, 'attributes/SERVER_SCOPE'), { method: 'POST', body: obj });
      if (!r.ok) throw new ApiError(502, 'UPSTREAM', 'บันทึกข้อมูลผู้ใช้ไม่สำเร็จ');
    },
  };
}
module.exports = { createTb };
