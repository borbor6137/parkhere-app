// ParkHere bridge: ThingsBoard <-> Firebase
//   ThingsBoard -> Firebase : ค่าช่องจอด slot_{ชั้น}-{ช่อง} -> /sensors, ไม้กั้น bar_{ชั้น}-{ช่อง} -> /barrier/{k}/state, hb -> /status/lastSeen
//   Firebase -> ThingsBoard : /barrier/{k}/cmd (ผู้ใช้กดลดไม้กั้น) และ state ที่แอดมินสั่ง -> RPC setBarrier ไปที่บอร์ด
// รันบน Render (Web Service) หรือในคอมก็ได้: ตั้งค่าผ่าน environment variables (ดู README.md)
const http = require('http');
const { createCore } = require('./bridge-core');
const firebase = require('firebase/compat/app');
require('firebase/compat/auth');
require('firebase/compat/database');

const env = (k, d) => process.env[k] ?? d;
const CFG = {
  tbHost: env('TB_HOST', 'https://thingsboard.cloud').replace(/\/+$/, ''),
  tbApiKey: env('TB_API_KEY'),                                 // แนะนำ: ThingsBoard -> Profile -> API keys (ไม่ต้องใช้รหัสผ่าน)
  tbUser: env('TB_USER'), tbPass: env('TB_PASS'),              // หรือใช้อีเมล/รหัสผ่านแทน
  sensorDev: env('TB_SENSOR_DEVICE_ID'),                       // อุปกรณ์ที่ส่งค่าช่องจอด (กล้อง Edge Impulse / เซนเซอร์)
  barrierDev: env('TB_BARRIER_DEVICE_ID') || env('TB_SENSOR_DEVICE_ID'),   // อุปกรณ์ที่คุมไม้กั้น (ใช้ตัวเดียวกันได้)
  fbEmail: env('FB_EMAIL', 'board@parkhere.com'), fbPass: env('FB_PASSWORD'),
  pollMs: +env('POLL_MS', 1000),
  autoRaiseMs: +env('AUTO_RAISE_MS', 60000),                  // ลดไม้กั้นแล้วรถไม่เข้าภายในเวลานี้ -> ยกกลับ
  userCmd: env('BRIDGE_USER_CMD', '0') === '1',               // 1 = รับ barrier/{k}/cmd จากผู้ใช้ไปสั่ง RPC (ปิดเมื่อ parkhere-api คุมไม้กั้น)
  autoRaise: env('BRIDGE_AUTO_RAISE', '0') === '1',           // 1 = ยกอัตโนมัติเมื่อรถออก/หมดเวลา (ปิดเมื่อ parkhere-api ทำแทน)
  port: +env('PORT', 10000),
  selfUrl: env('RENDER_EXTERNAL_URL'),                        // Render ใส่ให้เอง ใช้ปลุกตัวเองไม่ให้หลับ (free plan)
};
const missing = ['sensorDev', 'fbPass'].filter(k => !CFG[k]);
if (!CFG.tbApiKey && !(CFG.tbUser && CFG.tbPass)) missing.push('TB_API_KEY (หรือ TB_USER+TB_PASS)');
if (missing.length) { console.error('ขาดค่า env:', missing.join(', '), '(ดู README.md)'); process.exit(1); }

firebase.initializeApp({
  apiKey: 'AIzaSyAMkBSw1NRgaBwJXAgYYcMxf5rfbUzX9jI', authDomain: 'parkhere-7c639.firebaseapp.com',
  databaseURL: 'https://parkhere-7c639-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'parkhere-7c639', appId: '1:651826324438:web:63208a62cad63859d67a77',
});
const db = firebase.database(), TS = firebase.database.ServerValue.TIMESTAMP;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const stats = { started: Date.now(), tbOk: false, fbOk: false, lastTelemetry: 0, rpcSent: 0, errors: 0, lastError: '' };
const fail = (where, e) => { stats.errors++; stats.lastError = where + ': ' + (e && e.message || e); log('⚠', stats.lastError); };

// ---------- ThingsBoard REST ----------
let tbToken = null, tbTokenAt = 0;
async function tbLogin() {
  const r = await fetch(CFG.tbHost + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: CFG.tbUser, password: CFG.tbPass }) });
  if (!r.ok) throw new Error('TB login ' + r.status);
  tbToken = (await r.json()).token; tbTokenAt = Date.now(); log('ThingsBoard login ok');
}
async function tb(path, opt = {}) {
  const key = CFG.tbApiKey && (/^ApiKey /.test(CFG.tbApiKey) ? CFG.tbApiKey : 'ApiKey ' + CFG.tbApiKey);
  if (!key && (!tbToken || Date.now() - tbTokenAt > 6e6)) await tbLogin();   // token อายุ ~2.5 ชม. ต่ออายุทุก 100 นาที
  const go = () => fetch(CFG.tbHost + path, { ...opt, headers: { 'Content-Type': 'application/json', 'X-Authorization': key || 'Bearer ' + tbToken, ...(opt.headers || {}) } });
  let r = await go();
  if (r.status === 401 && !key) { await tbLogin(); r = await go(); }
  if (r.status === 401) throw new Error('ThingsBoard ปฏิเสธการเข้าถึง (ตรวจ TB_API_KEY / TB_USER / TB_PASS)');
  return r;
}
async function rpcBarrier(k, down, why) {
  const r = await tb('/api/plugins/rpc/oneway/' + CFG.barrierDev, { method: 'POST', body: JSON.stringify({ method: 'setBarrier', params: { slot: k, down }, timeout: 10000 }) });
  stats.rpcSent++;
  log('RPC setBarrier', k, down ? 'ลด' : 'ยก', '(' + why + ')', r.ok ? 'ok' : 'HTTP ' + r.status);
  if (!r.ok) throw new Error('RPC ' + r.status + (r.status === 504 || r.status === 409 ? ' (บอร์ดไม่ออนไลน์)' : ''));
}
const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

