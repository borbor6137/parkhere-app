/* ParkHere · แกนร่วมของ admin.html / master.html (M5)
   - ไม่มี Firebase: ทุกอย่างผ่าน parkhere-api (Bearer JWT ของ ThingsBoard)
   - สิทธิ์ตัดสินที่เซิร์ฟเวอร์ทุกคำขอ หน้านี้ใช้ user.role จาก /api/me เพื่อซ่อน/แสดงปุ่มเท่านั้น (ไม่ใช้อีเมล)
   - ไม่คำนวณและไม่รวมยอดเงินฝั่งเว็บ: แสดงเฉพาะ amt/park ที่เซิร์ฟเวอร์ส่งมา (pricing.js ที่เดียว)
   - ทุกค่าที่มาจากผู้ใช้ (ชื่อ ทะเบียน เหตุผล) ผ่าน esc() ก่อนเข้า innerHTML */
(function(){
'use strict';
/* ตั้งค่าหน้าจาก data-* ของ <body> (ไม่ใช้ inline script เพื่อให้ใส่ CSP script-src 'self' ได้) */
const BD=document.body.dataset||{};
const O={page:BD.page||'admin',roles:(BD.roles||'staff,master').split(',')};
const ROLES=O.roles;
/* ม่านเปิดหน้า (ตกแต่งอย่างเดียว ไม่เกี่ยวกับสิทธิ์) */
setTimeout(()=>{const c=document.getElementById('curtain');if(c)c.classList.add('off')},1300);
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=x=>{x=Number(x);return isFinite(x)?x:0};
const fmt=n=>num(n).toLocaleString('th-TH');
const fdt=t=>t?new Date(t).toLocaleString('th-TH',{dateStyle:'short',timeStyle:'short'}):'-';
const KRE=/^\d{1,2}-\d{1,3}$/,IDRE=/^[A-Za-z0-9_-]{1,64}$/;

/* ---------- ที่อยู่ API (จุดเดียว เหมือน script.js) ---------- */
const DEV_HOST=/^(localhost|127\.0\.0\.1)$/.test(location.hostname),DEV_Q=new URLSearchParams(DEV_HOST?location.search:'');
/* ค่าเริ่มต้น localhost:10000 ใช้เฉพาะตอนเปิดจาก localhost/127.0.0.1 เท่านั้น บน production ถ้าไม่มี config.js (PH_API_BASE) จะไม่ยิงคำขอเลย กันส่งโทเคนไปผิดที่ */
const API_BASE=(()=>{let b=(typeof window.PH_API_BASE==='string'&&window.PH_API_BASE)||(DEV_HOST?'http://localhost:10000':'');
  const q=DEV_HOST?DEV_Q.get('api'):'';if(q&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(q))b=q;return b.replace(/\/+$/,'')})();
const NO_API=!API_BASE;
/* โทเคนของหน้า admin แยกจากแอปผู้ใช้ (คนละ key) ลดความเสี่ยง S3: เก็บเฉพาะ access token ใน sessionStorage (ปิดแท็บแล้วหาย) ส่วน refresh token (อายุยาว ระดับ tenant admin) เก็บในหน่วยความจำของหน้าเท่านั้น โหลดหน้าใหม่หลัง access token หมดอายุต้องเข้าสู่ระบบใหม่ */
const TK='ph_adm_tk';let tok=null,rtok=null,me=null,srvOff=0;
try{const o=JSON.parse(sessionStorage.getItem(TK)||'null');if(o&&typeof o.t==='string')tok=o.t}catch(e){}
const tokSet=(t,r)=>{tok=t||null;rtok=r||null;try{if(tok)sessionStorage.setItem(TK,JSON.stringify({t:tok}));else sessionStorage.removeItem(TK)}catch(e){}};
const now=()=>Date.now()+srvOff;

/* ---------- ข้อความผิดพลาด (ไทย แยกตาม error.code) ---------- */
const MSG={INVALID_CREDENTIALS:'อีเมลหรือรหัสผ่านไม่ถูกต้อง',ACCOUNT_LOCKED:'ลองผิดหลายครั้ง บัญชีถูกพักชั่วคราว กรุณารอสักครู่แล้วลองใหม่',
  RATE_LIMIT:'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',FORBIDDEN:'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
  NO_SLOT:'ไม่พบช่องจอดนี้ในผังปัจจุบัน',NOT_FOUND:'ไม่พบรายการนี้แล้ว',NOT_ACTIVE:'รายการนี้จบไปแล้ว (เสร็จสิ้นหรือไม่มาตามนัด) จึงยกเลิกไม่ได้',
  CONFIG_UNREADABLE:'ค่าตั้งค่าเดิมใน ThingsBoard อ่านไม่ออก ระบบจึงไม่เขียนทับ กรุณาให้ผู้ดูแลระบบตรวจที่ ThingsBoard',
  SLOT_UNKNOWN:'ไม่ทราบสถานะช่องนี้ (บอร์ดไม่ส่งข้อมูล) จึงสั่งไม้กั้นไม่ได้',SLOT_CONFLICT:'ข้อมูลช่องนี้ขัดแย้งกันระหว่างบอร์ด จึงสั่งไม้กั้นไม่ได้',
  SLOT_OCCUPIED:'ตรวจพบรถในช่องนี้ (หรือไม่ทราบสถานะ) ต้องยืนยันก่อนสั่ง',COOLDOWN:'สั่งช่องเดิมถี่เกินไป กรุณารอสักครู่',
  BARRIER_DISABLED:'ระบบสั่งไม้กั้นยังไม่เปิดใช้งาน',BOARD_OFFLINE:'ส่งคำสั่งไปไม่ถึงบอร์ด (บอร์ดอาจออฟไลน์)',
  WRITES_DISABLED:'ระบบยังไม่เปิดรับการแก้ไขข้อมูล',BUSY:'ระบบกำลังประมวลผลคำขออื่น กรุณาลองใหม่',
  UPSTREAM:'ระบบหลังบ้านไม่ตอบสนอง สถานะยังไม่เปลี่ยน ลองใหม่ได้',NOT_CONFIGURED:'ระบบลานจอดยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง'};
const apiErr=(r,er)=>{const code=er.code||'HTTP_'+r.status,message=typeof er.message==='string'?er.message:'';let n=0;
  if(r.status===429||r.status===503){n=parseInt(r.headers&&r.headers.get&&r.headers.get('Retry-After'),10);if(!(n>0)){const m=/(\d+)\s*วินาที/.exec(message);n=m?+m[1]:r.status===503?5:15}n=Math.min(Math.max(n,1),60)}
  return {api:1,status:r.status,code,message,retry:n}};
/* ผลไม่ทราบ = ไม่มี code จากเซิร์ฟเวอร์ (timeout, เครือข่าย, 5xx เปล่า) ห้ามพูดว่า "ไม่ได้บันทึก" */
const unknownOutcome=e=>!e||!e.api||e.code==='NO_API'||/^HTTP_/.test(e.code||'')||e.code==='timeout'||e.code==='network';
function errTh(e){
  if(unknownOutcome(e))return (e&&e.api&&e.status<500?'':'การเชื่อมต่อขัดข้อง ')+'ไม่ทราบผลของคำสั่งนี้ ระบบจะโหลดสถานะล่าสุดให้ โปรดตรวจดูก่อนสั่งซ้ำ';
  if(e.code==='RATE_LIMIT'||e.code==='COOLDOWN')return (MSG[e.code])+(e.retry?' (ประมาณ '+e.retry+' วินาที)':'');
  return MSG[e.code]||e.message||'ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง'}
const errRead=e=>e&&e.code==='NO_API'?e.message:unknownOutcome(e)?'เชื่อมต่อระบบไม่ได้ในขณะนี้':(MSG[e.code]||e.message||'อ่านข้อมูลไม่สำเร็จ');

/* ---------- เรียก API ---------- */
async function apiRaw(method,path,body,auth){
  if(NO_API)throw {api:1,status:0,code:'NO_API',message:'ยังไม่ได้ตั้งค่าที่อยู่ระบบหลังบ้าน (config.js) กรุณาแจ้งผู้ดูแลระบบ'};
  const ac=new AbortController(),to=setTimeout(()=>ac.abort(),60000),t0=Date.now();
  try{
    const h={};if(body!==undefined)h['Content-Type']='application/json';if(auth&&tok)h.Authorization='Bearer '+tok;
    let r;try{r=await fetch(API_BASE+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),signal:ac.signal,cache:'no-store'})}
    catch(e){throw {code:e&&e.name==='AbortError'?'timeout':'network'}}
    let j=null;try{j=await r.json()}catch(e){}
    if(r.ok){if(j&&j.serverNow)srvOff=j.serverNow-Math.round((t0+Date.now())/2);return j||{}}
    throw apiErr(r,(j&&j.error)||{});
  }finally{clearTimeout(to)}
}
let refreshing=null;
const doRefresh=()=>refreshing||(refreshing=(rtok?apiRaw('POST','/api/refresh',{refreshToken:rtok},false):Promise.reject({api:1,status:401,code:'REFRESH_INVALID'})).then(j=>tokSet(j.token,j.refreshToken)).finally(()=>{refreshing=null}));
async function api(method,path,body,opt={}){
  const auth=opt.auth!==false;
  try{return await apiRaw(method,path,body,auth)}
  catch(e){
    if(auth&&e&&e.api&&e.status===401){
      if(e.code==='TOKEN_EXPIRED'&&!opt.retried){
        try{await doRefresh()}catch(r){if(r&&r.api){sessionLost();throw e}throw r}
        return api(method,path,body,{...opt,retried:true});
      }
      sessionLost();
    }
    throw e;
  }
}

