// อ่านค่าตั้งจาก env (ไม่มี secret ในไฟล์นี้)
const fs = require('fs');
const path = require('path');

// ไฟล์ .env ของ api อยู่ที่ thingsboard/.env (ขึ้นจาก api/ หนึ่งชั้น) ไม่ใช่ api/.env
const ENV_FILE = path.join(__dirname, '..', '.env');

// โหลด .env เข้า process.env โดยไม่พิมพ์ค่า (ค่าที่มีอยู่แล้วใน env ชนะ)
// required=true: ไม่พบไฟล์ให้ throw พร้อม path ที่หา (เทสต์จริง) / false: ข้ามได้ (Render ใช้ env ของ service ไม่มีไฟล์)
function loadDotEnv(file = ENV_FILE, required = false) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error('ไม่พบไฟล์ .env ที่: ' + file);
    return false;
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2]; if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined && val !== '') process.env[m[1]] = val;
  }
  return true;
}

// อุปกรณ์ที่ส่งสถานะช่อง: TB_SENSOR_DEVICE_ID (เดิม = 'lot'), TB_SIM_DEVICE_ID (= 'sim'), TB_SENSOR_DEVICE_IDS (คั่นจุลภาค = dev1, dev2, ...)
// ซ้ำ/ว่างถูกข้าม; ไม่ตั้งตัวไหนเลย = [] (ลานจอด 503 NOT_CONFIGURED); ไม่ตั้ง SIM = ข้ามได้ ไม่ error
function parseDevices(env) {
  const out = [], seen = new Set();
  const add = (name, id) => { id = String(id || '').trim(); if (id && !seen.has(id) && !out.some(d => d.name === name)) { seen.add(id); out.push({ name, id }); } };
  add('lot', env.TB_SENSOR_DEVICE_ID);
  add('sim', env.TB_SIM_DEVICE_ID);
  String(env.TB_SENSOR_DEVICE_IDS || '').split(',').forEach((id, n) => add('dev' + (n + 1), id));
  return out;
}

// เกณฑ์ "ไม่มีสัญญาณ" รายอุปกรณ์ (env เป็นวินาที -> ms): Sim (Wokwi) ส่ง hb ทุก 60 วิ -> 150; บอร์ดจริง (Lot) ส่งทุก 20 วิ -> 90
// อุปกรณ์อื่น (dev1, dev2, ...) ใช้ค่าของ Lot; ค่าไม่ใช่เลข 5..86400 = ใช้ค่า default
function offlineMsFrom(env) {
  const sec = (v, d) => { const n = Number(v); return (v !== undefined && v !== '' && Number.isFinite(n) && n >= 5 && n <= 86400 ? n : d) * 1000; };
  const lot = sec(env.TB_LOT_OFFLINE_S, 90);
  return { lot, sim: sec(env.TB_SIM_OFFLINE_S, 150), other: lot };
}

