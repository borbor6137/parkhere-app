// ชุดทดสอบถดถอยหน้า admin/master (รันผ่าน Playwright: browser_run_code_unsafe หรือ require แล้วส่ง page)
//   1) เปิด mock: node tests/admin-ui/serve-mock.js 18180 18181
//   2) browser_run_code_unsafe ด้วย filename ของไฟล์นี้ (ฟังก์ชัน async (page) รันทั้ง admin.html และ master.html)
// ข้อกลางจาก QA: SSE snapshot มาก่อน GET /api/lot -> ฟอร์มตั้งค่าต้องไม่ว่าง
async (page) => {
  const o0 = { web: 'http://127.0.0.1:18181', api: 'http://127.0.0.1:18180' }, res = [];
  for (const which of ['admin.html', 'master.html']) {
  const o = { ...o0, which };
  await page.unrouteAll();
  const out = [], pw = (await (await fetch(o.web + '/__ctl?op=pw')).json()).pw;
  await page.route(/:10000\//, r => r.abort());
  await page.route(/\/api\/lot(\?|$)/, async r => { await new Promise(x => setTimeout(x, 2500)); r.continue(); });   // หน่วง GET /api/lot ให้ SSE ชนะ
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(o.web + '/' + o.which + '?api=' + o.api);
  await page.fill('#u', o.which === 'master.html' ? 'master@example.test' : 'staff@example.test'); await page.fill('#p', pw); await page.click('#go');
  await page.waitForSelector('#app.on', { timeout: 10000 }); await page.waitForTimeout(1500);
  const vals = await page.evaluate(() => ['c-rate', 'c-pen', 'c-fr', 'c-fl', 'c-sl', 'c-ns'].map(i => document.getElementById(i).value));
  out.push({ test: 'cfg-filled-before-lot', pass: vals.every(v => v !== ''), vals });
  await page.waitForTimeout(2500);
  // ปิดช่องที่มีการจอง: ต้องมีเครื่องหมาย cb (1-1 มีการจอง active ใน mock)
  await page.click('[data-p=sl]'); await page.click('.s[data-k="1-1"]'); await page.waitForTimeout(300); await page.click('.dlg button[data-i="1"]'); await page.waitForTimeout(1000);
  out.push({ test: 'closed-with-booking-marker', pass: /\bcb\b/.test(await page.locator('.s[data-k="1-1"]').getAttribute('class')) });
  await page.click('.s[data-k="1-1"]'); await page.waitForTimeout(300); await page.click('.dlg button[data-i="1"]'); await page.waitForTimeout(800);   // เปิดคืน
  res.push({ which, out });
  }
  return res;
}
// ตรวจมือเพิ่ม (S3/S4, ทำแล้วใน commit ถัดมา): โฮสต์ที่ไม่ใช่ localhost + config.js 404 -> ไม่มีคำขอไป localhost/10000 และขึ้นข้อความ "ยังไม่ได้ตั้งค่าที่อยู่ระบบหลังบ้าน";
// sessionStorage['ph_adm_tk'] มีแต่ {t} ไม่มี refresh token; document.querySelectorAll('script:not([src])').length === 0