/* ---------- แจ้งเตือน / กล่องโต้ตอบ ---------- */
const note=(m,bad)=>{const d=document.createElement('div');d.className='nt';if(bad){d.style.borderColor='var(--bad)';d.setAttribute('role','alert')}d.textContent=m;$('nts').appendChild(d);setTimeout(()=>d.remove(),bad?9000:6000)};
/* ตัวเลือกหลายปุ่ม: คืนค่า val ของปุ่มที่กด หรือ null (Esc / แตะฉากหลัง / ปุ่มแรก = ไม่ทำรายการ) โฟกัสเริ่มที่ปุ่มปลอดภัย (ไม่ทำรายการ) */
function askChoice(title,lines,btns){return new Promise(res=>{
  const prev=document.activeElement,o=document.createElement('div');o.className='ov';
  o.innerHTML=`<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="cf-t"><h3 id="cf-t" style="margin:0 0 6px;font-size:17px">${esc(title)}</h3><p class="hint" style="margin:0">${lines.filter(Boolean).map(esc).join('<br>')}</p><div style="display:flex;gap:8px;margin-top:20px;flex-wrap:wrap">${btns.map((b,i)=>`<button type="button" class="btn${i===0?' ghost':''}" data-i="${i}" style="flex:${i===0?1:1.4};min-width:120px${b.danger?';background:var(--bad);color:#fff':''}">${esc(b.t)}</button>`).join('')}</div></div>`;
  const bs=[...o.querySelectorAll('button')];
  const kd=e=>{if(e.key==='Escape')done(null);else if(e.key==='Tab'){e.preventDefault();const i=bs.indexOf(document.activeElement);bs[(i+(e.shiftKey?-1:1)+bs.length)%bs.length].focus()}};
  const done=v=>{o.remove();removeEventListener('keydown',kd);try{prev&&prev.focus&&prev.focus()}catch(_){}res(v)};
  addEventListener('keydown',kd);
  o.onclick=e=>{if(e.target===o)return done(null);const b=e.target.closest('button[data-i]');if(!b)return;const i=+b.dataset.i;done(i===0?null:btns[i].v)};
  document.body.appendChild(o);bs[0].focus();
})}
const askConfirm=(title,lines,ok,danger)=>askChoice(title,lines,[{t:'ไม่ทำรายการ'},{t:ok,v:true,danger}]).then(v=>v===true);
function askReason(title,subLines){return new Promise(res=>{
  const R=['ช่องจอดมีปัญหา / ซ่อมบำรุง','ผู้ใช้แจ้งขอยกเลิก','จองผิดช่องหรือข้อมูลไม่ถูกต้อง','เหตุฉุกเฉิน / ปิดลานจอดชั่วคราว','รถไม่มาตามนัด','อื่นๆ (ระบุเอง)'];
  let pick=-1;const prev=document.activeElement,o=document.createElement('div');o.className='ov';
  o.innerHTML=`<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="rs-t"><h3 id="rs-t" style="margin:0 0 6px;font-size:17px">${esc(title)}</h3><p class="hint" style="margin:0 0 16px">${subLines.filter(Boolean).map(esc).join('<br>')}</p><label>เลือกเหตุผล (ผู้ใช้จะเห็นในแอป)</label><div class="fl" id="rs">${R.map((t,i)=>`<button type="button" class="ch" data-i="${i}">${esc(t)}</button>`).join('')}</div><input id="ro" placeholder="ระบุเหตุผล" maxlength="100" style="display:none;margin-top:10px" aria-label="เหตุผลอื่นๆ"><div id="rerr" class="hint" style="color:var(--bad);min-height:16px" role="alert"></div><div style="display:flex;gap:8px;margin-top:10px"><button type="button" class="btn ghost" id="rn" style="flex:1">ไม่ยกเลิก</button><button type="button" class="btn" id="ry" style="flex:1.4;background:var(--bad);color:#fff">ยืนยันยกเลิกการจอง</button></div></div>`;
  const kd=e=>{if(e.key==='Escape')done(null)};
  const done=v=>{o.remove();removeEventListener('keydown',kd);try{prev&&prev.focus&&prev.focus()}catch(_){}res(v)};
  addEventListener('keydown',kd);
  o.onclick=e=>{if(e.target===o)done(null)};
  o.querySelector('#rs').onclick=e=>{const b=e.target.closest('[data-i]');if(!b)return;pick=+b.dataset.i;
    o.querySelectorAll('#rs .ch').forEach(x=>x.classList.toggle('on',x===b));
    const ot=pick===R.length-1,inp=o.querySelector('#ro');inp.style.display=ot?'block':'none';if(ot)inp.focus()};
  o.querySelector('#rn').onclick=()=>done(null);
  o.querySelector('#ry').onclick=()=>{if(pick<0){o.querySelector('#rerr').textContent='กรุณาเลือกเหตุผลก่อน';return}
    const t=pick===R.length-1?o.querySelector('#ro').value.trim():R[pick];
    if(!t){o.querySelector('#rerr').textContent='กรุณาระบุเหตุผล';return}
    if(/[<>]/.test(t)||/\d{9,}/.test(t)){o.querySelector('#rerr').textContent='เหตุผลห้ามมีเครื่องหมาย < > หรือเลขยาวต่อกัน';return}
    done(t.slice(0,100))};
  document.body.appendChild(o);o.querySelector('#rn').focus();
})}

/* ---------- สถานะลานจอดสด (GET /api/lot + SSE /api/live) ---------- */
let lot=null,slotMap={},cfg={},closedMap={},boardAgg=null,lotStale=false,srvQ='';
/* ชื่อช่อง A1..C2 มาจาก phSlotName (slotname.js) ที่เดียว ส่งเป็นคีย์ "ชั้น-index" คีย์ผิดรูปแบบ/ไม่มีไฟล์ -> '?' */
const slotName=k=>{try{return typeof phSlotName==='function'?String(phSlotName(k)):'?'}catch(e){return'?'}};
const okInt=(x,min)=>typeof x==='number'&&Number.isInteger(x)&&x>=min;
const keyOf=(f,i)=>okInt(f,1)&&okInt(i,0)?f+'-'+i:'';   // f,i ต้องเป็นจำนวนเต็ม (ไม่ใช่สตริง/ทศนิยม) ไม่งั้นคีย์ว่าง -> '?'
const fullName=(f,i)=>'F'+(okInt(f,1)?f:'?')+'-'+slotName(keyOf(f,i));
const kParts=k=>k.split('-').map(Number);
const label=k=>{const[f,i]=kParts(k);return fullName(f,i)};
function applySnap(d){if(!d||!Array.isArray(d.slots))return;
  lot=d;cfg=d.config||{};closedMap=d.closed&&typeof d.closed==='object'?d.closed:{};boardAgg=d.board||null;lotStale=!!d.stale;slotMap={};
  d.slots.forEach(s=>{if(s&&KRE.test(s.k))slotMap[s.k]=s});}
