// ล้าง telemetry ที่ยิงไว้ใน ParkHere-Sim (ข้อ 5.2 ของ M2-test-proposal.md) เจ้าของรันเอง
// ค่าเริ่มต้น = dry-run (แค่แสดงคีย์ที่จะลบ) ใส่ --yes ถึงจะลบจริง
// ลบเฉพาะคีย์ hb, slot_*, bar_* ของอุปกรณ์ที่ TB_SIM_DEVICE_ID ชี้ และต้องมีชื่อ "ParkHere-Sim" เท่านั้น (ชื่ออื่น/ตรงกับ Lot = หยุด)
// ไม่แตะ attribute, asset, อุปกรณ์อื่น; ไม่ลบตัวอุปกรณ์ และไม่เปลี่ยน token (ทำเองในหน้า ThingsBoard: Manage credentials)
// env: TB_API_KEY, TB_SIM_DEVICE_ID, TB_SENSOR_DEVICE_ID (ใช้กันพลาดเท่านั้น), TB_HOST; อ่านจาก thingsboard/.env ได้ถ้ามี
const { loadConfig, loadDotEnv, ENV_FILE } = require('../api/config');
const { createTb } = require('../api/tb');
loadDotEnv(ENV_FILE, false);
const cfg = loadConfig(), yes = process.argv.includes('--yes');
const simId = process.env.TB_SIM_DEVICE_ID || '', lotId = process.env.TB_SENSOR_DEVICE_ID || '';
const mask = s => { let t = String(s); for (const x of [cfg.tbApiKey, simId, lotId].filter(Boolean)) t = t.split(x).join('***'); return t; };
const log = (...a) => console.log(mask(a.join(' ')));
const die = m => { console.error(mask(m)); process.exit(1); };
const OURS = /^(hb|slot_\d+-\d+|bar_\d+-\d+)$/;

(async () => {
  if (!cfg.tbApiKey || !simId) die('ต้องมี TB_API_KEY และ TB_SIM_DEVICE_ID');
  if (simId === lotId) die('หยุด: TB_SIM_DEVICE_ID เท่ากับ ParkHere-Lot');
  const tb = createTb(cfg);
  const d = await tb.admin('/api/device/' + encodeURIComponent(simId));
  if (!d.ok) die('อ่านอุปกรณ์ไม่ได้ HTTP ' + d.status);
  if (d.data.name !== 'ParkHere-Sim') die('หยุด: อุปกรณ์ชื่อ "' + d.data.name + '" ไม่ใช่ ParkHere-Sim');
  const k = await tb.admin('/api/plugins/telemetry/DEVICE/' + encodeURIComponent(simId) + '/keys/timeseries');
  if (!k.ok) die('อ่านรายการคีย์ไม่ได้ HTTP ' + k.status);
  const all = Array.isArray(k.data) ? k.data : [];
  const keys = all.filter(x => OURS.test(x)), others = all.filter(x => !OURS.test(x));
  log('อุปกรณ์:', d.data.name, ' คีย์ที่จะลบ (' + keys.length + '):', keys.join(',') || '(ไม่มี)');
  if (others.length) log('คีย์อื่นที่ไม่แตะ:', others.join(','));
  if (!keys.length) return log('ไม่มีอะไรต้องล้าง');
  if (!yes) return log('dry-run: ยังไม่ลบ ใส่ --yes เพื่อลบจริง');
  const r = await tb.admin('/api/plugins/telemetry/DEVICE/' + encodeURIComponent(simId) + '/timeseries/delete?keys=' + keys.join(',') + '&deleteAllDataForKeys=true', { method: 'DELETE' });
  log(r.ok ? 'ลบแล้ว' : 'ลบไม่สำเร็จ HTTP ' + r.status);
  if (!r.ok) process.exit(1);
  log('ขั้นต่อไป: เปลี่ยน access token ของ ParkHere-Sim (Manage credentials) และปิดหน้าต่างที่ตั้ง SIM_DEVICE_TOKEN');
})();
