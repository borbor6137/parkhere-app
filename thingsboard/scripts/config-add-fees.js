// เพิ่ม bookfee/freemin/noshow ลง attribute `config` ของ asset ParkHere-Data (เจ้าของอนุมัติค่าแล้ว) เจ้าของรันเอง
// ค่าเริ่มต้น = dry-run (แสดงผลที่จะเขียน) ใส่ --apply ถึงจะเขียน; เติมเฉพาะคีย์ที่ยังไม่มี ไม่ทับค่าเดิม (floors/slots/rate/penalty ไม่เปลี่ยน)
// ค่า: bookfee 20 บาท, freemin 30 นาที, noshow 30 นาที (ตรงกับ DEFAULTS ใน api/lot.js)
// env: TB_API_KEY, TB_ASSET_ID, TB_HOST; อ่านจาก thingsboard/.env ได้ถ้ามี
const { loadConfig, loadDotEnv, ENV_FILE } = require('../api/config');
const { createTb } = require('../api/tb');
loadDotEnv(ENV_FILE, false);
const cfg = loadConfig(), apply = process.argv.includes('--apply');
const ADD = { bookfee: 20, freemin: 30, noshow: 30 };
const mask = s => { let t = String(s); for (const x of [cfg.tbApiKey, cfg.assetId].filter(Boolean)) t = t.split(x).join('***'); return t; };
const log = (...a) => console.log(mask(a.join(' ')));
const die = m => { console.error(mask(m)); process.exit(1); };
(async () => {
  if (!cfg.tbApiKey || !cfg.assetId) die('ต้องมี TB_API_KEY และ TB_ASSET_ID');
  const tb = createTb(cfg), base = '/api/plugins/telemetry/ASSET/' + encodeURIComponent(cfg.assetId);
  const r = await tb.admin(base + '/values/attributes/SERVER_SCOPE?keys=config');
  if (!r.ok) die('อ่าน config ไม่ได้ HTTP ' + r.status);
  const a = (Array.isArray(r.data) ? r.data : []).find(x => x.key === 'config');
  let cur = a ? a.value : {};
  if (typeof cur === 'string') { try { cur = JSON.parse(cur); } catch { cur = null; } }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) die('config เดิมอ่านไม่ได้เป็น object หยุด (ไม่เขียนทับ)');
  const next = { ...cur }, added = [];
  for (const [k, v] of Object.entries(ADD)) if (!(k in next)) { next[k] = v; added.push(k); }
  log('config เดิม:', JSON.stringify(cur));
  log('config ใหม่:', JSON.stringify(next));
  if (!added.length) return log('มีครบแล้ว ไม่ต้องทำอะไร');
  if (!apply) return log('dry-run: ยังไม่เขียน ใส่ --apply เพื่อเขียนจริง (เพิ่ม ' + added.join(',') + ')');
  const w = await tb.admin(base + '/attributes/SERVER_SCOPE', { method: 'POST', body: { config: next } });
  log(w.ok ? 'เขียนแล้ว' : 'เขียนไม่สำเร็จ HTTP ' + w.status);
  if (!w.ok) process.exit(1);
})();