let bkT=0;
function liveEv(n,d){
  if(n==='snapshot'){applySnap(d);fillCfg();bkSoon(300)}
  else if(n==='slot'){if(!KRE.test(d.k))return;slotMap[d.k]=Object.assign(slotMap[d.k]||{k:d.k},d)}
  else if(n==='bookings'){if(!KRE.test(d.k))return;slotMap[d.k]=slotMap[d.k]||{k:d.k};slotMap[d.k].bookings=Array.isArray(d.bookings)?d.bookings:[];bkSoon(1500)}
  else if(n==='board'){if(d.board&&typeof d.board==='object')boardAgg=d.board}
  else if(n==='closed'){closedMap=d.closed&&typeof d.closed==='object'?d.closed:{};Object.keys(slotMap).forEach(k=>{slotMap[k].closed=!!closedMap[k]})}
  else if(n==='config'){if(d.config&&typeof d.config==='object'){cfg=d.config;if(lot)lot.config=cfg;fillCfg();bkSoon(1500)}}
  else if(n==='upstream'){lotStale=!!d.stale}
  else return;
  draw();
}
function liveBlock(b){const ev=/^event: (.+)$/m.exec(b),da=/^data: (.+)$/m.exec(b);if(!ev||!da)return;let d;try{d=JSON.parse(da[1])}catch(e){return}if(ev[1]==='end')LIVE.end=d&&d.reason||'';else liveEv(ev[1],d)}
const LIVE={gen:0,ac:null,tm:0,n:0,st:'off',rx:0,t0:0,end:'',rfn:0,off:0};
const LV_TXT={live:'เชื่อมต่อสดอยู่',connecting:'กำลังเชื่อมต่อสถานะลานจอด…',retry:'การเชื่อมต่อสดหลุด กำลังเชื่อมต่อใหม่… ข้อมูลที่เห็นอาจไม่ล่าสุด',busy:'ระบบกำลังคับคั่ง กำลังลองใหม่อัตโนมัติ…',
  replaced:'ปิดการเชื่อมต่อสดนี้แล้ว เพราะเปิดหน้านี้พร้อมกันเกิน 3 แท็บ/อุปกรณ์',stale:'ข้อมูลอาจไม่ล่าสุด (ระบบหลังบ้านอ่านข้อมูลจากบอร์ดไม่ได้ชั่วคราว)'};
function liveSet(st){const was=LIVE.st;LIVE.st=st;if(st==='live')LIVE.off=0;else if(!LIVE.off)LIVE.off=Date.now();if(was!==st)draw()}
function liveLater(minMs){const d=Math.max(minMs||0,Math.min(15000,1000*2**Math.min(LIVE.n,4)))*(.85+Math.random()*.3);LIVE.n++;clearTimeout(LIVE.tm);LIVE.tm=setTimeout(liveRun,d)}
function liveStop(st){LIVE.gen++;clearTimeout(LIVE.tm);const a=LIVE.ac;LIVE.ac=null;if(a)try{a.abort()}catch(e){}liveSet(st)}
async function liveRun(){
  if(!tok||!me)return;
  if(document.hidden)return liveStop('paused');
  const g=++LIVE.gen;clearTimeout(LIVE.tm);if(LIVE.ac)try{LIVE.ac.abort()}catch(e){}
  const ac=LIVE.ac=new AbortController();LIVE.t0=LIVE.rx=Date.now();LIVE.end='';
  if(LIVE.st!=='retry'&&LIVE.st!=='busy')liveSet('connecting');
  try{
    const r=await fetch(API_BASE+'/api/live',{headers:{Authorization:'Bearer '+tok,Accept:'text/event-stream'},signal:ac.signal,cache:'no-store'});
    if(g!==LIVE.gen)return;
    if(!r.ok){let j=null;try{j=await r.json()}catch(e){}throw apiErr(r,(j&&j.error)||{})}
    if(!r.body||!r.body.getReader)throw {code:'network'};
    liveSet('live');LIVE.rfn=0;
    const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
    for(;;){
      const x=await rd.read();if(g!==LIVE.gen)return;if(x.done)break;
      LIVE.rx=Date.now();buf+=dec.decode(x.value,{stream:true}).replace(/\r\n/g,'\n');
      let i;while((i=buf.indexOf('\n\n'))>=0){const b=buf.slice(0,i);buf=buf.slice(i+2);liveBlock(b)}
      if(LIVE.end==='replaced'||LIVE.end==='token-expired')break;
    }
  }catch(e){
    if(g!==LIVE.gen)return;
    const c=e&&e.api?e.code:'';
    if(e&&e.api&&e.status===401){
      if(c==='TOKEN_EXPIRED'&&LIVE.rfn++<2){try{await doRefresh()}catch(x){if(x&&x.api)return sessionLost()}return g===LIVE.gen&&liveRun()}
      return sessionLost();
    }
    if(e&&e.api&&e.status===403)return sessionLost('บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลแล้ว');
    LIVE.ac=null;const bz=c==='BUSY'||(e&&e.status===429);liveSet(bz?'busy':'retry');return liveLater(bz&&e.retry?e.retry*1000:0);
  }
  if(g!==LIVE.gen)return;
  const why=LIVE.end;
  if(why==='replaced')return liveStop('replaced');
  if(why==='token-expired'){try{ac.abort()}catch(e){}try{await doRefresh()}catch(x){return sessionLost()}return g===LIVE.gen&&liveRun()}
  LIVE.ac=null;liveSet('retry');liveLater();
}
setInterval(()=>{if(!me||!LIVE.ac)return;const t=Date.now();if(LIVE.st==='live'?t-LIVE.rx>45000:t-LIVE.t0>90000)try{LIVE.ac.abort()}catch(e){}},5000);
document.addEventListener('visibilitychange',()=>{if(!me)return;if(document.hidden){if(LIVE.st!=='replaced')liveStop('paused')}else if(LIVE.st==='paused'){LIVE.n=0;liveRun();bkSoon(100)}});
addEventListener('pagehide',()=>{if(LIVE.ac)try{LIVE.ac.abort()}catch(e){}});

/* ---------- รายการจองทั้งระบบ (GET /api/admin/bookings) ---------- */
let bk=null,bkErr='',bkBusy=false,bkTm=0,bkMap={},filt='all';
function bkSoon(ms){clearTimeout(bkTm);bkTm=setTimeout(()=>loadBookings(),ms)}
async function loadBookings(force){
  if(bkBusy||!me)return;
  const wait=5000-(Date.now()-bkT);if(!force&&wait>0)return bkSoon(wait);   // เพดานเซิร์ฟเวอร์ 12 ครั้ง/นาที: ห่างอย่างน้อย 5 วิ
  bkBusy=true;bkT=Date.now();
  try{const j=await api('GET','/api/admin/bookings?limit=200'+(srvQ?'&q='+encodeURIComponent(srvQ):''));
    bk=j;bkErr='';bkMap={};(j.bookings||[]).forEach(b=>{if(b&&IDRE.test(String(b.id)))bkMap[b.id]=b});}
  catch(e){if(e&&e.api&&e.status===403){bkBusy=false;return sessionLost('บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลแล้ว กรุณาติดต่อเจ้าของระบบ')}   // ถูกถอดสิทธิ์กลางเซสชัน: ล้างหน้าและหยุด poll
    bkErr=errRead(e);if(e&&e.retry)bkT=Date.now()+e.retry*1000-5000}
  bkBusy=false;draw();
}