// แมปช่อง -> อุปกรณ์ (config): SLOT_DEVICE_MAP="1-1=lot,2-3=sim" (ไม่ตั้ง = {'1-1':'lot'}); SLOT_DEVICE_DEFAULT = อุปกรณ์ของช่องที่เหลือ (ไม่ตั้ง = sim ถ้ามี TB_SIM_DEVICE_ID ไม่งั้น lot)
// ชื่ออุปกรณ์ที่รับ: lot | sim | dev1.. (ไม่สนตัวพิมพ์ใหญ่เล็ก; trim ช่องว่างและอัญประกาศที่ครอบทั้งค่า/แต่ละรายการ)
// FAIL-CLOSED (D1-1): มีรายการใดผิดรูป (คีย์ช่องผิด/ชื่ออุปกรณ์ไม่รู้จัก/มี ; ติดมา) = ทิ้งทั้งแมป ใช้ค่าเริ่มต้น {'1-1':'lot'} + คำเตือน
// ไม่ให้แมปว่างจนช่อง 1-1 (บอร์ดจริง) ตกเป็นของ Sim; ถ้าแมปถูกต้องแต่ไม่มี 1-1 จะเติม 1-1=lot ให้; คำเตือนไม่ใส่ค่า env
const unq = v => { let t = String(v == null ? '' : v).trim(); while (t.length >= 2 && /^["'`]/.test(t) && t[t.length - 1] === t[0]) t = t.slice(1, -1).trim(); return t; };
function parseSlotMapChecked(env) {
  const DEF = { '1-1': 'lot' }, raw = unq(env.SLOT_DEVICE_MAP);
  if (raw === '') return { map: DEF, warn: [] };
  const out = {};
  for (const part of raw.split(',')) {
    const t = unq(part);
    if (t === '') continue;
    const m = /^(\d{1,2}-\d{1,3})\s*=\s*(.*)$/.exec(t), dev = m ? unq(m[2]).toLowerCase() : '';
    if (!m || !/^(lot|sim|dev\d{1,2})$/.test(dev)) return { map: DEF, warn: ['SLOT_DEVICE_MAP อ่านไม่ได้ (รูปแบบที่ถูก: 1-1=lot,2-0=sim) ใช้ค่าเริ่มต้น 1-1=lot แทน'] };
    out[m[1]] = dev;
  }
  if (!Object.keys(out).length) return { map: DEF, warn: ['SLOT_DEVICE_MAP ไม่มีรายการที่ใช้ได้ ใช้ค่าเริ่มต้น 1-1=lot แทน'] };
  if (!out['1-1']) out['1-1'] = 'lot';
  return { map: out, warn: [] };
}
function parseSlotMap(env) { return parseSlotMapChecked(env).map; }
function parseSlotDefaultChecked(env) {
  const raw = unq(env.SLOT_DEVICE_DEFAULT), v = raw.toLowerCase(), fb = String(env.TB_SIM_DEVICE_ID || '').trim() ? 'sim' : 'lot';
  if (raw === '') return { dev: fb, warn: [] };
  if (/^(lot|sim|dev\d{1,2})$/.test(v)) return { dev: v, warn: [] };
  return { dev: fb, warn: ['SLOT_DEVICE_DEFAULT อ่านไม่ได้ (ใช้ lot|sim|devN) ใช้ค่าเริ่มต้น ' + fb + ' แทน'] };
}
function parseSlotDefault(env) { return parseSlotDefaultChecked(env).dev; }

// บรรทัดสรุปโหมดตอนสตาร์ต (ค่าสวิตช์/ชื่ออุปกรณ์เท่านั้น ไม่มี ID/secret)
function startupSummary(cfg) {
  const m = Object.keys(cfg.slotMap).sort().map(k => k + '=' + cfg.slotMap[k]).join(',');
  const hasSim = cfg.devices.some(d => d.name === 'sim');
  const on = v => v ? '1' : '0';
  return (cfg.slotWarn || []).map(w => 'คำเตือน config: ' + w).concat([
    'แมปช่อง->อุปกรณ์: ' + m + ' | SLOT_DEVICE_DEFAULT=' + cfg.slotDefault + ' | มี TB_SIM_DEVICE_ID=' + (hasSim ? 'ใช่' : 'ไม่'),
    'สวิตช์: ALLOW_LOCALHOST=' + on(cfg.allowLocalhost) + ' CONFIG_MASTER_ONLY=' + on(cfg.configMasterOnly) + ' BOOKINGS_WRITE=' + on(cfg.bookingsWrite) + ' BARRIER_RPC=' + on(cfg.barrierRpc),
  ]);
}

function loadConfig(env = process.env) {
  const list = s => String(s || '').split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
  return {
    tbHost: String(env.TB_HOST || 'https://eu.thingsboard.cloud').replace(/\/+$/, ''),
    tbApiKey: env.TB_API_KEY || '',
    customerMembersId: env.TB_CUSTOMER_MEMBERS_ID || '',
    customerStaffId: env.TB_CUSTOMER_STAFF_ID || '',
    assetId: env.TB_ASSET_ID || '',                         // asset ParkHere-Data (config, closed, bk_*) ใช้ใน M2
    offlineMs: offlineMsFrom(env),                          // { lot, sim, other } ms ก่อนถือว่าไม่มีสัญญาณ
    devices: parseDevices(env),                            // [{name,id}] ParkHere-Lot (+ ParkHere-Sim ถ้าตั้ง) ดู parseDevices
    slotMap: parseSlotMap(env), slotDefault: parseSlotDefault(env), slotWarn: parseSlotMapChecked(env).warn.concat(parseSlotDefaultChecked(env).warn),   // ช่อง -> อุปกรณ์ (ค่าเริ่ม 1-1=lot ที่เหลือ=sim)
    membersGroupId: env.TB_MEMBERS_GROUP_ID || '',          // ไม่บังคับ: entity group ของ Members (PE)
    webOrigins: list(env.WEB_ORIGINS),                      // origin ของเว็บบน Render (+ localhost อนุญาตเสมอ)
    port: +(env.API_PORT || env.PORT || 10000),
    allowLocalhost: env.ALLOW_LOCALHOST !== '0',            // 0 = ปิดการอนุญาต localhost (ใช้บน production ได้)
    lotPollMs: +(env.LIVE_POLL_MS || 1000),                 // ความถี่ poll telemetry ขณะมีคนเปิด live
    lotAttrMs: +(env.LOT_ATTR_MS || 5000),                  // ความถี่อ่าน attribute (config/closed/bk_*)
    lotCacheMs: +(env.LOT_CACHE_MS || 2000),                // อายุ cache ของ GET /api/lot เมื่อไม่มีคนเปิด live
    liveMaxPerUser: +(env.LIVE_MAX_PER_USER || 3), liveMaxTotal: +(env.LIVE_MAX_TOTAL || 100),
    livePingMs: +(env.LIVE_PING_MS || 20000),
    trustProxy: env.TRUST_PROXY !== '0',                    // Render ใส่ X-Forwarded-For ให้
    tbTimeoutMs: +(env.TB_TIMEOUT_MS || 10000),
    authCacheMs: +(env.AUTH_CACHE_MS || 60000),
    ipLimit: +(env.AUTH_IP_LIMIT || 10), ipWindowMs: 60000,
    lockFails: +(env.LOCK_FAILS || 8), lockMs: +(env.LOCK_MS || 300000),
    // M3 การจอง: สวิตช์เขียน (ค่าเริ่มต้น = ปิด ตั้ง BOOKINGS_WRITE=1 เฉพาะบน Render เมื่อเจ้าของยืนยัน) + ล็อกเดียว + อัตรา
    bookingsWrite: env.BOOKINGS_WRITE === '1',
    barrierRpc: env.BARRIER_RPC === '1',                    // M4: สวิตช์สั่งบอร์ดจริง (ค่าเริ่มต้น = ปิด ตั้งเฉพาะบน Render เมื่อเจ้าของยืนยัน)
    barrierAdminRateMax: +(env.BARRIER_ADMIN_RATE_MAX || 20),   // M4 B4: staff/master 20 ครั้ง/นาที/uid (limiter แยกจาก member)
    // M5: staff/master เขียน closed/config 20/นาที/uid, อ่านรายการจอง 12/นาที/uid + แคชฝั่งเซิร์ฟเวอร์ 10 วิ; O1: CONFIG_MASTER_ONLY=1 = เฉพาะ master แก้ config ได้ (ค่าเริ่มต้น staff+master)
    adminWriteRateMax: +(env.ADMIN_WRITE_RATE_MAX || 20), adminListRateMax: +(env.ADMIN_LIST_RATE_MAX || 12), adminListCacheMs: env.ADMIN_LIST_CACHE_MS !== undefined ? +env.ADMIN_LIST_CACHE_MS : 10000,
    configMasterOnly: env.CONFIG_MASTER_ONLY === '1',
    barrierRateMax: +(env.BARRIER_RATE_MAX || 6), barrierCooldownMs: env.BARRIER_COOLDOWN_MS !== undefined ? +env.BARRIER_COOLDOWN_MS : 3000, barrierAutoRaiseMs: env.BARRIER_AUTORAISE_MS !== undefined ? +env.BARRIER_AUTORAISE_MS : 60000,   // M4: member 6 ครั้ง/นาที/uid, คูลดาวน์ต่อช่อง 3 วิ
    bookQueueMax: +(env.BOOK_QUEUE_MAX || 25), bookLockWaitMs: +(env.BOOK_LOCK_WAIT_MS || 15000),
    bookReconDelayMs: env.BOOK_RECON_DELAY_MS !== undefined ? +env.BOOK_RECON_DELAY_MS : 300,   // หน่วงอ่าน books ซ้ำก่อนปล่อย bk_ กำพร้า (R1)
    bookSweepDelayMs: env.BOOK_SWEEP_DELAY_MS !== undefined ? +env.BOOK_SWEEP_DELAY_MS : 35000,    // หลังเริ่มระบบรอก่อน sweep ที่เขียน (SR-42)
    bookRateMax: +(env.BOOK_RATE_MAX || 10), leaveRateMax: +(env.LEAVE_RATE_MAX || 20), userRateWindowMs: +(env.USER_RATE_WINDOW_MS || 60000),
    meRateMax: +(env.ME_RATE_MAX || 30),                    // GET /api/me, GET /api/me/bookings, เปิด SSE: ต่อ uid ต่อนาที (แยกกัน) F-4
    tbBudget: +(env.TB_BUDGET || 600),                      // คำขอ TB ต่อนาทีที่เริ่มปฏิเสธการอ่านของผู้ใช้ (เพดาน tenant 1,000) จอง/ออก/ยกเลิกไม่ถูกตัด
    badTokenIpMax: +(env.BAD_TOKEN_IP_MAX || 20),           // โทเคนที่ TB ปฏิเสธ (401) ต่อ IP ต่อนาที: เกินแล้วไม่ยิง TB อีก (N-1)
    putRateMax: +(env.PUT_RATE_MAX || 10),                  // PUT /api/me ต่อ uid ต่อนาที (N-2)
    apiIpLimit: +(env.API_IP_LIMIT || 120), authNegCacheMs: +(env.AUTH_NEG_CACHE_MS || 30000),
  };
}
function missing(cfg) {
  const m = [];
  if (!cfg.tbApiKey) m.push('TB_API_KEY');
  if (!cfg.customerMembersId) m.push('TB_CUSTOMER_MEMBERS_ID');
  return m;
}
module.exports = { loadConfig, startupSummary, missing, loadDotEnv, ENV_FILE };