// ---------- สถานะที่จำไว้ ----------
// BRIDGE_USER_CMD / BRIDGE_AUTO_RAISE: ค่าเริ่มต้น 0 (ปิด) เพราะ parkhere-api รับช่วงแล้ว ตั้ง 1 เพื่อย้อนกลับพฤติกรรมเดิม (M4 ข้อ 4.9)
const core = createCore({ userCmd: CFG.userCmd, autoRaise: CFG.autoRaise, autoRaiseMs: CFG.autoRaiseMs, rpc: rpcBarrier, fail });
const { occ, bar, seenCmd, seenAdmin } = core;
let fbBarrier = {}, serverOffset = 0;

// ThingsBoard -> Firebase (poll ค่าล่าสุดของอุปกรณ์)
async function pollDevice(devId) {
  const r = await tb('/api/plugins/telemetry/DEVICE/' + devId + '/values/timeseries');
  if (!r.ok) throw new Error('telemetry ' + r.status);
  const data = await r.json(); stats.tbOk = true;
  for (const [key, arr] of Object.entries(data)) {
    const { ts, value } = arr[0] || {};
    if (ts > stats.lastTelemetry) stats.lastTelemetry = ts;
    let m;
    if ((m = key.match(/^slot_(\d+-\d+)$/))) {
      const k = m[1], v = truthy(value);
      const ch = core.onSlot(k, v); if (!ch) continue;
      await db.ref('sensors/' + k).set({ occ: v, t: TS });
      log('ช่อง', k, v ? 'มีรถ' : 'ว่าง');
      core.afterSlot(k, v, ch.was);
    } else if ((m = key.match(/^bar_(\d+-\d+)$/))) {
      const k = m[1], st = core.onBar(k, truthy(value)); if (!st) continue;
      await db.ref('barrier/' + k + '/state').set({ ...st, t: TS });
      log('ไม้กั้น', k, st.down ? 'ลดแล้ว' : 'ยกแล้ว');
    }
  }
}
async function heartbeat() {   // อุปกรณ์ส่งค่าภายใน 90 วิ = ออนไลน์ -> แอปขึ้น "เซนเซอร์/กล้องออนไลน์"
  if (stats.lastTelemetry && Date.now() - stats.lastTelemetry < 9e4) await db.ref('status/lastSeen').set(TS);
}

// Firebase -> ThingsBoard
function onBarrier(all) { fbBarrier = all || {}; core.onBarrier(fbBarrier, Date.now() + serverOffset); }

// ---------- เริ่มทำงาน ----------
async function main() {
  await firebase.auth().signInWithEmailAndPassword(CFG.fbEmail, CFG.fbPass);
  stats.fbOk = true; log('Firebase login ok:', CFG.fbEmail);
  db.ref('.info/serverTimeOffset').on('value', s => serverOffset = +s.val() || 0);
  // จำค่าเดิมก่อน จะได้ไม่ส่งคำสั่งเก่าที่ค้างอยู่ซ้ำตอนเปิด bridge
  const first = (await db.ref('barrier').once('value')).val() || {};
  for (const [k, v] of Object.entries(first)) { seenCmd[k] = (v && v.cmd && v.cmd.t) || 0; seenAdmin[k] = (v && v.state && v.state.t) || 0; }
  db.ref('barrier').on('value', s => onBarrier(s.val()), e => fail('listen barrier', e));
  const chk = await tb('/api/device/' + CFG.sensorDev);   // ทดสอบสิทธิ์ + device id ตั้งแต่ตอนเริ่ม
  if (!chk.ok) throw new Error('อ่าน device ' + CFG.sensorDev + ' ไม่ได้ (HTTP ' + chk.status + ')');
  stats.tbOk = true; log('ThingsBoard ok: device', (await chk.json()).name);
  const devs = [...new Set([CFG.sensorDev, CFG.barrierDev])];
  let busy = false;
  setInterval(async () => {
    if (busy) return; busy = true;
    try { for (const d of devs) await pollDevice(d); } catch (e) { stats.tbOk = false; fail('poll', e); }
    busy = false;
  }, CFG.pollMs);
  setInterval(() => heartbeat().catch(e => fail('heartbeat', e)), 20000);
  log('สวิตช์ BRIDGE_USER_CMD=' + +CFG.userCmd, 'BRIDGE_AUTO_RAISE=' + +CFG.autoRaise);
  log('bridge พร้อมทำงาน · poll ทุก', CFG.pollMs, 'ms · อุปกรณ์', devs.join(', '));
}

// หน้าเช็กสถานะ (Render ต้องมี HTTP port) + ปลุกตัวเองทุก 10 นาที ไม่ให้ free plan หลับ
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ service: 'parkhere-bridge', uptimeSec: Math.round((Date.now() - stats.started) / 1000), ...stats, lastTelemetry: stats.lastTelemetry ? new Date(stats.lastTelemetry).toISOString() : null, occ, barrier: bar }, null, 2));
}).listen(CFG.port, () => log('HTTP status on port', CFG.port));
if (CFG.selfUrl) setInterval(() => fetch(CFG.selfUrl).catch(() => {}), 10 * 60 * 1000);

main().catch(e => { fail('start', e); process.exit(1); });