/* ---------- แสดงผล ---------- */
const bAt=b=>bkMap[b.id]||b;
function stat(b){
  switch(b.status){
    case 'cancelled':return['ยกเลิก','r'];case 'noshow':return['ไม่มาตามนัด','r'];case 'done':return['เสร็จสิ้น',''];
    case 'void':return['ข้อมูลไม่ตรง','y'];
    case 'active':{const n=now();if(n<num(b.s))return['รอเข้าจอด','y'];if(n>num(b.e))return['จอดเกินเวลา','r'];
      const s=slotMap[b.f+'-'+b.i];return s&&s.occ===true?['กำลังจอด','g']:['รอรถเข้า','y']}
    default:return['-','']}}
/* คอลัมน์ "ออก": e = s+30 วัน เป็นแค่ที่กันช่อง ห้ามแสดงเป็นเวลาสิ้นสุด (M3-api.md) → แสดงเฉพาะ out จริง; ยังไม่จบ = "ยังไม่ออก" */
function outTxt(b){if(b.status==='active')return 'ยังไม่ออก';return num(b.out)>0?fdt(b.out):'—'}
/* การจองที่คร่อมเวลาปัจจุบันของช่อง (จากรายการของ lot ซึ่งทุกคนเห็น s,e,status) */
function reserved(s){const n=now();return(s.bookings||[]).some(b=>b&&b.status==='active'&&num(b.s)<=n&&n<num(b.e))}
function anyBooking(s){const n=now();return(s.bookings||[]).some(b=>b&&b.status==='active'&&n<num(b.e))}
function cellOf(s){
  if(closedMap[s.k]||s.closed)return'c';if(s.conflict)return'x';if(s.occ===true)return'o';if(reserved(s))return'r';if(s.occ==null)return'u';return'f'}
