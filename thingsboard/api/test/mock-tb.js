// mock ThingsBoard สำหรับทดสอบ (ไม่แตะของจริง)
const http = require('http');
const crypto = require('crypto');

const KEY = 'mock-admin-key', GROUP = 'g-customer-users', DEVICE_ID = 'dev-lot', SIM_ID = 'dev-sim', ASSET_ID = 'asset-data';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub, ttlSec) => `${b64({ alg: 'HS512' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + ttlSec })}.sig${crypto.randomBytes(4).toString('hex')}`;

// now: ฟังก์ชันเวลาที่ฉีดได้ (ใช้กับ setTel และเวลาของบันทึก RPC); ไม่ใส่ = Date.now
function createMockTb({ membersId, staffId, now = () => Date.now() }) {
  const st = { users: new Map(), byEmail: new Map(), attrs: new Map(), tokens: new Map(), refresh: new Map(), act: new Map(), calls: [], resetFor: [], mailSent: [], groupMembers: new Set(), authUserCalls: 0, devs: { [DEVICE_ID]: {}, [SIM_ID]: {} }, failDev: {}, devCalls: {}, assetAttrs: {}, telCalls: 0, attrCalls: 0, failTel: 0, failAttr: 0, writes: [], failActivateWith: null, failCreateWith: null,
    // M3: นับ/ฉีดความล้มเหลวของการเขียน attribute (asset + user) แยกจากการอ่าน
    wr: [], userAttrReads: 0, failWrite: null, delay: null,
    // M4: RPC oneway ที่รับ (rpc), ตัวกำหนดผลต่อครั้ง rpcMode(info)->{status?,delay?} (ไม่ตั้ง = 200 ทันที), rpcApply=true ให้ผลสะท้อนเป็น bar_ ของอุปกรณ์นั้น
    rpc: [], rpcMode: null, rpcApply: false };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => (raw += c));
    req.on('end', () => { const go = () => {
      const url = new URL(req.url, 'http://x'), p = url.pathname, body = raw ? JSON.parse(raw) : undefined;
      const auth = req.headers['x-authorization'] || '';
      st.calls.push({ method: req.method, path: p, auth: auth.split(' ')[0] });
      const out = (code, data) => { res.writeHead(code, { 'Content-Type': typeof data === 'string' ? 'text/plain' : 'application/json' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
      const isAdmin = auth === 'ApiKey ' + KEY;
      const pair = u => { const t = jwt(u.id.id, 9000), r = jwt(u.id.id, 90000); st.tokens.set(t, u.id.id); st.refresh.set(r, u.id.id); return { token: t, refreshToken: r }; };
      let m;
      if (p === '/api/user' && req.method === 'POST') {
        if (!isAdmin) return out(401, { message: 'Authentication failed' });
        if (st.failCreateWith) return out(st.failCreateWith.status, { message: st.failCreateWith.message, subscriptionErrorCode: st.failCreateWith.sub || null });
        if (st.byEmail.has(body.email)) return out(400, { message: `User with email '${body.email}' already present in database!` });
        const u = { id: { id: crypto.randomUUID(), entityType: 'USER' }, email: body.email, firstName: body.firstName, authority: 'CUSTOMER_USER', customerId: body.customerId, password: null };
        st.users.set(u.id.id, u); st.byEmail.set(u.email, u);
        if (url.searchParams.get('entityGroupId') === GROUP) st.groupMembers.add(u.id.id);
        const tok = crypto.randomBytes(8).toString('hex'); st.act.set(tok, u.id.id);
        return out(200, { id: u.id, email: u.email });
      }
      if ((m = /^\/api\/user\/([^/]+)\/activationLink$/.exec(p))) {
        if (!isAdmin) return out(401, {});
        const tok = [...st.act].find(([, id]) => id === m[1]); return tok ? out(200, `https://mock/api/noauth/activate?activateToken=${tok[0]}`) : out(404, {});
      }
      if ((m = /^\/api\/user\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
        if (!isAdmin) return out(401, {});
        const u = st.users.get(m[1]); if (u) { st.users.delete(m[1]); st.byEmail.delete(u.email); } return out(200, '');
      }
      if (p === '/api/noauth/activate') {
        if (st.failActivateWith) return out(400, { message: st.failActivateWith });
        const id = st.act.get(body.activateToken); if (!id) return out(400, { message: 'Invalid activation token' });
        const u = st.users.get(id); u.password = body.password; return out(200, pair(u));
      }
      if (p === '/api/auth/login') {
        const u = st.byEmail.get(body.username);
        if (!u || u.password !== body.password) return out(401, { message: 'Invalid username or password', errorCode: 10 });
        return out(200, pair(u));
      }
      if (p === '/api/auth/token') {
        const id = st.refresh.get(body.refreshToken); if (!id) return out(401, { message: 'Invalid token', errorCode: 11 });
        return out(200, pair(st.users.get(id)));
      }
      // เลียน PE: ตอบ 200 เสมอ แต่ส่งอีเมลจริงเฉพาะผู้ใช้ที่อยู่ใน group (ไม่งั้นไม่มีสิทธิ์ PROFILE:WRITE แล้ว TB กลืน error)
      if (p === '/api/noauth/resetPasswordByEmail') { st.resetFor.push(body.email); const u = st.byEmail.get(body.email); if (u && st.groupMembers.has(u.id.id)) st.mailSent.push(body.email); return out(200, ''); }
      if ((m = /^\/api\/entityGroups\/CUSTOMER\/([^/]+)\/USER$/.exec(p))) {
        if (!isAdmin) return out(401, {});
        return out(200, [{ name: 'All', id: { id: 'g-all' } }, { name: 'Customer Users', id: { id: GROUP } }]);
      }
      if (req.method === 'POST' && (m = /^\/api\/entityGroup\/([^/]+)\/addEntities$/.exec(p))) {
        if (!isAdmin) return out(401, {});
        if (m[1] !== GROUP) return out(404, { message: 'group not found' });
        for (const id of body) st.groupMembers.add(id); return out(200, '');
      }
      // M4: RPC oneway (เส้นทางใหม่ /api/rpc/oneway และเส้นทางเดิม /api/plugins/rpc/oneway) ไม่ต่อ ThingsBoard จริง
      if (req.method === 'POST' && (m = /^\/api\/(?:plugins\/)?rpc\/oneway\/([^/]+)$/.exec(p))) {
        const dev = decodeURIComponent(m[1]);
        const info = { dev, method: body && body.method, params: body && body.params, slot: body && body.params && body.params.slot, down: body && body.params && body.params.down, auth: auth.split(' ')[0], at: now(), n: st.rpc.length + 1, body };
        st.rpc.push(info);
        if (!isAdmin) return out(401, {});
        if (!st.devs[dev]) return out(404, { message: 'device not found' });
        const mode = (st.rpcMode && st.rpcMode(info)) || {};
        const finish = () => {
          const status = mode.status || 200; info.status = status;
          if (status === 200 && st.rpcApply && info.method === 'setBarrier' && typeof info.slot === 'string') st.devs[dev]['bar_' + info.slot] = [{ ts: now(), value: info.down ? '1' : '0' }];
          return out(status, status === 200 ? '' : { message: status === 504 ? 'Request timeout' : 'rpc fail' });
        };
        return mode.delay ? setTimeout(finish, mode.delay) : finish();
      }
      // M2: อุปกรณ์ ParkHere-Lot และ asset ParkHere-Data (อ่านอย่างเดียว; เขียนผ่านเมธอด setTel/setAttr ของเทสต์เท่านั้น)
      if ((m = /^\/api\/plugins\/telemetry\/DEVICE\/([^/]+)\/values\/timeseries$/.exec(p))) {
        if (!isAdmin) return out(401, {});
        st.telCalls++; if (st.failTel) return out(st.failTel, { message: 'boom' });
        st.devCalls[m[1]] = (st.devCalls[m[1]] || 0) + 1; if (st.failDev[m[1]]) return out(st.failDev[m[1]], { message: 'boom' });
        if (!st.devs[m[1]]) return out(404, {});
        return out(200, st.devs[m[1]]);
      }
      // ตัวช่วยเขียน attribute: นับ ฉีดความล้มเหลว (ตัวเลข = ล้มโดยไม่เขียน, {status,apply:true} = เขียนแล้วแต่ตอบ error เหมือนคำตอบหาย)
      const doWrite = (entity, id, apply) => {
        const info = { entity, id, keys: Object.keys(body || {}), n: st.wr.length + 1, body };
        const f = st.failWrite && st.failWrite(info);
        st.wr.push({ entity, id, keys: info.keys, status: f ? (f.status || f) : 200 });
        if (f && !f.apply) return out(f.status || f, { message: 'boom' });
        apply(); return f ? out(f.status, { message: 'boom' }) : out(200, '');
      };
      if ((m = /^\/api\/plugins\/telemetry\/ASSET\/([^/]+)\/(values\/attributes|attributes)\/SERVER_SCOPE$/.exec(p))) {
        if (!isAdmin) return out(401, {});
        if (req.method === 'POST' && m[2] === 'attributes') {
          if (m[1] !== ASSET_ID) return out(404, {});
          return doWrite('ASSET', m[1], () => { for (const [k, v] of Object.entries(body)) st.assetAttrs[k] = v; });
        }
        if (req.method !== 'GET' || m[2] !== 'values/attributes') { st.writes.push(p); return out(405, {}); }
        st.attrCalls++; if (st.failAttr) return out(st.failAttr, { message: 'boom' });
        if (m[1] !== ASSET_ID) return out(404, {});
        const want = url.searchParams.get('keys');
        const keys = want ? want.split(',') : null;
        return out(200, Object.entries(st.assetAttrs).filter(([key]) => !keys || keys.includes(key)).map(([key, value]) => ({ key, value, lastUpdateTs: 1 })));
      }
      // M5: รายชื่อผู้ใช้ของ customer (ใช้ใน GET /api/admin/bookings) นับด้วย st.userListCalls ฉีดล้มด้วย st.failUserList (เลข status)
      if (req.method === 'GET' && (m = /^\/api\/customer\/([^/]+)\/users$/.exec(p))) {
        if (!isAdmin) return out(401, {});
        st.userListCalls = (st.userListCalls || 0) + 1; if (st.failUserList) return out(st.failUserList, { message: 'boom' });
        const data = [...st.users.values()].filter(u => u.customerId && u.customerId.id === decodeURIComponent(m[1])).map(u => ({ id: u.id, email: u.email, firstName: u.firstName, authority: u.authority, customerId: u.customerId }));
        return out(200, { data, totalPages: 1, totalElements: data.length, hasNext: false });
      }
      if (p === '/api/auth/user') {
        st.authUserCalls++;
        const id = st.tokens.get(auth.replace('Bearer ', '')); if (!id) return out(401, { message: 'Authentication failed', errorCode: 10 });
        const u = st.users.get(id); return out(200, { id: u.id, email: u.email, firstName: u.firstName, authority: u.authority, customerId: u.customerId });
      }
      if ((m = /^\/api\/plugins\/telemetry\/USER\/([^/]+)\/(values\/attributes|attributes)\/SERVER_SCOPE$/.exec(p))) {
        if (!isAdmin) return out(401, {});
        const store = st.attrs.get(m[1]) || {};
        if (req.method === 'POST') return doWrite('USER', m[1], () => st.attrs.set(m[1], { ...store, ...body }));
        st.userAttrReads++;
        const keys = (url.searchParams.get('keys') || '').split(',');
        return out(200, keys.filter(k => k in store).map(k => ({ key: k, value: store[k], lastUpdateTs: 1 })));
      }
      out(404, { message: 'not found ' + p });
    }; const d = st.delay ? st.delay() : 0; if (d) setTimeout(go, d); else go(); });
  });
  return {
    st, KEY, membersId, staffId,
    // ตั้งค่า telemetry ล่าสุดของบอร์ด: setTel({'slot_1-2': true, hb: 1}, ts) ค่าเป็นสตริงแบบที่ TB คืนจริง
    setTel(o, ts = now(), dev = DEVICE_ID) { const d = st.devs[dev]; for (const [k, v] of Object.entries(o)) { if (v === undefined) delete d[k]; else d[k] = [{ ts, value: String(v) }]; } },
    setAttr(k, v) { if (v === undefined) delete st.assetAttrs[k]; else st.assetAttrs[k] = v; },
    // ผู้ใช้ที่ไม่อยู่ใน customer ของแอป (ไว้ทดสอบ 403)
    addOutsider() { const u = { id: { id: crypto.randomUUID(), entityType: 'USER' }, email: 'x@y.co', authority: 'CUSTOMER_USER', customerId: { id: 'other' } }; st.users.set(u.id.id, u); const t = jwt(u.id.id, 900); st.tokens.set(t, u.id.id); return t; },
    // นับ RPC ที่ mock รับ (นับทุกครั้งที่ถึง รวมที่ตอบ 504): rpcCount() ทั้งหมด, rpcCount(dev) ต่ออุปกรณ์, rpcCount(dev, slot) ต่อช่อง
    rpcCount(dev, slot) { return st.rpc.filter(r => (dev === undefined || r.dev === dev) && (slot === undefined || r.slot === slot)).length; },
    makeToken: (sub, ttl) => jwt(sub, ttl),
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  };
}
module.exports = { createMockTb, KEY, GROUP, DEVICE_ID, SIM_ID, ASSET_ID };
