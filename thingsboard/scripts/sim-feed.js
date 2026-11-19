// ยิง telemetry ปลอมเข้า ParkHere-Sim (เจ้าของรันเอง) ใช้ device HTTP API: POST {TB_HOST}/api/v1/<token>/telemetry
// ค่าเริ่มต้น = dry-run (แค่พิมพ์แผน ไม่ส่งอะไร) ต้องใส่ --send ถึงจะยิงจริง
// env: SIM_DEVICE_TOKEN (ของ ParkHere-Sim เท่านั้น ใส่เฉพาะหน้าต่างที่รัน ห้ามลงไฟล์), TB_HOST (ไม่ใส่ = https://eu.thingsboard.cloud)
// ใช้: node scripts/sim-feed.js                    (ดูแผน)
//      node scripts/sim-feed.js --send             (ยิงจริง ประมาณ 5 นาที 6 ข้อความ)
//      node scripts/sim-feed.js --send --soak 150  (ต่อท้ายด้วยสลับช่อง 1-5 อีก 150 ข้อความ; รวมทั้งหมดไม่เกิน 200 (soak สูงสุด 194))
const MAX_MSGS = 200, GAP_MS = 2000;
const args = process.argv.slice(2);
const send = args.includes('--send');
const si = args.indexOf('--soak'), soak = si >= 0 ? Math.floor(Number(args[si + 1])) : 0;
const host = String(process.env.TB_HOST || 'https://eu.thingsboard.cloud').replace(/\/+$/, '');
const token = process.env.SIM_DEVICE_TOKEN || '';
if (si >= 0 && !(soak >= 1 && soak <= MAX_MSGS)) { console.error('--soak ต้องเป็นเลข 1..' + MAX_MSGS); process.exit(1); }

const mask = s => (token ? String(s).split(token).join('***') : String(s));
const log = (...a) => console.log(mask(a.join(' ')));
// ขั้นตอน: { say, data } = ส่ง 1 ข้อความ; { say, wait } = รอเฉย ๆ (วินาที) ไม่ส่งอะไร
const plan = [
  { say: 'ออนไลน์ + ช่อง 1-2 มีรถ  -> คาด: sim online, 1-2 occ:true source:sim', data: { hb: 1, 'slot_1-2': true, 'bar_1-2': 0 } },
  { say: 'ช่อง 1-2 รถออก           -> คาด: slot event occ:false ภายใน ~2 วิ', data: { 'slot_1-2': false } },
  { say: 'ไม้กั้น 1-2 ลง           -> คาด: barrier down', data: { 'bar_1-2': 1 } },
  { say: 'ไม้กั้น 1-2 ขึ้น         -> คาด: barrier up', data: { 'bar_1-2': 0 } },
  { say: 'ช่อง 1-3 มีรถ, 1-4 ว่าง  -> คาด: 2 slot event', data: { 'slot_1-3': true, 'slot_1-4': false } },
  { say: 'เงียบ 120 วิ (ไม่ส่ง)    -> คาด: sim ยัง online (เกณฑ์ 150 วิ)', wait: 120 },
  { say: 'เงียบต่ออีก 60 วิ (รวม 180) -> คาด: sim offline, ช่องของ sim occ:null', wait: 60 },
  { say: 'กลับมาส่ง hb             -> คาด: sim online, ช่องกลับมามีค่า', data: { hb: 1 } },
];
for (let n = 0; n < soak; n++) plan.push({ say: 'soak ' + (n + 1) + '/' + soak, data: n % 20 === 0 ? { hb: 1, 'slot_1-5': n % 40 === 0 } : { 'slot_1-5': n % 2 === 0 } });

const count = plan.filter(p => p.data).length;
if (count > MAX_MSGS) { console.error('เกิน ' + MAX_MSGS + ' ข้อความ (' + count + ') ลด --soak'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  log(send ? 'โหมดยิงจริง' : 'โหมด dry-run (ยังไม่ส่งอะไร ใส่ --send เพื่อยิงจริง)', ' host =', host, ' ข้อความทั้งหมด =', count);
  if (send && !token) { console.error('ไม่พบ SIM_DEVICE_TOKEN ใน env (ตั้งเฉพาะหน้าต่างนี้ ห้ามลงไฟล์)'); process.exit(1); }
  let sent = 0;
  for (const p of plan) {
    log('-', p.say);
    if (p.wait) { if (send) await sleep(p.wait * 1000); continue; }
    log('   ส่ง', JSON.stringify(p.data));
    if (!send) continue;
    if (sent >= MAX_MSGS) break;
    let r;
    try { r = await fetch(host + '/api/v1/' + encodeURIComponent(token) + '/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p.data), signal: AbortSignal.timeout(10000) }); }
    catch (e) { log('   ล้มเหลว (เครือข่าย):', e.message); process.exit(1); }
    sent++;
    if (!r.ok) { log('   หยุด: ThingsBoard ตอบ HTTP', r.status, r.status === 401 || r.status === 403 ? '(token ผิด/ไม่ใช่ของอุปกรณ์นี้)' : ''); process.exit(1); }
    await sleep(GAP_MS);
  }
  log(send ? 'เสร็จ ส่งไป ' + sent + ' ข้อความ ต่อไปทำตามข้อ 5 ของ runbook (ล้างข้อมูล)' : 'dry-run เสร็จ ไม่มีอะไรถูกส่ง');
})();