const CLS_ICO={c:['🔒','ปิด'],x:['⚠','ขัดแย้ง'],o:['🚗','มีรถ'],r:['🔖','จองแล้ว'],u:['❔','ไม่ทราบ'],f:['✓','ว่าง']};   // ไอคอน+ข้อความสั้นในช่อง ไม่ใช้สีอย่างเดียว
const CLS_TXT={c:'ปิดใช้งาน',x:'ข้อมูลขัดแย้งระหว่างบอร์ด',o:'มีรถจอด',r:'จองแล้ว (ยังไม่มีรถ)',u:'ไม่ทราบสถานะ (ไม่ได้รับสัญญาณ)',f:'ว่าง'};
const BAR_TXT={down:'ไม้กั้น: ลดอยู่',up:'ไม้กั้น: ยกอยู่'};
let bmode=false,cfgLocked=false;
const lockKey=()=>'ph_cfglock_'+(me&&me.id||'');
function draw(){
  if(!$('app')||!$('app').classList.contains('on'))return;
  drawStatus();
  if(!lot){$('floors').innerHTML='<div class="em">กำลังโหลดสถานะลานจอด…</div>';$('cards').innerHTML='';$('occ').innerHTML='';drawBookings();return}
  const byF={};Object.values(slotMap).forEach(s=>{if(s&&s.f>0){(byF[s.f]=byF[s.f]||[]).push(s)}});
  const T={o:0,r:0,f:0,u:0,c:0,x:0};let h='',o='',total=0,nDown=0;
  Object.keys(byF).map(Number).sort((a,b)=>a-b).forEach(f=>{
    const c={o:0,r:0,f:0,u:0,c:0,x:0};let cells='';const rowsDone={};
    byF[f].sort((a,b)=>a.i-b.i).forEach(s=>{
      const cl=cellOf(s),cb=cl==='c'&&anyBooking(s),bd=s.barrier==='down';c[cl]++;T[cl]++;total++;if(bd)nDown++;
      const bb=(bk&&bk.bookings||[]).find(x=>x.status==='active'&&x.f===s.f&&x.i===s.i&&num(x.s)<=now()&&now()<num(x.e));
      const sn0=slotName(s.k),tip=sn0+' · '+CLS_TXT[cl]+(bb?' · '+(bb.ownerName||'')+' · '+(bb.car||''):'')+(cb?' · ยังมีการจองค้างอยู่':'')+(BAR_TXT[s.barrier]?' · '+BAR_TXT[s.barrier]:'')+(bmode?' (แตะเพื่อสั่งไม้กั้น)':cl==='c'?' (แตะเพื่อเปิดช่อง)':' (แตะเพื่อปิดช่อง)');
      const ri=Math.min(60,(num(s.i)/2|0)+1),ci=num(s.i)%2?3:1;if(!rowsDone[ri]){rowsDone[ri]=1;cells+=`<i class="ln" aria-hidden="true" style="grid-row:${ri};grid-column:2"></i>`}
      const ic=CLS_ICO[cl];
      cells+=`<button type="button" class="s ${cl}${cb?' cb':''}${bd?' bd':''}" style="grid-row:${ri};grid-column:${ci}" data-k="${esc(s.k)}" title="${esc(tip)}" aria-label="${esc('ช่อง '+sn0+' '+CLS_TXT[cl]+(cb?' ยังมีการจองค้างอยู่':'')+(BAR_TXT[s.barrier]?' '+BAR_TXT[s.barrier]:''))}">${esc(sn0)}<small>${esc(ic[0]+' '+ic[1])}</small></button>`});
    const N=byF[f].length||1;
    h+=`<div class="fc"><div class="fh">ชั้น ${f}<small>ว่าง ${c.f} · มีรถ ${c.o} · จอง ${c.r} · ไม่ทราบ ${c.u+c.x} · ปิด ${c.c}</small><span class="sm"><button type="button" data-fl="${f}" data-v="1">ปิดทั้งชั้น</button><button type="button" data-fl="${f}" data-v="0">เปิดทั้งชั้น</button></span></div><div class="grid">${cells}</div></div>`;
    o+=`<div class="ob"><div class="r"><b>ชั้น ${f}</b><span>ใช้อยู่ ${c.o+c.r}/${N} ช่อง${c.c?' · ปิด '+c.c:''}${c.u+c.x?' · ไม่ทราบ '+(c.u+c.x):''}</span></div><div class="tk"><i style="width:${c.o/N*100}%;background:var(--bad)"></i><i style="width:${c.r/N*100}%;background:var(--bad);opacity:.55"></i><i style="width:${c.f/N*100}%;background:var(--ok)"></i><i style="width:${(c.u+c.x)/N*100}%;background:#3b3f4a"></i><i style="width:${c.c/N*100}%;background:#5a5e68"></i></div></div>`});
  $('floors').innerHTML=h||'<div class="em">ไม่พบข้อมูลช่องจอด</div>';$('occ').innerHTML=o;
  $('tot').textContent='ว่าง '+T.f+' · มีรถ '+T.o+' · จอง '+T.r+' · ไม่ทราบ '+(T.u+T.x)+' · ปิด '+T.c;
  const br=$('braise');br.style.display=bmode&&nDown?'':'none';br.textContent='⬆ ยกไม้กั้นทั้งหมด ('+nDown+')';br.dataset.n=nDown;
  const L=bk&&bk.bookings||[],act=L.filter(b=>b.status==='active').length,ns=L.filter(b=>b.status==='noshow').length,cn=L.filter(b=>b.status==='cancelled').length,ready=!!bk;
  const sub=ready?'รายการ · ใน '+fmt(L.length)+' รายการล่าสุดที่โหลด':'รายการ · กำลังโหลด';
  $('cards').innerHTML=[['ช่องว่างตอนนี้',fmt(T.f)+'/'+fmt(total),'ช่อง · ตอนนี้','g'],['มีรถจอด',fmt(T.o),'ช่อง · เซนเซอร์ตอนนี้'],['จองแล้ว (ยังไม่มีรถ)',fmt(T.r),'ช่อง · ตอนนี้'],
    ['ไม่ทราบสถานะ',fmt(T.u+T.x),'ช่อง · บอร์ดไม่ส่งข้อมูล/ขัดแย้ง'],['ปิดใช้งาน',fmt(T.c),'ช่อง · ตอนนี้'],
    ['การจองที่ใช้งานอยู่',ready?fmt(act):'–',sub],['ไม่มาตามนัด',ready?fmt(ns):'–',sub],['ยกเลิก',ready?fmt(cn):'–',sub]]
    .map(([x,y,z,g])=>`<div class="k ${g||''}"><small>${esc(x)}</small><b>${esc(y)}</b><small style="display:block;margin-top:4px;font-size:11px">${esc(z)}</small></div>`).join('');
  drawBookings();
}
function drawStatus(){
  const st=boardAgg&&boardAgg.status,sg=$('sig');
  if(sg){const ok=st==='online';sg.className='pill '+(ok?'ok':st?'bad':'');
    sg.lastElementChild.textContent=!lot?'กำลังเชื่อมต่อ…':ok?'บอร์ดออนไลน์':st==='offline'?'ไม่ได้รับสัญญาณบอร์ด':st==='never'?'ยังไม่เชื่อมต่อบอร์ด':'อ่านสถานะบอร์ดไม่ได้'}
  const bn=$('bn');if(bn){const show=!!lot&&st!=='online';bn.style.display=show?'block':'none';bn.textContent='⚠ บอร์ดไม่ได้ออนไลน์ สถานะ "มีรถจอด" และไม้กั้นอาจไม่เป็นปัจจุบัน ช่องที่ไม่ทราบสถานะจะไม่ถูกนับเป็นช่องว่าง'}
  const lv=$('lvb');if(lv){let t='',k=false;
    if(LIVE.st==='live'){if(lotStale){t=LV_TXT.stale}}
    else if(LIVE.st==='paused'||LIVE.st==='off'){t=''}
    else{t=LV_TXT[LIVE.st]||'';k=true}
    lv.style.display=t?'block':'none';lv.textContent=(k?'⚠ ':'⚠ ')+t;
    if(LIVE.st==='replaced'&&!lv.querySelector('button')){const b=document.createElement('button');b.type='button';b.className='btn ghost';b.style.cssText='margin-left:10px;padding:4px 10px;font-size:12px';b.textContent='เชื่อมต่อใหม่';b.onclick=()=>{LIVE.n=0;LIVE.rfn=0;liveRun()};lv.appendChild(b)}}
}
function drawBookings(){
  const rowsEl=$('rows');if(!rowsEl)return;
  const w=$('bkwarn');
  const L=bk&&bk.bookings||[];
  if(w){const m=[];
    if(bkErr)m.push('อ่านรายการจองไม่สำเร็จ: '+bkErr+' (แสดงข้อมูลล่าสุดที่โหลดได้ถ้ามี)');
    if(bk&&bk.staleCount>0)m.push('มี '+bk.staleCount+' รายการที่ข้อมูลอาจไม่ตรงกับระบบจอง (ป้าย "ข้อมูลอาจไม่ตรง") ระบบไม่แสดงยอดเงินของรายการเหล่านั้น อย่าใช้ตัดสินเรื่องเงิน');
    if(bk&&bk.truncated)m.push('แสดงเฉพาะ '+fmt(L.length)+' รายการล่าสุดจากทั้งหมด '+fmt(bk.total)+' รายการ');
    w.style.display=m.length?'block':'none';w.textContent='⚠ '+m.join(' · ')}
  const q=$('q').value.trim().toLowerCase(),today=new Date().toDateString();
  const cur=L.filter(b=>{const s=stat(b)[0];
    if(filt==='today'&&new Date(num(b.s)).toDateString()!==today)return false;
    if(filt==='act'&&!['กำลังจอด','รอรถเข้า','รอเข้าจอด','จอดเกินเวลา'].includes(s))return false;
    if(filt==='done'&&s!=='เสร็จสิ้น')return false;if(filt==='bad'&&!['ยกเลิก','ไม่มาตามนัด'].includes(s))return false;
    return !q||(String(b.ownerName||'')+' '+String(b.car||'')+' '+fullName(b.f,b.i)).toLowerCase().includes(q)});
  curList=cur;
  const sb=$('qsrv');if(sb){const show=!!(bk&&bk.truncated&&q);sb.style.display=show||srvQ?'':'none';sb.textContent=srvQ?'✕ ล้างการค้นหาทั้งระบบ':'🔍 ค้นหาทั้งระบบ'}
  if(!bk){rowsEl.innerHTML=`<tr><td colspan="8" class="em">${bkErr?esc('อ่านรายการจองไม่สำเร็จ: '+bkErr):'กำลังโหลดรายการจอง…'}</td></tr>`;
    const rc=$('recent');if(rc)rc.innerHTML='<div class="em">'+(bkErr?esc(bkErr):'กำลังโหลด…')+'</div>';return}
  rowsEl.innerHTML=cur.map(b=>{const[t,c]=stat(b),st=!!b.stale,id=IDRE.test(String(b.id))?b.id:'';
    const money=st?'<span style="color:var(--mu)" title="ข้อมูลอาจไม่ตรง ไม่แสดงยอด">–</span>':'฿'+fmt(b.amt)+(b.park?' <span style="color:var(--wa)" title="ค่าจอดตอนออก (คิดโดยเซิร์ฟเวอร์)">+฿'+fmt(b.park)+'</span>':'');
    const why=b.status==='cancelled'&&b.reason?'<br><small style="color:var(--mu)">เหตุผล: '+esc(b.reason)+'</small>':'';
    return `<tr><td data-l="ผู้จอง">${esc(b.ownerName||'-')}</td><td data-l="ช่อง">${esc(fullName(b.f,b.i))}</td><td data-l="ทะเบียน">${esc(b.car)}</td><td data-l="เริ่ม">${esc(fdt(b.s))}</td><td data-l="ออก">${esc(outTxt(b))}</td><td data-l="ค่าจอง">${money}</td><td data-l="สถานะ"><span class="tag ${c}">${esc(t)}</span>${st?' <span class="tag y" title="ข้อมูลในประวัติของผู้ใช้ไม่ตรงกับระบบจอง">ข้อมูลอาจไม่ตรง</span>':''}${why}</td><td>${b.status==='active'&&id?`<button type="button" class="btn ghost" style="padding:5px 10px;font-size:12px" data-c="${esc(id)}">ยกเลิก</button>`:''}</td></tr>`}).join('')||'<tr><td colspan="8" class="em">ไม่พบรายการ</td></tr>';
  const rc=$('recent');if(rc)rc.innerHTML=L.slice(0,5).map(b=>{const[t,c]=stat(b);return `<div style="display:flex;justify-content:space-between;gap:8px;padding:9px 0;border-bottom:1px solid var(--line)"><span>${esc(b.ownerName||'-')} <small style="color:var(--mu)">${esc(fullName(b.f,b.i))}</small></span><span class="tag ${c}">${esc(t)}</span></div>`}).join('')||'<div class="em">ยังไม่มีการจอง</div>';
}
let curList=[];

/* ---------- การกระทำ: ปิด/เปิดช่อง (PUT /api/admin/closed) ---------- */
const pend={};
async function once(key,fn){if(pend[key])return;pend[key]=1;try{return await fn()}finally{delete pend[key]}}
async function putClosed(set,okMsg){
  try{const j=await api('PUT','/api/admin/closed',{set});if(j&&j.closed&&typeof j.closed==='object'){closedMap=j.closed;Object.keys(slotMap).forEach(k=>{slotMap[k].closed=!!closedMap[k]})}note('✅ '+okMsg);draw()}
  catch(e){note((unknownOutcome(e)?'':'บันทึกสถานะช่องไม่ได้: ')+errTh(e),1);if(unknownOutcome(e))resync()}}
