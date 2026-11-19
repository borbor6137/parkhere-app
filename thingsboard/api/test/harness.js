// ตัวช่วยทดสอบ M2: mock ThingsBoard + API จริงในโปรเซส + ไคลเอนต์ SSE (ไม่แตะของจริง)
const assert = require('node:assert/strict');
const { createMockTb, KEY, DEVICE_ID, ASSET_ID } = require('./mock-tb');
const { loadConfig } = require('../config');
const { createServer } = require('../server');
const { createRoutes } = require('../routes');

const MEMBERS = 'members-cust', STAFF = 'staff-cust', WEB = 'https://parkhere.example.onrender.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 2000, step = 10) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout รอเงื่อนไข'); await sleep(step); } };

async function setup(envOver = {}, opts = {}) {
  const mock = createMockTb({ membersId: MEMBERS, staffId: STAFF });
  const tbPort = await mock.listen();
  const cfg = loadConfig({ TB_HOST: 'http://127.0.0.1:' + tbPort, TB_API_KEY: KEY, TB_CUSTOMER_MEMBERS_ID: MEMBERS, TB_CUSTOMER_STAFF_ID: STAFF, WEB_ORIGINS: WEB,
    TB_ASSET_ID: ASSET_ID, TB_SENSOR_DEVICE_ID: DEVICE_ID, LIVE_POLL_MS: '40', LOT_ATTR_MS: '80', LOT_CACHE_MS: '300', LIVE_PING_MS: '100', ...envOver });
  const routes = createRoutes(cfg, undefined, opts.now, { writesEnabled: opts.writesEnabled, barrierEnabled: opts.barrierEnabled, barrierLog: opts.barrierLog, barrierTimers: opts.barrierTimers, adminLog: opts.adminLog });
  const srv = createServer(cfg, routes);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  let n = 0;
  const call = async (method, path, { body, token, headers = {} } = {}) => {
    const h = { 'X-Forwarded-For': `10.1.0.${++n}`, ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j, headers: r.headers, raw: t };
  };
  const member = async email => { const r = await call('POST', '/api/signup', { body: { email, password: 'Passw0rd!x', name: 'ทดสอบ' } }); assert.equal(r.status, 201); return { token: r.body.token, uid: r.body.user.id }; };
  // ไคลเอนต์ SSE แบบ fetch-streaming + Bearer (แบบเดียวกับที่ frontend ต้องใช้)
  const sse = async (token, { headers = {} } = {}) => {
    const ac = new AbortController();
    const r = await fetch(base + '/api/live', { headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'X-Forwarded-For': `10.2.0.${++n}`, ...headers }, signal: ac.signal });
    const c = { status: r.status, headers: r.headers, events: [], ended: false, ac };
    if (r.status !== 200) { c.body = await r.json(); return c; }
    (async () => {
      const dec = new TextDecoder(); let buf = '';
      try {
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block), d = /^data: (.+)$/m.exec(block);
            if (ev && d) c.events.push({ event: ev[1], data: JSON.parse(d[1]) });
          }
        }
      } catch { /* abort */ }
      c.ended = true;
    })();
    c.of = name => c.events.filter(e => e.event === name);
    c.wait = (name, pred = () => true, ms = 2000) => until(() => c.events.find(e => e.event === name && pred(e.data)), ms);
    c.close = () => ac.abort();
    return c;
  };
  return { mock, cfg, routes, call, member, sse, base, close: async () => { routes.close(); srv.closeAllConnections(); await new Promise(r => srv.close(r)); await mock.close(); } };
}
const run = (fn, env, opts) => async () => { const s = await setup(env, opts); try { await fn(s); } finally { await s.close(); } };
const slotOf = (lot, k) => lot.slots.find(x => x.k === k);


module.exports = { setup, run, sleep, until, slotOf, MEMBERS, STAFF, WEB };
