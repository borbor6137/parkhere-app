// ถดถอยรอบ 2: configEditable (ซ่อนฟอร์มตั้งแต่โหลด), ถอดสิทธิ์กลางเซสชัน, ยกเลิกซ้ำ
// ต้องเปิด mock 2 ชุด: node tests/admin-ui/serve-mock.js 18180 18181  และ  CONFIG_MASTER_ONLY=1 node tests/admin-ui/serve-mock.js 18280 18281
// รันด้วย browser_run_code_unsafe (วางโค้ดฟังก์ชันนี้) ผลคืนเป็นรายการ {test,pass}
async (page) => {
  const out = [], T = (test, pass, x) => out.push({ test, pass: !!pass, ...(x ? { x } : {}) });
  const login = async (web, api, page_, email) => {
    await page.unrouteAll(); await page.route(/:10000\//, r => r.abort());
    const pw = (await (await fetch(web + '/__ctl?op=pw')).json()).pw;
    await page.goto(web + '/' + page_ + '?api=' + api); await page.evaluate(() => sessionStorage.clear()); await page.reload();
    await page.fill('#u', email); await page.fill('#p', pw); await page.click('#go');
    await page.waitForSelector('#app.on', { timeout: 10000 }); await page.waitForTimeout(2500);
  };
  const cfgState = () => page.evaluate(() => ({ dis: document.getElementById('c-rate').disabled, save: getComputedStyle(document.getElementById('cfgsave')).display !== 'none', msg: getComputedStyle(document.getElementById('cfglock')).display !== 'none' }));
  // 1) โหมดปกติ: staff และ master แก้ได้
  const N = ['http://127.0.0.1:18181', 'http://127.0.0.1:18180'], M = ['http://127.0.0.1:18281', 'http://127.0.0.1:18280'];
  await login(N[0], N[1], 'admin.html', 'staff@example.test'); let c = await cfgState(); T('normal-staff-editable', !c.dis && c.save && !c.msg, c);
  // 2) master-only: staff ถูกซ่อนตั้งแต่โหลด (ไม่ต้องกดบันทึกก่อน) master ยังแก้ได้
  await login(M[0], M[1], 'admin.html', 'staff@example.test'); c = await cfgState(); T('masteronly-staff-locked-on-load', c.dis && !c.save && c.msg, c);
  await login(M[0], M[1], 'master.html', 'master@example.test'); c = await cfgState(); T('masteronly-master-editable', !c.dis && c.save && !c.msg, c);
  // 3) ยกเลิกซ้ำ: ยกเลิกผ่าน API ก่อน (คนอื่น) โดยหน้าจอยังเห็นว่า active (บล็อก GET รายการจอง)
  await login(N[0], N[1], 'admin.html', 'staff@example.test'); await page.click('[data-p=bk]'); await page.waitForTimeout(500);
  await page.route(/\/api\/admin\/bookings/, r => r.abort());
  const ids = await (await fetch(N[0] + '/__ctl?op=ids')).json();
  const btn = page.locator('#rows [data-c="' + ids.b2 + '"]'); T('dup-cancel-button-visible', await btn.count() === 1);
  await page.evaluate(async ([api, id]) => { const t = JSON.parse(sessionStorage.getItem('ph_adm_tk')).t; await fetch(api + '/api/bookings/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'ซ่อมพื้น' }) }); }, [N[1], ids.b2]);
  await btn.click(); await page.waitForTimeout(300); await page.click('#rs .ch >> nth=1'); await page.click('#ry'); await page.waitForTimeout(1500);
  const nt = await page.locator('#nts').innerText();
  T('dup-cancel-says-already', /ถูกยกเลิกไปแล้ว/.test(nt) && !/คืนค่าจอง/.test(nt), nt);
  // 4) ถอดสิทธิ์กลางเซสชัน: 403 จากรายการจอง -> กลับหน้าล็อกอิน ล้างข้อมูล หยุด poll
  await page.unroute(/\/api\/admin\/bookings/);
  await fetch(N[0] + '/__ctl?op=demote');
  let reqs = 0; page.on('request', q => { if (/\/api\/admin\/bookings/.test(q.url())) reqs++; });
  await page.waitForSelector('#login', { state: 'visible', timeout: 30000 });
  T('demoted-returns-to-login', await page.locator('#app.on').count() === 0 && /ไม่มีสิทธิ์/.test(await page.locator('#err').innerText()), await page.locator('#err').innerText());
  T('demoted-token-cleared', await page.evaluate(() => sessionStorage.getItem('ph_adm_tk')) === null);
  const r0 = reqs; await page.waitForTimeout(25000); T('demoted-polling-stopped', reqs === r0, { r0, reqs });
  return out;
}