async function onFloors(e){
  const fb=e.target.closest('[data-fl]'),sb=e.target.closest('.s[data-k]');
  if(fb){const f=+fb.dataset.fl,cl=fb.dataset.v==='1',ks=Object.keys(slotMap).filter(k=>kParts(k)[0]===f);
    if(!ks.length||ks.length>120)return;
    const n=cl?ks.filter(k=>slotMap[k].occ===true||anyBooking(slotMap[k])).length:0;
    if(!await askConfirm((cl?'ปิดการใช้งานทั้งชั้น ':'เปิดการใช้งานทั้งชั้น ')+f+' ?',[cl?'ผู้ใช้จะจองช่องในชั้นนี้ไม่ได้ทั้ง '+ks.length+' ช่อง':'ผู้ใช้จะจองช่องในชั้นนี้ได้อีกครั้ง',n?'มี '+n+' ช่องที่มีรถจอดหรือมีการจองค้างอยู่ (การจองเดิมไม่ถูกยกเลิก)':''],cl?'ปิดทั้งชั้น':'เปิดทั้งชั้น',cl))return;
    const set={};ks.forEach(k=>set[k]=cl);
    return once('closed',()=>putClosed(set,(cl?'ปิด':'เปิด')+'ทั้งชั้น '+f+' แล้ว'))}
  if(!sb)return;const k=sb.dataset.k;if(!KRE.test(k)||!slotMap[k])return;
  if(bmode)return barrierFlow(k);
  const cl=!closedMap[k],s=slotMap[k],sn=label(k);
  if(!await askConfirm((cl?'ปิดการใช้งานช่อง ':'เปิดการใช้งานช่อง ')+sn+' ?',[cl?'ผู้ใช้จะจองช่องนี้ไม่ได้จนกว่าจะเปิดอีกครั้ง':'ผู้ใช้จะจองช่องนี้ได้อีกครั้ง',cl&&(s.occ===true||anyBooking(s))?'ช่องนี้มีรถจอดหรือมีการจองค้างอยู่ (การจองเดิมไม่ถูกยกเลิก)':''],cl?'ปิดช่อง':'เปิดช่อง',cl))return;
  return once('closed',()=>putClosed({[k]:cl},(cl?'ปิด':'เปิด')+'ช่อง '+sn+' แล้ว'));
}

/* ---------- การกระทำ: ไม้กั้น (POST /api/admin/barrier, raise-all) ---------- */
/* ป้ายกลาง: "สั่งลด/สั่งยกไม้กั้น", สถานะ "ลดอยู่/ยกอยู่" ห้ามตีความว่ารถเข้าได้/ไม่ได้ (รอเพื่อนเจ้าของยืนยันความหมาย down) */
function barrierMsg(r){return r&&r.already?'ช่องนี้อยู่ในสถานะที่สั่งแล้ว (ไม่ได้ส่งคำสั่งซ้ำ)':'ส่งคำสั่งไปที่บอร์ดแล้ว ผลจริงดูได้จากสถานะไม้กั้นในผังหลังบอร์ดตอบกลับ'}
async function barrierFlow(k){
  const s=slotMap[k],sn=label(k),[f,i]=kParts(k);
  if(s.conflict)return note('สั่งไม้กั้นช่อง '+sn+' ไม่ได้: '+MSG.SLOT_CONFLICT,1);
  let down;
  if(s.barrier==='down')down=false;else if(s.barrier==='up')down=true;
  else{const v=await askChoice('ไม่ทราบสถานะไม้กั้นช่อง '+sn,['บอร์ดยังไม่ส่งสถานะไม้กั้นของช่องนี้ เลือกคำสั่งที่ต้องการส่ง'],[{t:'ไม่ทำรายการ'},{t:'สั่งลดไม้กั้น',v:'d'},{t:'สั่งยกไม้กั้น',v:'u'}]);if(!v)return;down=v==='d'}
  if(down&&s.occ==null)return note('สั่งลดไม้กั้นช่อง '+sn+' ไม่ได้: ไม่ทราบว่ามีรถอยู่หรือไม่ (บอร์ดไม่ส่งข้อมูล) รอให้บอร์ดส่งสถานะก่อน',1);
  const risky=s.occ===true||(!down&&s.occ==null);
  const lines=['ระบบจะส่งคำสั่ง'+(down?'ลด':'ยก')+'ไม้กั้นไปที่บอร์ด ผลจริงดูได้จากสถานะไม้กั้นในผัง'];
  if(s.occ===true)lines.push('ตรวจพบรถอยู่ในช่องนี้ ยืนยันเพื่อสั่งต่อ');
  if(!down&&s.occ==null)lines.push('ไม่ทราบว่ามีรถอยู่หรือไม่ (บอร์ดไม่ส่งสัญญาณ) ยืนยันเพื่อสั่งยกต่อ');
  if(!await askConfirm((down?'สั่งลด':'สั่งยก')+'ไม้กั้นช่อง '+sn+' ?',lines,down?'สั่งลดไม้กั้น':'สั่งยกไม้กั้น',risky))return;
  return once('barrier:'+k,async()=>{
    let force=risky;
    for(let tries=0;tries<2;tries++){
      try{const r=await api('POST','/api/admin/barrier',force?{f,i,down,force:true}:{f,i,down});note('🚧 '+barrierMsg(r));return}
      catch(e){
        if(e&&e.code==='SLOT_OCCUPIED'&&!force){   // สแนปช็อตฝั่งเว็บไม่ทันสมัย: เซิร์ฟเวอร์เห็นรถ/ไม่ทราบสถานะ -> ถามยืนยันอีกชั้น
          if(!await askConfirm('ต้องยืนยันก่อนสั่งไม้กั้นช่อง '+sn,['เซิร์ฟเวอร์ตรวจพบรถในช่องนี้ (หรือไม่ทราบสถานะ) ในขณะนี้','ยืนยันเพื่อสั่งต่อ'],down?'สั่งลดไม้กั้น':'สั่งยกไม้กั้น',true))return;
          force=true;continue}
        note((unknownOutcome(e)?'':'สั่งไม้กั้นไม่ได้: ')+errTh(e),1);if(unknownOutcome(e))resync();return}
    }});
}
const CODE_TH={SLOT_OCCUPIED:'มีรถ',SLOT_UNKNOWN:'ไม่ทราบสถานะ',SLOT_CONFLICT:'ข้อมูลขัดแย้ง',COOLDOWN:'สั่งซ้ำถี่',TOO_MANY:'เกินจำนวนต่อครั้ง',BOARD_OFFLINE:'บอร์ดไม่ตอบ',UPSTREAM:'ระบบหลังบ้านไม่ตอบ'};
async function raiseAll(){
  const ks=Object.keys(slotMap).filter(k=>slotMap[k].barrier==='down');if(!ks.length)return note('ไม่มีไม้กั้นที่ลดอยู่');
  const risky=ks.filter(k=>slotMap[k].occ!==false).length;
  if(!await askConfirm('สั่งยกไม้กั้นทั้งหมด '+ks.length+' ช่อง ?',['ระบบจะส่งคำสั่งยกไปที่ช่องที่ลดอยู่ ผลจริงดูได้จากสถานะไม้กั้นในผัง',risky?risky+' ช่องมีรถหรือไม่ทราบสถานะ จะไม่ถูกยกจนกว่าคุณจะยืนยันเพิ่มในขั้นถัดไป':''],'สั่งยกไม้กั้นทั้งหมด',false))return;
  return once('raiseall',async()=>{
    try{
      let r=await api('POST','/api/admin/barrier/raise-all',{}),res=Array.isArray(r.results)?r.results:[];
      let held=res.filter(x=>!x.ok&&(x.code==='SLOT_OCCUPIED'||x.code==='SLOT_UNKNOWN'));
      if(held.length&&await askConfirm('ยกไม้กั้นช่องที่มีรถหรือไม่ทราบสถานะ '+held.length+' ช่อง ?',['ช่องเหล่านี้ยังไม่ถูกยก: '+held.map(x=>label(x.f+'-'+x.i)).join(', '),'ยืนยันเพื่อสั่งยกทุกช่องที่ลดอยู่ แม้มีรถหรือไม่ทราบสถานะ'],'ยืนยันสั่งยก',true)){
        const r2=await api('POST','/api/admin/barrier/raise-all',{force:true});res=res.filter(x=>x.ok).concat(Array.isArray(r2.results)?r2.results:[])}
      const ok=res.filter(x=>x.ok).length,fail=res.filter(x=>!x.ok);
      note('🚧 ส่งคำสั่งยกไม้กั้นแล้ว '+ok+' ช่อง ผลจริงดูจากสถานะไม้กั้นในผัง');
      if(fail.length)note('ไม่ได้สั่งยก '+fail.length+' ช่อง: '+fail.slice(0,8).map(x=>label(x.f+'-'+x.i)+' ('+(CODE_TH[x.code]||'ไม่สำเร็จ')+')').join(', '),1);
    }catch(e){note((unknownOutcome(e)?'':'สั่งยกไม้กั้นทั้งหมดไม่ได้: ')+errTh(e),1);if(unknownOutcome(e))resync()}});
}

/* ---------- การกระทำ: ยกเลิกการจอง (DELETE /api/bookings/:id) ---------- */
async function cancelBooking(id){
  const b=bkMap[id];if(!b||b.status!=='active')return;const sn=fullName(b.f,b.i);
  const reason=await askReason('ยกเลิกการจองช่อง '+sn,['ของ '+(b.ownerName||'-')+' · ทะเบียน '+(b.car||'-'),'ระบบจะคืนค่าจองให้ผู้ใช้ตามยอดที่เซิร์ฟเวอร์บันทึกไว้ และผู้ใช้จะเห็นเหตุผลในแอป','การยกเลิกย้อนกลับไม่ได้']);
  if(reason===null)return;
  return once('cancel:'+id,async()=>{
    try{const r=await api('DELETE','/api/bookings/'+encodeURIComponent(id),{reason});
      if(r&&r.barrier===undefined){note('รายการนี้ถูกยกเลิกไปแล้วก่อนหน้านี้ (ไม่มีการยกเลิกหรือคืนเงินซ้ำ)');bkT=0;loadBookings(true);return}
      const rf=r&&r.receipt&&num(r.receipt.amt)<0?' · คืนค่าจอง ฿'+fmt(-num(r.receipt.amt)):'';
      note('✅ ยกเลิกการจอง '+sn+' แล้ว'+rf);
      if(r&&r.barrier==='released')note('⬆ ส่งคำสั่งยกไม้กั้นช่องนี้ให้แล้ว');
      else if(r&&r.barrier==='failed')note('ยกเลิกการจองสำเร็จแล้ว แต่ส่งคำสั่งยกไม้กั้นไม่สำเร็จ กรุณาตรวจสถานะไม้กั้นที่แท็บช่องจอด',1);
      bkT=0;loadBookings(true)}
    catch(e){note((unknownOutcome(e)?'':'ยกเลิกการจองไม่ได้: ')+errTh(e),1);bkT=0;loadBookings(true)}});
}

/* ---------- การตั้งค่าระบบ (PUT /api/admin/config) ---------- */
const CF=[['c-rate','rate','ค่าจอด ฿/ชม.',1,100000],['c-pen','bookfee','ค่าจอง ฿/ครั้ง',0,100000],['c-fr','freemin','จอดฟรี (นาที)',0,1440],['c-fl','floors','จำนวนชั้น',1,10],['c-sl','slots','ช่องต่อชั้น',1,60],['c-ns','noshow','No-show (นาที)',0,1440]];
function fillCfg(){CF.forEach(([id,k])=>{const el=$(id);if(el&&document.activeElement!==el&&cfg[k]!=null)el.value=cfg[k]});applyLock()}
function applyLock(){
  const s=$('cfgsave'),m=$('cfglock');if(!s)return;
  s.style.display=cfgLocked?'none':'';if(m){m.style.display=cfgLocked?'block':'none';m.textContent='ℹ การแก้ราคาและขนาดลานจอดทำได้เฉพาะผู้ดูแลสูงสุด (Master) บัญชีนี้ดูค่าได้อย่างเดียว'}
  CF.forEach(([id])=>{const el=$(id);if(el)el.disabled=cfgLocked})}
async function saveCfg(e){e.preventDefault();
  const body={},diff=[];let bad='';
  CF.forEach(([id,k,t,lo,hi])=>{const raw=$(id).value.trim(),v=Number(raw);
    if(raw===''||!Number.isInteger(v)||v<lo||v>hi){bad=bad||t+' ต้องเป็นจำนวนเต็ม '+fmt(lo)+' ถึง '+fmt(hi);return}
    body[k]=v;if(cfg[k]!==v)diff.push(t+': '+(cfg[k]==null?'-':cfg[k])+' → '+v)});
  const sv=$('saved');const say=(m,badc)=>{sv.style.color=badc?'var(--bad)':'';sv.textContent=m;clearTimeout(sv._t);sv._t=setTimeout(()=>sv.textContent='',badc?8000:3000)};
  if(bad)return say(bad,1);
  if(!diff.length)return say('ไม่มีค่าที่เปลี่ยน');
  const shrink=(cfg.floors!=null&&body.floors<cfg.floors)||(cfg.slots!=null&&body.slots<cfg.slots);
  if(!await askConfirm('บันทึกการตั้งค่าระบบ ?',diff.concat(['ราคาใหม่มีผลกับการจองใหม่ทันที การจองที่มีอยู่ยอดไม่เปลี่ยน'],shrink?['ลดจำนวนชั้น/ช่อง: ช่องที่หายจะไม่แสดงในผัง (ระบบจะปฏิเสธถ้ายังมีการจองในช่องเหล่านั้น)']:[]),'บันทึกการตั้งค่า',shrink))return;
  return once('cfg',async()=>{
    try{const j=await api('PUT','/api/admin/config',body);if(j&&j.config&&typeof j.config==='object'){cfg=j.config;if(lot)lot.config=cfg}fillCfg();say('✓ บันทึกแล้ว');bkSoon(300)}
    catch(x){
      if(x&&x.code==='FORBIDDEN'&&me&&me.role!=='master'){cfgLocked=true;try{sessionStorage.setItem(lockKey(),'1')}catch(_){}applyLock();say('บัญชีนี้แก้การตั้งค่าไม่ได้ (เฉพาะ Master)',1)}
      else{say((unknownOutcome(x)?'':'บันทึกไม่ได้: ')+errTh(x),1);if(unknownOutcome(x))resync()}}});
}

/* ---------- CSV (เฉพาะค่าที่เซิร์ฟเวอร์ส่งมา แถว stale ไม่ใส่ยอดเงิน) ---------- */
function exportCsv(){
  const q=v=>{let s=String(v==null?'':v);if(/^[=+\-@\t\r\n＝＋－＠]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'};
  const head=['ผู้จอง','ช่อง','ทะเบียน','เริ่ม','ออก','ค่าจอง','ค่าจอด','สถานะ','หมายเหตุข้อมูล'];
  const body=curList.map(b=>[b.ownerName||'',fullName(b.f,b.i),b.car,fdt(b.s),outTxt(b),b.stale?'':num(b.amt),b.stale?'':(b.park!=null?num(b.park):''),stat(b)[0],b.stale?'ข้อมูลอาจไม่ตรง':'']);
  const blob=new Blob(['﻿'+[head,...body].map(r=>r.map(q).join(',')).join('\n')],{type:'text/csv;charset=utf-8'});
  const l=document.createElement('a');l.href=URL.createObjectURL(blob);l.download='parkhere-bookings-'+new Date().toISOString().slice(0,10)+'.csv';l.click();setTimeout(()=>URL.revokeObjectURL(l.href),1e3)}

/* ---------- เซสชัน / เข้าสู่ระบบ ---------- */
function bad(m){$('err').textContent=m;const c=$('lcard')||document.querySelector('.lc');if(c){c.classList.remove('shake');void c.offsetWidth;c.classList.add('shake')}}
let fails=0,lockUntil=0,started=false,idle;
function showLogin(msg){
  liveStop('off');clearTimeout(bkTm);me=null;lot=null;bk=null;slotMap={};started=false;
  $('app').classList.remove('on');const w=$('wel')||$('grant');if(w)w.classList.remove('on');
  const l=$('login');l.style.display='';l.classList.remove('out');if(msg){$('err').textContent=msg}}
function sessionLost(msg){tokSet();showLogin(msg||'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง')}
/* สิทธิ์ที่ได้จาก /api/me ใช้ซ่อน/แสดงปุ่มเท่านั้น ทุกคำสั่งเซิร์ฟเวอร์ตรวจ role สดซ้ำ */
async function loadMe(){const j=await api('GET','/api/me');return {id:String(j.id||''),role:j.role,configEditable:typeof j.configEditable==='boolean'?j.configEditable:null,name:j.name||'',email:j.email||''}}
async function login(){
  const em=$('u').value.trim(),pw=$('p').value;
  if(Date.now()<lockUntil)return bad('ลองใหม่อีกครั้งใน '+Math.ceil((lockUntil-Date.now())/1e3)+' วินาที');
  if(!em||!pw)return bad('กรอกอีเมลและรหัสผ่าน');
  $('go').disabled=true;$('err').textContent='';
  try{const j=await api('POST','/api/login',{email:em,password:pw},{auth:false});
    tokSet(j.token,j.refreshToken);
    const u=await loadMe();
    if(!ROLES.includes(u.role)){tokSet();bad(O.page==='master'?'บัญชีนี้ไม่ใช่ Master Admin':'บัญชีนี้ไม่ใช่ผู้ดูแล หรือถูกยกเลิกสิทธิ์แล้ว')}
    else{me=u;$('p').value='';enter(true)}}
  catch(e){tokSet();if(e&&e.code==='INVALID_CREDENTIALS'&&++fails>=5){lockUntil=Date.now()+3e4;fails=0}
    bad(e&&e.code==='INVALID_CREDENTIALS'?MSG.INVALID_CREDENTIALS:'เข้าสู่ระบบไม่สำเร็จ — '+errRead(e))}
  $('go').disabled=false;
}
function enter(fx){
  if(started)return;started=true;
  const w=$('wel')||$('grant'),go=()=>{if(w)w.classList.remove('on');$('login').style.display='none';$('app').classList.add('on');start()};
  if(fx&&w){$('login').classList.add('out');w.classList.add('on');setTimeout(go,1200)}else go();
}
function start(){
  const m=$('mail');if(m)m.textContent=me.email;
  const nm=document.querySelector('.me b');if(nm)nm.textContent=me.role==='master'?'Master (สิทธิ์เต็ม)':'ผู้ดูแลระบบ';
  const av=document.querySelector('.me .av');if(av)av.textContent=(String(me.name||me.email||'A').charAt(0)||'A').toUpperCase();
  const ml=$('tomaster');if(ml)ml.style.display=me.role==='master'?'':'none';
  /* เซิร์ฟเวอร์บอกสิทธิ์แก้ค่าไว้ใน /api/me (configEditable) ใช้ซ่อนฟอร์มตั้งแต่โหลด ถ้าไม่มีค่านี้ค่อยพึ่ง 403 (ชั้นสำรอง) */
  if(me.configEditable===false)cfgLocked=true;else if(me.configEditable===true)cfgLocked=false;
  else try{cfgLocked=sessionStorage.getItem(lockKey())==='1'}catch(e){cfgLocked=false}
  applyLock();draw();
  api('GET','/api/lot').then(d=>{if(!lot){applySnap(d);fillCfg();draw()}}).catch(()=>{});
  LIVE.n=0;LIVE.rfn=0;liveRun();loadBookings(true);
  setInterval(draw,30000);setInterval(()=>{if(!document.hidden&&me)loadBookings()},20000);
  const tick=()=>{const c=$('clk');if(c)c.textContent=new Date().toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'medium'})};tick();setInterval(tick,1000);rst();
}
async function resync(){try{const d=await api('GET','/api/lot');applySnap(d);fillCfg();draw()}catch(e){}bkT=0;loadBookings(true)}
const rst=()=>{clearTimeout(idle);if($('app').classList.contains('on'))idle=setTimeout(()=>{tokSet();location.reload()},20*60*1e3)};   // ออกอัตโนมัติเมื่อไม่ได้ใช้งาน 20 นาที
['click','keydown','mousemove','touchstart'].forEach(ev=>addEventListener(ev,rst,{passive:true}));

/* ---------- ผูกปุ่ม ---------- */
function bind(){
  $('go').onclick=login;
  [$('u'),$('p')].forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')login()}));
  const eye=$('eye');if(eye)eye.onclick=()=>{const p=$('p');p.type=p.type==='password'?'text':'password'};
  $('out').onclick=()=>{tokSet();location.reload()};
  const TT={};document.querySelectorAll('[data-p]').forEach(b=>{TT[b.dataset.p]=(b.textContent||'').replace(/^[^\wก-๙]+/,'').trim();
    b.onclick=()=>{document.querySelectorAll('[data-p]').forEach(x=>x.classList.toggle('on',x===b));
      document.querySelectorAll('.pg').forEach(x=>x.classList.toggle('on',x.id==='p-'+b.dataset.p));const t=$('ttl');if(t)t.textContent=TT[b.dataset.p]}});
  const FLT=[['all','ทั้งหมด'],['today','วันนี้'],['act','กำลังใช้งาน'],['done','เสร็จสิ้น'],['bad','ยกเลิก/No-show']];
  $('fl').innerHTML=FLT.map(([k,t])=>`<button type="button" class="ch${k==='all'?' on':''}" data-k="${k}">${t}</button>`).join('');
  $('fl').onclick=e=>{const k=e.target.dataset.k;if(!k)return;filt=k;[...$('fl').children].forEach(c=>c.classList.toggle('on',c.dataset.k===k));drawBookings()};
  $('q').oninput=drawBookings;
  $('q').addEventListener('keydown',e=>{if(e.key==='Enter'&&bk&&bk.truncated)$('qsrv').click()});
  const sb=$('qsrv');if(sb)sb.onclick=()=>{if(srvQ){srvQ='';$('q').value=''}else srvQ=$('q').value.trim().slice(0,30);bkT=0;loadBookings(true)};
  $('floors').onclick=onFloors;
  $('rows').onclick=e=>{const b=e.target.closest('[data-c]');if(b)cancelBooking(b.dataset.c)};
  $('bmode').onclick=()=>{bmode=!bmode;$('bmode').classList.toggle('on',bmode);$('bmode').setAttribute('aria-pressed',bmode);
    $('bhint').textContent=bmode?'โหมดสั่งไม้กั้น: แตะที่ช่องเพื่อสั่งลด/ยกไม้กั้นของช่องนั้น':'แตะที่ช่องเพื่อปิด/เปิดการใช้งาน ช่องที่ปิดผู้ใช้จะจองไม่ได้';draw()};
  $('braise').onclick=raiseAll;
  $('cfg').onsubmit=saveCfg;
  $('csv').onclick=exportCsv;
}
bind();
if(tok){   // มีเซสชันเดิมในแท็บนี้: ตรวจ role จากเซิร์ฟเวอร์ก่อนแสดงอะไรทั้งนั้น
  loadMe().then(u=>{if(ROLES.includes(u.role)){me=u;enter(false)}else{tokSet();showLogin(O.page==='master'?'บัญชีนี้ไม่ใช่ Master Admin':'บัญชีนี้ไม่ใช่ผู้ดูแล')}}).catch(e=>{if(!e||!e.api||e.status!==401){}})}
})();
