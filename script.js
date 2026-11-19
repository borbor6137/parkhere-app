let LANG='th';try{LANG=localStorage.getItem('ph_lang')||'th'}catch(e){}
// ===== โหมดทดสอบ (เฉพาะ localhost / 127.0.0.1 เท่านั้น) =====
// ?api=http://localhost:PORT = ชี้ parkhere-api ในเครื่องที่พอร์ตอื่น (ใช้ได้เฉพาะ localhost)
// ?pay=ok|fail = บังคับผลชำระเงินจำลอง (ระบบจ่ายเงินยังเป็นเดโม) โดเมนอื่นสวิตช์เหล่านี้ไม่มีผล
const DEV_HOST=/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const DEV_Q=new URLSearchParams(DEV_HOST?location.search:'');
const FORCE_PAY=DEV_HOST&&['ok','fail'].includes(DEV_Q.get('pay'))?DEV_Q.get('pay'):'';
// ส่วนต่างเวลาเซิร์ฟเวอร์
let srvOff=0;
const nowS=()=>Date.now()+srvOff;
// srvOff = serverNow ของ parkhere-api - เวลาเครื่อง ณ กึ่งกลางคำขอ: เลือกคำตอบ API ที่ RTT ต่ำสุด (ทิ้งเกิน 5 วิ เช่นตอนปลุก Render) ค่าเก่าเกิน 60 วิยอมให้ค่าใหม่แทน
// snapshot/mine ทางสตรีมมีเฉพาะ serverNow (ไม่รู้ RTT) ถือเป็น RTT 0 วัดตอนรับ ใช้เทียบเวลาของเซิร์ฟเวอร์ (s,e,arr,out) ผ่าน nowS() เท่านั้น
let srvRtt=1e9,srvT=0;
const srvSync=(sn,t0,t1)=>{sn=+sn;if(!(sn>0))return;const b=t1||Date.now(),a=t0||b,rtt=b-a;if(rtt>5000||Math.abs(sn-b)>2592e6)return;if(rtt<=srvRtt||b-srvT>60000){srvRtt=rtt;srvT=b;srvOff=sn-(a+b)/2}};
const isPerm=e=>/permission/i.test(String((e&&(e.code||e.message))||''));
// ข้อความเมื่อ "บันทึกไม่สำเร็จ" (ไม่โชว์รหัส error ดิบ)
const LONGNUM_TXT='ห้ามใส่ตัวเลขยาวติดกัน (13 หลักขึ้นไป) ในชื่อ ทะเบียน หรือป้ายรถ เพื่อป้องกันการใส่เลขบัตร กรุณาแก้แล้วลองใหม่';
const longNum=t=>/d(?:[ -]?d){12}/.test(String(t));   // เหมือนกฎเซิร์ฟเวอร์ (ตรวจเร็วฝั่งเว็บเท่านั้น เซิร์ฟเวอร์ตัดสินจริง)
const saveErr=e=>e&&e.api&&e.status===400&&/เลขยาว|เลขบัตร/.test(e.message||'')?LONGNUM_TXT:e&&e.api&&e.status===429?'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่':e&&e.api&&e.code==='BUSY'?BUSY_TXT:e&&e.api&&e.code==='BAD_INPUT'&&e.message?e.message:isPerm(e)?errTh(e):'บันทึกไม่สำเร็จ '+(e&&(e.code==='offline'||e.code==='timeout'||e.code==='network')?'เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง':'กรุณาลองอีกครั้ง');

const PROV='กรุงเทพมหานคร,กระบี่,กาญจนบุรี,กาฬสินธุ์,กำแพงเพชร,ขอนแก่น,จันทบุรี,ฉะเชิงเทรา,ชลบุรี,ชัยนาท,ชัยภูมิ,ชุมพร,เชียงราย,เชียงใหม่,ตรัง,ตราด,ตาก,นครนายก,นครปฐม,นครพนม,นครราชสีมา,นครศรีธรรมราช,นครสวรรค์,นนทบุรี,นราธิวาส,น่าน,บึงกาฬ,บุรีรัมย์,ปทุมธานี,ประจวบคีรีขันธ์,ปราจีนบุรี,ปัตตานี,พระนครศรีอยุธยา,พะเยา,พังงา,พัทลุง,พิจิตร,พิษณุโลก,เพชรบุรี,เพชรบูรณ์,แพร่,ภูเก็ต,มหาสารคาม,มุกดาหาร,แม่ฮ่องสอน,ยโสธร,ยะลา,ร้อยเอ็ด,ระนอง,ระยอง,ราชบุรี,ลพบุรี,ลำปาง,ลำพูน,เลย,ศรีสะเกษ,สกลนคร,สงขลา,สตูล,สมุทรปราการ,สมุทรสงคราม,สมุทรสาคร,สระแก้ว,สระบุรี,สิงห์บุรี,สุโขทัย,สุพรรณบุรี,สุราษฎร์ธานี,สุรินทร์,หนองคาย,หนองบัวลำภู,อ่างทอง,อำนาจเจริญ,อุดรธานี,อุตรดิตถ์,อุทัยธานี,อุบลราชธานี'.split(',');
const provOpts=()=>PROV.map(p=>`<option>${p}</option>`).join('');
const $=id=>document.getElementById(id);
const show=id=>{document.body.classList.toggle('dark',id==='loading'||id==='entering');document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));$(id).classList.add('active')};
const setMsg=(id,t,type)=>{$(id).textContent=t;$(id).className='msg '+(type||'')};
const errTh=e=>{e=e||{};const c=String(e.code||e.message||'');const m=({
  'timeout':'เชื่อมต่อช้า กรุณาลองอีกครั้ง','offline':'เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง','network':'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองอีกครั้ง'
})[c];
  if(isBusyRead(e))return BUSY_TXT;
  if(e.api)return API_MSG[e.code]||e.message||'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง';   // ข้อผิดพลาดจาก parkhere-api: ใช้ข้อความไทยของสัญญา API
  if(m)return m;
  if(/permission/i.test(c))return 'ไม่มีสิทธิ์บันทึก กรุณารีเฟรชหน้าแล้วลองใหม่';
  if(/network|disconnect|unavailable/i.test(c))return 'เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง';
  try{console.warn('[ParkHere] error',c)}catch(x){}   // รหัสดิบดูได้เฉพาะใน console
  return 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง'};
let session=null;

// ===== parkhere-api (ThingsBoard) =====
// ที่อยู่ API ตั้งจุดเดียวนี้: ตอน deploy ตั้ง window.PH_API_BASE (หรือแก้ค่าเริ่มต้น) ค่าเริ่มต้นสำหรับ dev = api server ในเครื่อง (API_PORT/PORT ค่าเริ่มต้น 10000)
const API_BASE=(()=>{let b=(typeof window.PH_API_BASE==='string'&&window.PH_API_BASE)||'http://localhost:10000';
  const q=DEV_HOST?DEV_Q.get('api'):'';if(q&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(q))b=q;return b.replace(/\/+$/,'')})();
// JWT เก็บในหน่วยความจำ + sessionStorage (ปิดแท็บแล้วหาย) ไม่ใช้ localStorage
const TK='ph_tk';let tok=null,rtok=null;
try{const o=JSON.parse(sessionStorage.getItem(TK)||'null');if(o&&typeof o.t==='string'&&typeof o.r==='string'){tok=o.t;rtok=o.r}}catch(e){}
const tokSet=(t,r)=>{tok=t||null;rtok=r||null;try{if(tok&&rtok)sessionStorage.setItem(TK,JSON.stringify({t:tok,r:rtok}));else sessionStorage.removeItem(TK)}catch(e){}};
const API_MSG={INVALID_CREDENTIALS:'อีเมลหรือรหัสผ่านไม่ถูกต้อง',EMAIL_TAKEN:'อีเมลนี้ถูกใช้แล้ว',WEAK_PASSWORD:'รหัสผ่านไม่ผ่านเงื่อนไขของระบบ ลองตั้งให้ยาวและคาดเดายากขึ้น',
  RATE_LIMIT:'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',UPSTREAM:'ระบบหลังบ้านไม่ตอบสนอง ลองใหม่อีกครั้ง',QUOTA:'ระบบรับสมาชิกเต็มแล้ว กรุณาติดต่อผู้ดูแล',FORBIDDEN:'บัญชีนี้ไม่มีสิทธิ์ใช้ ParkHere',
  BUSY:'ระบบกำลังประมวลผลคำขออื่น กรุณาลองใหม่',WRITES_DISABLED:'ระบบจองยังไม่เปิดใช้งาน',NOT_CONFIGURED:'ระบบลานจอดยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง'};
const WAKE_TXT='กำลังปลุกเซิร์ฟเวอร์… (อาจใช้เวลาประมาณ 1 นาที)';
// แสดง "กำลังปลุกเซิร์ฟเวอร์…" ในช่องข้อความเมื่อคำขอช้าเกิน 3.5 วิ (Render free หลับ) ไม่ใช่ error
const wakeMsg=id=>on=>{const el=$(id);if(!el)return;if(on)setMsg(id,WAKE_TXT);else if(el.textContent===WAKE_TXT)setMsg(id,'')};
// ข้อผิดพลาดจาก API: retry = วินาทีที่ควรรอก่อนลองใหม่ (429/503) จาก Retry-After ถ้าเบราว์เซอร์อ่านได้ (ข้ามโดเมนต้องมี Access-Control-Expose-Headers) ไม่งั้นอ่านจากข้อความ "ใน N วินาที" หรือใช้ค่าเริ่มต้น 5/15 วิ
const apiErr=(r,er,method)=>{const code=er.code||'HTTP_'+r.status,message=typeof er.message==='string'?er.message:'';let n=0;
  if(r.status===429||r.status===503){n=parseInt(r.headers&&r.headers.get&&r.headers.get('Retry-After'),10);if(!(n>0)){const m=/(d+)s*วินาที/.exec(message);n=m?+m[1]:r.status===503?5:15}n=Math.min(Math.max(n,1),60)}
  return {api:1,status:r.status,code,message,retry:n,get:method==='GET'}};
// การอ่านที่ถูกตัดเพราะระบบคับคั่ง/ส่งถี่ (503/429): ไม่ใช่ผลของการจอง
const isBusyRead=e=>!!(e&&e.api&&e.get&&(e.status===503||e.status===429));
const BUSY_TXT='ระบบกำลังคับคั่ง ลองใหม่อีกครั้ง';
async function apiRaw(method,path,body,auth,onWake){
  const ac=new AbortController(),to=setTimeout(()=>ac.abort(),90000),wk=onWake?setTimeout(()=>onWake(true),3500):0,t0=Date.now();
  try{
    const h={};if(body!==undefined)h['Content-Type']='application/json';if(auth&&tok)h.Authorization='Bearer '+tok;
    let r;try{r=await fetch(API_BASE+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),signal:ac.signal,cache:'no-store'})}
    catch(e){throw {code:e&&e.name==='AbortError'?'timeout':'network'}}
    let j=null;try{j=await r.json()}catch(e){}
    if(r.ok){if(j&&j.serverNow)srvSync(j.serverNow,t0,Date.now());return j||{}}
    const er=(j&&j.error)||{};throw apiErr(r,er,method);
  }finally{clearTimeout(to);clearTimeout(wk);if(onWake)onWake(false)}
}
let refreshing=null;
const doRefresh=()=>refreshing||(refreshing=(rtok?apiRaw('POST','/api/refresh',{refreshToken:rtok},false):Promise.reject({api:1,status:401,code:'REFRESH_INVALID'})).then(j=>tokSet(j.token,j.refreshToken)).finally(()=>{refreshing=null}));
// โทเคนหมดอายุ/ใช้ไม่ได้และต่ออายุไม่ได้ -> ล้างเซสชันแล้วกลับหน้าเข้าสู่ระบบ
function sessionLost(){tokSet();if(session){teardown();$('modal').innerHTML='';$('view').innerHTML=''}show('login');setMsg('l-msg','เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง','err')}
// เรียก API: 401 TOKEN_EXPIRED -> refresh หนึ่งครั้งแล้วลองใหม่ ถ้า refresh ล้ม (REFRESH_INVALID) = กลับหน้าเข้าสู่ระบบ
async function api(method,path,body,opt={}){
  const auth=opt.auth!==false;
  try{return await apiRaw(method,path,body,auth,opt.wake)}
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
// รูปแบบข้อมูลในแอป <-> API: รถ "ทะเบียน · จังหวัด" <-> {plate,label} / บัตรเดโม {t:'card'|'pp',info:4 หลักท้าย} <-> {id,label,brand,last4}
const carObj=s=>{s=String(s);const i=s.indexOf(' · ');return i<0?{plate:s}:{plate:s.slice(0,i),label:s.slice(i+3)}};
const carStr=c=>c&&c.label?c.plate+' · '+c.label:String(c&&c.plate||'');
const payObj=p=>({...(p.id?{id:p.id}:{}),label:p.t==='card'?'บัตร':'PromptPay',brand:p.t==='card'?'card':'promptpay',last4:String(p.info).slice(-4)});
const payStr=p=>({t:p.brand==='promptpay'?'pp':'card',info:String(p.last4||''),id:p.id});

// แอนิเมชันหน้าโหลด: ดีเลย์สั้น (ไม่เกิน 600 ms) ไม่ต้องรอ 2.1 วิทุกครั้ง
function load(fillId,next,ms=600){
  const f=$(fillId);f.style.width='0';
  requestAnimationFrame(()=>requestAnimationFrame(()=>f.style.width='100%'));
  setTimeout(next,ms);
}

// เข้าแอป: me = ข้อมูลจาก GET/PUT /api/me (id, email, name, cars, pays)
// การจอง/ใบเสร็จ (books, rcp) เริ่มว่าง (mine='loading') แล้วโหลดจาก GET /api/me/bookings + สตรีม mine (loadMine/mineApply)
// session.uid เป็น id ผู้ใช้ ThingsBoard
async function enter(me,fast){
  const cars=(me.cars||[]).map(carStr),pays=(me.pays||[]).map(payStr);
  let startV='home',startMsg='';
  if(!cars.length){startV='cars';startMsg='บัญชีนี้ยังไม่มีทะเบียนรถ กรุณาเพิ่มทะเบียนรถก่อนจอง'}
  session={uid:me.id,user:me.name||String(me.email||'').split('@')[0],email:me.email,role:me.role,plate:cars[0]||'',cars,pays,books:[],rcp:[],mine:'loading',mineAt:0,wake:0};
  liveStart();loadMine();S.v=startV;S.msg=startMsg;
  pendResume();   // รีเฟรชระหว่าง "กำลังตรวจสอบ": ส่ง reqId เดิมซ้ำ
  if(fast){show('home');render();}
  else{show('entering');load('fill2',()=>{show('home');render()});}
  if(S.req&&S.v==='check')payRun(session);
}

// เริ่ม: หน้าโหลด -> (ถ้ามีโทเคนใน sessionStorage เข้าแอปเลย) หรือหน้า Log in
// อ่านข้อมูลผู้ใช้ช้า/ล้ม: บอกผู้ใช้ พร้อมปุ่มลองใหม่
function bootErr(e){
  show('loading');
  let p=$('boot-retry');if(!p){p=document.createElement('div');p.id='boot-retry';p.setAttribute('role','alert');$('loading').appendChild(p)}
  p.innerHTML=`<p class="msg err">${escH(e&&e.code==='timeout'?'เชื่อมต่อช้า กรุณาลองอีกครั้ง':errTh(e))}</p><button type="button" id="boot-again">ลองใหม่</button><button type="button" class="out" id="boot-login">ไปหน้าเข้าสู่ระบบ</button>`;
  $('boot-again').onclick=()=>{p.remove();bootGo()};
  if(e&&e.retry>0){const bt=$('boot-again');bt.disabled=true;setTimeout(()=>{bt.disabled=false},e.retry*1000)}   // 503/429: รอตาม Retry-After ก่อนให้กดลองใหม่
  $('boot-login').onclick=()=>{p.remove();tokSet();show('login')};
}
// สถานะ "กำลังปลุกเซิร์ฟเวอร์…" บนหน้าโหลด
function bootWake(on){
  let p=$('boot-wake');
  if(!on){if(p)p.remove();return}
  if(!p){p=document.createElement('p');p.id='boot-wake';p.className='msg';p.setAttribute('role','status');$('loading').appendChild(p)}
  p.textContent=WAKE_TXT;
}
async function bootGo(){
  if(!tok){show('login');return}
  try{const me=await api('GET','/api/me',undefined,{wake:bootWake});await enter(me,true)}
  catch(e){if(e&&e.api&&e.status===401)return;bootErr(e)}   // 401: api() พากลับหน้าเข้าสู่ระบบแล้ว
}
load('fill',bootGo);

document.querySelectorAll('[data-go]').forEach(a=>a.onclick=()=>{
  ['l-msg','s-msg','f-msg'].forEach(m=>setMsg(m,''));show(a.dataset.go);
});

$('btn-signup').onclick=async()=>{
  const user=clip($('s-user').value),pass=$('s-pass').value,email=$('s-email').value.trim().toLowerCase(),plate=clip($('s-plate').value);
  if(!user||!pass||!email||!plate)return setMsg('s-msg','กรุณากรอกข้อมูลให้ครบ','err');
  if(!/^\S+@\S+\.\S+$/.test(email))return setMsg('s-msg','รูปแบบอีเมลไม่ถูกต้อง','err');
  if(user.length>40)return setMsg('s-msg','ชื่อยาวได้ไม่เกิน 40 ตัวอักษร','err');
  if(plate.length>12)return setMsg('s-msg','ทะเบียนยาวได้ไม่เกิน 12 ตัวอักษร','err');
  if(pass.length<8||pass.length>64)return setMsg('s-msg','รหัสผ่านต้องยาว 8-64 ตัวอักษร','err');
  if(pass!==$('s-pass2').value)return setMsg('s-msg','รหัสผ่านและการยืนยันรหัสผ่านไม่ตรงกัน','err');
  setMsg('s-msg','กำลังสมัครสมาชิก...');
  try{
    // สมัครแล้วระบบเข้าสู่ระบบให้เลย (ตามสัญญา API)
    const j=await api('POST','/api/signup',{email,password:pass,name:user,plate},{auth:false,wake:wakeMsg('s-msg')});
    tokSet(j.token,j.refreshToken);
    let me=j.user;
    try{me=await api('PUT','/api/me',{cars:[{plate,label:$('s-prov').value}]})}catch(e){if(!tok)return}   // จังหวัดบนป้ายเก็บเป็น label ของรถ (ถ้าบันทึกไม่ได้ ยังมีทะเบียน)
    ['s-user','s-pass','s-pass2','s-email','s-plate'].forEach(i=>$(i).value='');
    setMsg('s-msg','');
    await enter(me);
  }catch(e){setMsg('s-msg',errTh(e),'err')}
};

$('btn-login').onclick=async()=>{
  const email=$('l-email').value.trim(),pass=$('l-pass').value;
  if(!email||!pass)return setMsg('l-msg','กรุณากรอกอีเมลและรหัสผ่าน','err');
  setMsg('l-msg','กำลังเข้าสู่ระบบ...');
  try{
    const j=await api('POST','/api/login',{email,password:pass},{auth:false,wake:wakeMsg('l-msg')});
    tokSet(j.token,j.refreshToken);
    let me;try{me=await api('GET','/api/me')}catch(e){tokSet();throw e}
    $('l-pass').value='';setMsg('l-msg','');
    await enter(me);
  }catch(e){setMsg('l-msg',errTh(e),'err')}
};

$('btn-forgot').onclick=async()=>{
  const email=$('f-email').value.trim();
  if(!email)return setMsg('f-msg','กรุณากรอกอีเมล','err');
  if(!/^\S+@\S+\.\S+$/.test(email))return setMsg('f-msg','รูปแบบอีเมลไม่ถูกต้อง','err');
  setMsg('f-msg','กำลังส่งลิงก์...');
  try{
    await api('POST','/api/forgot',{email},{auth:false,wake:wakeMsg('f-msg')});
    $('f-email').value='';setMsg('f-msg','');show('login');setMsg('l-msg','ถ้าอีเมลนี้มีบัญชีอยู่ ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้ (ตรวจกล่องสแปมด้วย)','ok');
  }catch(e){setMsg('f-msg',errTh(e),'err')}
};

// กด Enter ในช่องกรอก: login = เข้าสู่ระบบ, signup = สมัคร, forgot = ส่งลิงก์ (ไม่ไปกดปุ่มรูปตาแสดง/ซ่อนรหัสผ่าน)
const ENTER_BTN={login:'btn-login',signup:'btn-signup',forgot:'btn-forgot'};
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter'||e.isComposing||e.target.tagName!=='INPUT')return;
  const a=document.querySelector('.screen.active'),b=a&&ENTER_BTN[a.id]&&$(ENTER_BTN[a.id]);
  if(b&&a.contains(e.target)){e.preventDefault();b.click()}
});

// ===== หน้าหลักของแอป =====
let N=6,RATE=20,BOOKFEE=20,FREEMIN=30,FL=3,NOSHOW_MIN=30; // ค่าตั้งต้นชั่วคราวก่อนได้ snapshot แรก (ถูกทับด้วย config ที่ GET /api/lot คืนมา ผ่าน applyCfg) หน้าจอไม่ใช้ตัดสินใจจนกว่าจะได้ snapshot
const floors=()=>Array.from({length:FL},(_,k)=>k+1);
// config จาก API (ค่าที่ขาดคงค่าเดิมไว้ ไม่เปลี่ยนความหมายของสูตรราคา)
const applyCfg=c=>{N=+c.slots||N;FL=+c.floors||FL;RATE=+c.rate||RATE;BOOKFEE=c.bookfee!=null?+c.bookfee:BOOKFEE;FREEMIN=c.freemin!=null?+c.freemin:FREEMIN;NOSHOW_MIN=+c.noshow||NOSHOW_MIN;};
let takenMap={};
let sensorMap={},closedMap={},gateWait=null;
// สถานะลานจอดสด (M2): snapshot จาก GET /api/lot ผ่าน GET /api/live (SSE) (เซนเซอร์ สถานะบอร์ด ไม้กั้น config ช่องปิด และรายการจองของช่อง)
let lot=null,slotMap={},boards=[],boardAgg=null,lotStale=false;   // lot=null: ยังไม่เคยได้รับ snapshot
const refresh=()=>{if(session&&S.s==null&&!S.t&&S.v!=='check'&&S.v!=='pay')render()};
// ผู้ดูแลยกเลิกการจอง: เซิร์ฟเวอร์เปลี่ยนสถานะ + คืนค่าจองเอง เว็บรับผ่านรายการ mine (status cancelled, by admin) แล้วเรียก showCancelPopup จาก mineApply
let resetSeen=null;
function onReset(){if(!session)return;session.books=[];session.rcp=[];S.t=null;S.s=null;S.d=null;if(['pay','check','map'].includes(S.v))S.v='home';toast('ผู้ดูแลรีเซ็ตข้อมูลทั้งระบบ การจองและใบเสร็จถูกล้างแล้ว');refresh()}
const escH=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function showCancelPopup(b,reason){
  const d=document.createElement('div');d.className='back';d.style.cssText='align-items:center;z-index:70';
  d.innerHTML=`<div class="modal" style="border-radius:24px;text-align:center;padding:28px 24px"><div style="font-size:46px">🚫</div><h2 style="margin:10px 0 8px">ที่จอดที่คุณจองถูกยกเลิก</h2><p style="margin:0 0 6px"><b>${escH(sName(b.f,b.i))}</b> · ${escH(b.car)}</p><p class="note" style="margin:0">ผู้ดูแลระบบยกเลิกการจองนี้${reason?'<br>เหตุผล: '+escH(reason):''}</p>${b.amt?`<p class="okc" style="margin:10px 0 0">คืนค่าจอง ฿${escH(b.amt)} แล้ว</p>`:''}<button>ตกลง</button></div>`;
  d.querySelector('button').onclick=()=>d.remove();document.body.appendChild(d);
  try{if(window.Notification&&Notification.permission==='granted')new Notification('ParkHere',{body:LANG==='en'?tr('ที่จอด '+sName(b.f,b.i)+' ที่คุณจองถูกยกเลิก'):'ที่จอด '+sName(b.f,b.i)+' ที่คุณจองถูกยกเลิก'})}catch(e){}
}
function showRolePopup(c){
  const up=c.type==='promote',d=document.createElement('div');d.className='back';d.style.cssText='align-items:center;z-index:80';
  d.innerHTML=`<div class="modal" style="border-radius:24px;text-align:center;padding:28px 24px"><div style="font-size:46px">${up?'🛡️':'🔒'}</div><h2 style="margin:10px 0 8px">${up?'คุณได้รับแต่งตั้งเป็นผู้ดูแลระบบ':'สิทธิ์ผู้ดูแลระบบของคุณถูกยกเลิก'}</h2>${up?`<p style="margin:0 0 6px">ผู้ดูแลสูงสุดแต่งตั้งคุณเป็นผู้ดูแลระบบแล้ว</p>${c.username?`<p style="margin:0 0 6px">ชื่อผู้ใช้ผู้ดูแลระบบ: <b>${escH(c.username)}</b></p>`:''}<p class="note" style="margin:0">รหัสผ่านจะได้รับจากผู้ดูแลสูงสุดโดยตรง</p>`:'<p class="note" style="margin:0">บัญชีของคุณเข้าหน้าผู้ดูแลระบบไม่ได้อีก</p>'}<button>ตกลง</button></div>`;
  d.querySelector('button').onclick=()=>d.remove();document.body.appendChild(d);
  try{if(window.Notification&&Notification.permission==='granted')new Notification('ParkHere',{body:up?'คุณได้รับแต่งตั้งเป็นผู้ดูแลระบบ':'สิทธิ์ผู้ดูแลระบบของคุณถูกยกเลิก'})}catch(e){}
}
// ===== สถานะลานจอดสด (M2): GET /api/live แบบ fetch-streaming + Authorization: Bearer (ไม่ใช้ EventSource ไม่ใส่ token ใน URL) =====
// สัญญา: docs/migration/M2-api.md  occ true/false/null (null = ไม่ทราบ ห้ามแสดงเป็น "ว่าง") · conflict=true = ไม่ทราบ · reconnect แล้วทิ้งของเดิมใช้ snapshot ใหม่
// M3 เสร็จฝั่งเว็บ: การจอง/ออก/ใบเสร็จ/รถมาถึง/no-show/ผู้ดูแลยกเลิก/เวลา ย้ายไป parkhere-api แล้ว (ดู bookSlot/payRun/leaveBooking/mineApply) เซิร์ฟเวอร์ตัดสินช่องไม่ทราบสถานะ/ปิด/มีรถเองเสมอ (เว็บตรวจเร็วด้วย unk/isClosed เพื่อตอบไวเท่านั้น)
// ส่วนที่ยังค้างจากแผนย้าย:
//  M5: onReset() (config.resetAt ไม่มีใน API) · showRolePopup() ยังไม่มีใครเรียก: แจ้งเลื่อน/ลดสิทธิ์ต้องมีทางส่งจากเซิร์ฟเวอร์ (เช่นเทียบ role จาก GET /api/me ตอนต่อสตรีมใหม่)
const KRE=/^\d{1,2}-\d{1,3}$/,OLD_MS=20000,GONE_ST=['cancelled','noshow','done','out'];
const LIVE={nb:0,ac:null,st:'off',n:0,rfn:0,tm:0,gen:0,rx:0,t0:0,off:0,old:0,end:''};   // st: off|connecting|wake|live|retry|busy|notconf|paused|replaced
const liveOk=()=>LIVE.st==='live';
// หลุดจากสตรีมเกิน 20 วิ = ข้อมูลที่ค้างอยู่ไม่น่าเชื่อถือ แสดงเป็น "ไม่ทราบสถานะ" แทนการโชว์ว่าง/มีรถจากของเก่า
const dataOld=()=>!!lot&&!liveOk()&&!!LIVE.off&&Date.now()-LIVE.off>OLD_MS;
// แปลงข้อมูลช่องจาก API เป็นโครงเดิมที่หน้าจอใช้: sensorMap (เฉพาะ true/false) และ takenMap (การจองที่เห็นได้ s,e,mine)
function derive(k){
  const s=slotMap[k];
  if(s&&typeof s.occ==='boolean')sensorMap[k]=s.occ;else delete sensorMap[k];
  const o={};((s&&Array.isArray(s.bookings)&&s.bookings)||[]).forEach((b,n)=>{if(b&&+b.e>0&&!GONE_ST.includes(b.status))o[typeof b.id==='string'&&b.id?b.id:'o'+n]={s:+b.s,e:+b.e,mine:!!b.mine,status:b.status}});
  if(Object.keys(o).length)takenMap[k]=o;else delete takenMap[k];
}
function lotApply(d){
  if(!d||!Array.isArray(d.slots))return false;
  srvSync(d.serverNow);
  slotMap={};sensorMap={};takenMap={};
  d.slots.forEach(s=>{if(s&&KRE.test(s.k)){slotMap[s.k]=s;derive(s.k)}});
  boardAgg=d.board&&typeof d.board==='object'?d.board:null;boards=Array.isArray(d.boards)?d.boards:[];
  closedMap=d.closed&&typeof d.closed==='object'?d.closed:{};lotStale=!!d.stale;
  if(d.config&&typeof d.config==='object')applyCfg(d.config);
  lot=1;return true;
}
function liveEv(n,d){
  if(!d||typeof d!=='object')return;
  if(n==='snapshot'){if(lotApply(d)){LIVE.n=0;LIVE.rfn=0;liveSet('live');onGate();refresh()}return}
  if(n==='end'){LIVE.end=String(d.reason||'');return}
  if(n==='mine'){if(mineApply(d))refresh();return}   // รายการของตัวเอง (ส่งหลัง snapshot ทุกครั้งที่ต่อ และเมื่อเปลี่ยน) ไม่ต้องรอ snapshot
  if(!lot)return;   // ต้องมี snapshot ก่อนจึงจะรับ diff
  if(n==='slot'){if(!KRE.test(d.k))return;slotMap[d.k]=Object.assign(slotMap[d.k]||{k:d.k},d);derive(d.k);onGate()}
  else if(n==='bookings'){if(!KRE.test(d.k))return;slotMap[d.k]=slotMap[d.k]||{k:d.k};slotMap[d.k].bookings=Array.isArray(d.bookings)?d.bookings:[];derive(d.k)}
  else if(n==='board'){if(d.board&&typeof d.board==='object')boardAgg=d.board;if(Array.isArray(d.boards))boards=d.boards}
  else if(n==='closed'){closedMap=d.closed&&typeof d.closed==='object'?d.closed:{}}
  else if(n==='config'){if(d.config&&typeof d.config==='object')applyCfg(d.config)}
  else if(n==='upstream'){lotStale=!!d.stale;liveUI()}
  else return;   // ping และ event ที่ไม่รู้จัก
  refresh();
}
function liveBlock(b){
  const ev=/^event: (.+)$/m.exec(b),da=/^data: (.+)$/m.exec(b);
  if(!ev||!da)return;let d;try{d=JSON.parse(da[1])}catch(e){return}
  liveEv(ev[1],d);
}
function liveSet(st){
  const was=LIVE.st;LIVE.st=st;clearTimeout(LIVE.old);
  if(st==='live')LIVE.off=0;
  else{if(was==='live'||!LIVE.off)LIVE.off=Date.now();if(lot&&st!=='off')LIVE.old=setTimeout(()=>{liveUI();refresh()},Math.max(0,LIVE.off+OLD_MS-Date.now())+300)}
  liveUI();if(was!==st)refresh();
}
const LV_TXT={live:'เชื่อมต่อสดอยู่',stale:'ข้อมูลอาจไม่ล่าสุด (ระบบหลังบ้านอ่านข้อมูลจากบอร์ดไม่ได้ชั่วคราว)',connecting:'กำลังเชื่อมต่อสถานะที่จอด…',
  retry:'การเชื่อมต่อสดหลุด กำลังเชื่อมต่อใหม่… ข้อมูลที่เห็นอาจไม่ล่าสุด',busy:BUSY_TXT+' (กำลังลองใหม่อัตโนมัติ)',
  notconf:'ระบบสถานะที่จอดยังไม่พร้อมใช้งาน กำลังลองใหม่…',replaced:'ปิดการเชื่อมต่อสดนี้แล้ว เพราะเปิดหน้านี้พร้อมกันเกิน 3 แท็บ/อุปกรณ์'};
function liveUI(){
  const el=$('livebar');if(!el)return;const st=LIVE.st;
  if(!session||st==='off'){el.hidden=true;el.dataset.k='';return}
  if(st==='paused')return;   // แท็บถูกซ่อน ไม่มีใครเห็น
  let k='warn',t=LV_TXT[st],btn='';
  if(st==='live'){if(lotStale)t=LV_TXT.stale;else k='ok'}
  else if(st==='wake')t=WAKE_TXT;
  else if(st==='replaced'){k='bad';btn='เชื่อมต่อใหม่'}
  else if(st==='retry'||st==='busy'||st==='notconf'){btn='ลองใหม่ตอนนี้';if(dataOld())k='bad'}
  const key=k+'|'+t+'|'+btn+'|'+LANG;if(el.dataset.k===key&&!el.hidden)return;el.dataset.k=key;
  el.hidden=false;el.className='livebar '+k;
  el.innerHTML='<span class="lv-dot" aria-hidden="true"></span><span class="lv-t">'+escH(t)+'</span>'+(btn?'<button type="button" class="lv-btn" data-lv="go">'+btn+'</button>':'');
}
function liveLater(min=0){   // เชื่อมใหม่แบบหน่วงเพิ่มขึ้น 1,2,4,8,15 วิ (+สุ่มเล็กน้อย) และไม่เร็วกว่า Retry-After (min, ms) ที่เซิร์ฟเวอร์สั่ง
  const d=Math.max(min,Math.min(15000,1000*2**Math.min(LIVE.n,4)))*(.85+Math.random()*.3)+(min?500:0);LIVE.n++;
  LIVE.nb=Date.now()+d;clearTimeout(LIVE.tm);LIVE.tm=setTimeout(liveRun,d);
}
// ผู้ใช้กด "ลองใหม่ตอนนี้"/กลับมาออนไลน์/กลับมาที่แท็บ: ถ้ายังไม่ถึงเวลาที่เซิร์ฟเวอร์ให้รอ ให้รอถึงเวลานั้น (ไม่ยิงซ้ำถี่ ๆ จนเกินเพดาน 30 ครั้ง/นาที)
function liveNow(){const w=(LIVE.nb||0)-Date.now();if(w>0&&['retry','busy','notconf'].includes(LIVE.st))return;liveRun()}
function liveStop(st){LIVE.gen++;clearTimeout(LIVE.tm);const a=LIVE.ac;LIVE.ac=null;if(a)try{a.abort()}catch(e){}liveSet(st)}
function liveStart(){if(!session||['live','connecting','wake','retry','busy','notconf'].includes(LIVE.st))return;liveRun()}
async function liveRefresh(){   // JWT หมดอายุระหว่างดู -> ต่ออายุแล้วเชื่อมใหม่ทันที (กันวนไม่รู้จบ: เกิน 2 รอบติด ๆ ให้ถอยหลัง)
  const g=LIVE.gen;
  if(LIVE.rfn++>=2){liveSet('retry');return liveLater()}
  try{await doRefresh()}catch(e){if(g!==LIVE.gen)return;if(e&&e.api){sessionLost();return}liveSet('retry');return liveLater()}
  if(g===LIVE.gen)liveRun();
}
async function liveRun(){
  if(!session||!tok)return;
  if(document.hidden)return liveStop('paused');
  const g=++LIVE.gen;clearTimeout(LIVE.tm);if(LIVE.ac)try{LIVE.ac.abort()}catch(e){}
  const ac=LIVE.ac=new AbortController(),wk=setTimeout(()=>{if(g===LIVE.gen&&!liveOk())liveSet('wake')},3500);
  LIVE.t0=LIVE.rx=Date.now();LIVE.end='';
  if(['off','paused','replaced'].includes(LIVE.st))liveSet('connecting');
  try{
    const r=await fetch(API_BASE+'/api/live',{headers:{Authorization:'Bearer '+tok,Accept:'text/event-stream'},signal:ac.signal,cache:'no-store'});
    if(g!==LIVE.gen)return;
    if(!r.ok){let j=null;try{j=await r.json()}catch(e){}const er=(j&&j.error)||{};throw apiErr(r,er,'GET')}
    if(!r.body||!r.body.getReader)throw {code:'network'};
    clearTimeout(wk);
    const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
    for(;;){
      const x=await rd.read();if(g!==LIVE.gen)return;if(x.done)break;
      LIVE.rx=Date.now();buf+=dec.decode(x.value,{stream:true}).replace(/\r\n/g,'\n');
      let i;while((i=buf.indexOf('\n\n'))>=0){const b=buf.slice(0,i);buf=buf.slice(i+2);liveBlock(b)}
      if(LIVE.end==='replaced'||LIVE.end==='token-expired')break;
    }
  }catch(e){
    clearTimeout(wk);if(g!==LIVE.gen)return;
    const c=e&&e.api?e.code:'';
    if(e&&e.api&&e.status===401){if(c==='TOKEN_EXPIRED')return liveRefresh();return sessionLost()}
    LIVE.ac=null;const bz=isBusyRead(e)||c==='BUSY';liveSet(bz?'busy':c==='NOT_CONFIGURED'?'notconf':'retry');return liveLater(bz&&e.retry?e.retry*1000:0);
  }
  clearTimeout(wk);if(g!==LIVE.gen)return;
  const why=LIVE.end;
  if(why==='replaced')return liveStop('replaced');   // อย่าเชื่อมใหม่เอง ไม่งั้นแท็บแย่งกัน
  if(why==='token-expired'){try{ac.abort()}catch(e){}return liveRefresh()}
  LIVE.ac=null;liveSet('retry');liveLater();   // server ปิด (shutdown/จบเอง)
}
// watchdog: เงียบเกิน 45 วิ (ping มาทุก 20 วิ) หรือเชื่อมไม่ติดเกิน 90 วิ = ตัดแล้วเชื่อมใหม่
setInterval(()=>{if(!session||!LIVE.ac)return;const t=Date.now();if(liveOk()?t-LIVE.rx>45000:t-LIVE.t0>90000)try{LIVE.ac.abort()}catch(e){}},5000);
// แท็บถูกซ่อน = ปิดสตรีม (ประหยัดโควตา) กลับมาแล้วต่อใหม่และรับ snapshot ใหม่ ส่วน "replaced" ไม่ต่อเองจนกว่าผู้ใช้กดปุ่ม
document.addEventListener('visibilitychange',()=>{
  if(!session)return;
  if(document.hidden){if(LIVE.st!=='replaced')liveStop('paused')}
  else if(LIVE.st==='paused'){LIVE.n=0;liveRun()}
});
window.addEventListener('online',()=>{if(session&&['retry','busy','notconf'].includes(LIVE.st)){LIVE.n=0;liveNow()}});
window.addEventListener('pagehide',()=>{if(LIVE.ac)try{LIVE.ac.abort()}catch(e){}});
$('livebar').addEventListener('click',e=>{if(e.target.closest('[data-lv]')&&session){LIVE.n=0;LIVE.rfn=0;if(LIVE.st==='replaced')liveRun();else liveNow()}});
// ออกจากระบบ/เปลี่ยนบัญชี: ปิดสตรีมสด + ปลด listener ที่เหลือ ล้างค่าของผู้ใช้คนก่อน แล้วรอบหน้า liveStart จะต่อใหม่ได้ (QA10)
function teardown(){
  liveStop('off');
  takenMap={};sensorMap={};closedMap={};lot=null;slotMap={};boards=[];boardAgg=null;lotStale=false;LIVE.off=0;LIVE.n=0;LIVE.rfn=0;resetSeen=null;
  if(gateWait){clearTimeout(gateWait.to);gateWait=null}
  [notified,LEAVING].forEach(o=>Object.keys(o).forEach(k=>delete o[k]));
  session=null;S={v:'home',f:1,s:null,d:null,pm:'pp',msg:''};lastKey='';
  try{sessionStorage.removeItem(PEND)}catch(e){}
  const t=$('toast');if(t)t.classList.remove('show');
}
// ลดไม้กั้นที่ช่องจอดจากแอป (M4): POST /api/barrier {f,i,down:true} เซิร์ฟเวอร์ตรวจการจองของเรา/ยังไม่มาถึง/สถานะสดเอง
// sent:true = "ส่งคำสั่งแล้ว" เท่านั้น ไม่ใช่ "ลดแล้ว": แสดง "ลดแล้ว" เมื่อ SSE รายงาน barrier==='down' ของช่องนั้น (bar_ จากบอร์ด) เท่านั้น
const canGate=b=>stat(b)==='a'&&!b.arr;   // จองอยู่และรถยังไม่เข้าช่อง
const barDown=b=>{const o=slotMap[b.f+'-'+b.i];return !!(o&&o.barrier==='down')};
const gateBtn=(b,c='sm')=>!canGate(b)?'':barDown(b)?`<button class="${c}" disabled>✅ ไม้กั้นลดแล้ว</button>`:`<button class="${c}" data-a="gate" data-id="${escH(b.id)}">${gateWait&&gateWait.id===b.id?'⏳ กำลังลดไม้กั้น…':'🚧 ลดไม้กั้น'}</button>`;
const GATE_UNSURE='ยังไม่ทราบผลคำสั่งไม้กั้น กรุณาดูสถานะไม้กั้นจากแผนที่ก่อนกดซ้ำ';
const GATE_SLOW='รอผลคำสั่งไม้กั้นเกิน 20 วินาทีแล้วแต่ยังไม่ทราบผล กรุณาดูสถานะไม้กั้นจากแผนที่ก่อนกดซ้ำ';   // รอคำตอบจากเซิร์ฟเวอร์เกิน GATE_REQ_MS
const GATE_NET='ยังไม่ทราบผลคำสั่งไม้กั้น อาจเพราะอินเทอร์เน็ตหลุด กรุณาตรวจสอบอินเทอร์เน็ต แล้วดูสถานะไม้กั้นจากแผนที่ก่อนกดซ้ำ';   // fetch ล้มเหลว (ไม่ทราบว่าคำขอถึงเซิร์ฟเวอร์หรือไม่) ยังถือเป็น "ไม่ทราบผล"
const GATE_REQ_MS=20000,GATE_SSE_MS=15000;   // ข้อความ GATE_SLOW/GATE_NOCONF ระบุ 20/15 วินาทีตามค่านี้
const GATE_NOCONF='ส่งคำสั่งแล้ว แต่ไม่ได้รับการยืนยันว่าไม้กั้นลดลงภายใน 15 วินาที กรุณาดูที่ช่องจอดก่อนกดซ้ำ';
const GATE_MSG={BARRIER_DISABLED:'ระบบสั่งไม้กั้นยังไม่เปิดใช้งาน กรุณาติดต่อเจ้าหน้าที่',
  SLOT_UNKNOWN:'ยังไม่ทราบสถานะช่องนี้ (บอร์ดอาจออฟไลน์) จึงสั่งไม้กั้นไม่ได้ กรุณาลองใหม่ภายหลัง',
  SLOT_OCCUPIED:'มีรถอยู่ในช่องนี้แล้ว จึงลดไม้กั้นไม่ได้',
  NOT_YOUR_BOOKING:'ไม่พบการจองที่ใช้งานอยู่ของคุณในช่องนี้',
  ALREADY_ARRIVED:'รถของคุณเข้าช่องแล้ว ไม่ต้องลดไม้กั้น',
  SLOT_CLOSED:'ช่องนี้ปิดใช้งานอยู่',
  SLOT_CONFLICT:'ข้อมูลช่องนี้ขัดแย้งกัน กรุณาแจ้งเจ้าหน้าที่',
  COOLDOWN:'เพิ่งสั่งไม้กั้นช่องนี้ไป กรุณารอสักครู่แล้วลองอีกครั้ง',
  BOARD_OFFLINE:'ส่งคำสั่งไปถึงบอร์ดไม่ได้ (บอร์ดอาจออฟไลน์) กรุณาลองอีกครั้ง',
  FORBIDDEN:'บัญชีนี้ไม่มีสิทธิ์ลดไม้กั้น',
  NO_SLOT:'ไม่พบช่องจอดนี้'};
// ข้อความไทยของข้อผิดพลาดไม้กั้น: รหัสที่รู้จัก -> ข้อความเฉพาะ, RATE_LIMIT/BUSY/UPSTREAM/BAD_INPUT/401 -> ข้อความกลาง, ที่เหลือ (timeout/network/5xx ไม่มีรหัส) = ไม่ทราบผล
const gateErr=e=>e&&e.api?(GATE_MSG[e.code]||(['RATE_LIMIT','BUSY','UPSTREAM','BAD_INPUT'].includes(e.code)?errTh(e):GATE_UNSURE)):e&&(e.code==='network'||e.code==='offline')?GATE_NET:GATE_UNSURE;
async function openGate(b){
  if(gateWait)return toast('กำลังส่งคำสั่งลดไม้กั้น…');
  if(!sigOk())toast('⚠️ ไม่ได้รับสัญญาณจากบอร์ด คำสั่งอาจไปไม่ถึงไม้กั้น');
  const u=session,w={id:b.id,b,to:0};gateWait=w;
  const done=msg=>{if(gateWait!==w)return;clearTimeout(w.to);gateWait=null;if(msg)toast(msg);render()};
  w.to=setTimeout(()=>done(GATE_SLOW),GATE_REQ_MS);
  render();
  try{
    const j=await api('POST','/api/barrier',{f:b.f,i:b.i,down:true},{wake:on=>{if(on&&session===u)toast(WAKE_TXT)}});
    if(session!==u||gateWait!==w)return;
    // ส่งถึงบอร์ดแล้วหรือบอร์ดอยู่ในสถานะนี้แล้ว: รอ SSE ยืนยัน (ไม่ประกาศ "ลดแล้ว" จากคำตอบนี้) ถ้าไม่ยืนยันใน 15 วิ แจ้งว่ายังไม่ยืนยัน
    clearTimeout(w.to);w.to=setTimeout(()=>done(GATE_NOCONF),GATE_SSE_MS);
    onGate();
  }catch(e){done(session===u?gateErr(e):'')}
}
function onGate(){
  if(!gateWait||!barDown(gateWait.b))return;
  const b=gateWait.b;clearTimeout(gateWait.to);gateWait=null;
  toast('✅ ไม้กั้นช่อง '+sName(b.f,b.i)+' ลดลงแล้ว เชิญเข้าจอด',null,true);render();
}
const occ=(f,i)=>sensorMap[f+'-'+i]===true;
// ไม่ทราบสถานะ (นโยบาย D5): ไม่มีข้อมูลช่อง / occ เป็น null (บอร์ดออฟไลน์หรือไม่มีบอร์ด) / conflict (บอร์ดสองตัวส่งช่องเดียวกัน) / สตรีมหลุดนานเกิน 20 วิ ห้ามตีเป็น "ว่าง" และห้ามจอง
const unk=(f,i)=>{const o=slotMap[f+'-'+i];return !o||o.conflict===true||typeof o.occ!=='boolean'||dataOld()};
const mask=n=>{n=n?String(n):'';return n?escH((n.length>3?n.slice(0,3):n.slice(0,1)))+'####':''};
const clip=s=>String(s||'').replace(/[<>"'&`]/g,'').trim();   // ตัดอักขระที่ทำให้หน้าเว็บพัง ออกจากชื่อ/ทะเบียนที่ผู้ใช้พิมพ์
const slotInfo=(f,i)=>{
  const k=f+'-'+i,mine=new Set(session.books.map(b=>b.id)),loc=LANG==='en'?'en-GB':'th-TH';
  const tm=t=>new Date(t).toLocaleTimeString(loc,{timeStyle:'short'});
  const L=Object.entries(takenMap[k]||{}).filter(([id,b])=>b.e>nowS()).sort((a,b)=>a[1].s-b[1].s);
  return '<div class="sinfo"><b>ช่วงเวลาที่ช่องนี้ถูกจองไว้:</b>'+(L.map(([id,b])=>`<div>👤 ${mine.has(id)||b.mine?(LANG==='en'?'You':'คุณ'):mask(b.u)||'ผู้ใช้อื่น'} จองไว้ตั้งแต่ ${fmt(b.s)}</div>`).join('')||'<div>ยังไม่มีใครจองช่องนี้</div>')+'</div>'};
const resv=(f,i)=>slotBusyAt(f+'-'+i,nowS(),nowS()+1);
// ใช้แสดงข้อความ "ยกเลิกอัตโนมัติถ้ารถไม่มาใน N นาที" และเตือนก่อนส่งคำสั่งไม้กั้น (ตัดสินมาถึง/no-show/ออกอยู่ที่เซิร์ฟเวอร์แล้ว): ต้องมีสตรีมสดอยู่ ข้อมูลไม่ stale และมีบอร์ดออนไลน์อย่างน้อยหนึ่งตัว
const sigOk=()=>liveOk()&&!lotStale&&!!(boardAgg&&boardAgg.online);
const unkN=f=>[...Array(N).keys()].filter(i=>!isClosed(f,i)&&unk(f,i)).length;
const sigHtml=()=>{
  let c='',t;
  if(!lot)return '';   // ยังไม่ได้ snapshot: หน้าจอแสดง "กำลังโหลด…" อยู่แล้ว
  if(dataOld()){c='bad';t='🔴 ไม่ได้รับข้อมูลสดจากเซิร์ฟเวอร์ ช่องทั้งหมดแสดงเป็น "ไม่ทราบสถานะ"'}
  else{
    const st=boardAgg&&boardAgg.status,n=Object.values(slotMap).filter(o=>typeof o.occ!=='boolean'||o.conflict===true).length;
    if(boardAgg&&boardAgg.online){if(n){c='warn';t='🟡 บางช่องไม่ทราบสถานะ (ไม่ได้รับสัญญาณจากบอร์ดของช่องนั้น) จองไม่ได้'}else{c='ok';t='🟢 เซนเซอร์/กล้องออนไลน์'}}
    else if(st==='offline'){c='bad';t='🔴 ไม่ได้รับสัญญาณ ช่องที่ไม่ทราบสถานะจะจองไม่ได้'}
    else if(st==='error'){c='bad';t='🔴 อ่านสถานะบอร์ดไม่ได้ชั่วคราว ช่องที่ไม่ทราบสถานะจะจองไม่ได้'}
    else t='⚪ ยังไม่ได้เชื่อมต่อบอร์ด ทุกช่องไม่ทราบสถานะ จึงจองไม่ได้';
    if(lotStale)t+=' · ข้อมูลอาจไม่ล่าสุด';
  }
  return `<div class="sig ${c}">${t}</div>`};
const parkMin=b=>Math.max(1,Math.ceil(((b.out||nowS())-bs(b))/6e4));
const slotBusyAt=(k,s,e,skip)=>Object.entries(takenMap[k]||{}).some(([id,b])=>id!==skip&&b.s<e&&b.e>s);
// ออกจากลานจอด: POST /api/bookings/:id/leave เซิร์ฟเวอร์คิดเวลาออก นาที และค่าจอดเอง (เว็บไม่คำนวณยอดจริง ไม่เปลี่ยนสถานะเอง) ทำซ้ำได้ผลเดิม
async function leaveBooking(b){
  const u=session,id=b.id;LEAVING[id]=1;
  const unsureL='ยังไม่ทราบผลการออกจากลานจอด กรุณาลองกดอีกครั้ง หรือตรวจดูที่ "การจองของฉัน"';
  try{
    const j=await api('POST','/api/bookings/'+encodeURIComponent(id)+'/leave',{},{wake:on=>{if(on&&session===u)toast(WAKE_TXT)}});
    const nb=bookFromApi(j&&j.booking);if(!nb)throw {code:'BAD_RESPONSE'};
    if(session!==u)return;
    upsertMine(nb,j.receipt?rcpFromApi(j.receipt):null,numIn(j.serverNow,1,9e15));delete LEAVING[id];
    toast(nb.park?'ออกจากลานจอดแล้ว · ค่าจอด ฿'+nb.park:'ออกจากลานจอดแล้ว ฟรี ขอบคุณที่ใช้บริการ');
  }catch(e){
    if(session!==u)return;
    delete LEAVING[id];
    const c=e&&e.api?e.code:'';
    if(unsure(e)){toast(unsureL);loadMine()}
    else if(c==='NOT_FOUND'){toast('ไม่พบการจองนี้');loadMine()}
    else if(c==='NOT_ACTIVE'){toast('การจองนี้จบไปแล้ว');loadMine()}
    else toast(errTh(e));
  }
  render();
}
const isIn=b=>!!(b.arr||(stat(b)==='a'&&barDown(b)));   // เดโม: ลดไม้กั้นแล้ว = ถือว่าเข้าจอดแล้ว
const outBtn=(b,c='sm')=>LEAVING[b.id]?`<button class="${c}" disabled>กำลังบันทึก…</button>`:`<button class="${c}" data-a="out" data-id="${escH(b.id)}">${isIn(b)?'ออกจากลานจอด':'ยกเลิกการจอง'}</button>`;
// บันทึกรถ + บัตรเดโมผ่าน PUT /api/me (ส่งอาร์เรย์ทั้งชุด) แล้วรับ id ของบัตรกลับมา
// id ของบัตรออกโดยเซิร์ฟเวอร์เท่านั้น: ส่ง id เฉพาะที่เคยได้จาก response แล้วเอา id จาก response ใส่กลับในออบเจ็กต์เดิม (ไม่แทนที่ทั้งอาร์เรย์ กันแก้ไขที่เกิดระหว่างรอหาย) เรียงคิวทีละคำขอ
let ppQ=Promise.resolve();
const persistProfile=()=>ppQ=ppQ.catch(()=>{}).then(async()=>{const u=session;if(!u)return;const sent=u.pays.slice(),me=await api('PUT','/api/me',{cars:u.cars.map(carObj),pays:sent.map(payObj)});
  const rp=Array.isArray(me.pays)?me.pays:[];if(session===u&&rp.length===sent.length)sent.forEach((p,n)=>{if(rp[n]&&typeof rp[n].id==='string')p.id=rp[n].id})});
// ===== การจอง/ใบเสร็จของฉัน: GET /api/me/bookings (ตอนเข้า/ลองใหม่) + SSE event mine (แทนที่ทั้งชุด เซิร์ฟเวอร์คือความจริงเดียว) =====
// u.mine: loading = ยังไม่เคยได้รายการ (ห้ามแสดง "ยังไม่มีการจอง") · ok · err = โหลดไม่สำเร็จและยังไม่เคยได้รายการ (มีปุ่มลองใหม่)
// u.mineAt = serverNow ล่าสุดที่รับ: คำตอบ/event ที่เก่ากว่าถูกทิ้ง (กัน GET ที่ช้ากว่าเขียนทับ mine ที่ใหม่กว่า)
const LEAVING={};   // id การจองที่กำลังกดออกจากลานจอด (กันกดซ้ำ และกัน toast "ตรวจพบรถออก" ซ้ำกับผลของปุ่มเอง)
const seenKey=u=>'ph_seen_cancel_'+u.uid;
function seenLoad(u){let a=[];try{a=JSON.parse(localStorage.getItem(seenKey(u))||'[]')}catch(e){}return new Set(Array.isArray(a)?a.filter(x=>typeof x==='string').slice(-50):[])}
function mineApply(d){
  const u=session;if(!u||!d||typeof d!=='object'||!Array.isArray(d.books))return false;
  const at=numIn(d.serverNow,1,9e15);
  if(at!==undefined){if(at<(u.mineAt||0))return false;u.mineAt=at;srvSync(at)}
  const old=new Map(u.books.map(b=>[b.id,b])),first=u.mine!=='ok';
  const books=d.books.slice(0,200).map(bookFromApi).filter(Boolean).sort((a,b)=>b.s-a.s);
  u.books=books;u.rcp=(Array.isArray(d.rcp)?d.rcp:[]).slice(0,300).map(rcpFromApi).filter(Boolean).sort((a,b)=>b.t-a.t);u.mine='ok';u.wake=0;
  // เหตุการณ์ที่เซิร์ฟเวอร์เปลี่ยนเอง: toast ครั้งเดียวต่อการเปลี่ยน (การโหลดครั้งแรกไม่ toast ถือว่าจบไปก่อนหน้า)
  if(!first)books.forEach(b=>{const o=old.get(b.id);if(!o)return;
    if(b.status==='noshow'&&o.status!=='noshow')toast('⚠️ ช่อง '+sName(b.f,b.i)+' ถูกยกเลิก เพราะรถไม่มาภายใน '+NOSHOW_MIN+' นาที (ไม่คืนเงิน)',null,true);
    else if(b.status==='done'&&o.status!=='done'&&!LEAVING[b.id])toast('🚗 ตรวจพบว่ารถออกแล้ว'+(b.park?' · ค่าจอด ฿'+b.park:' (ฟรี)'),null,true);
  });
  // ผู้ดูแลยกเลิก: ป๊อปอัปครั้งเดียวต่อ id (จำใน localStorage เฉพาะ id) ย้อนหลังไม่เกิน 7 วัน สูงสุด 3 ใบต่อครั้ง
  if(!u.seen)u.seen=seenLoad(u);
  const fresh=books.filter(b=>b.status==='cancelled'&&b.by==='admin'&&!u.seen.has(b.id)&&(!b.out||nowS()-b.out<6048e5)).slice(0,3);
  if(fresh.length){fresh.forEach(b=>{u.seen.add(b.id);showCancelPopup(b,b.reason)});try{localStorage.setItem(seenKey(u),JSON.stringify([...u.seen].slice(-50)))}catch(e){}}
  // กำลังรอผลการจอง (ผลไม่ทราบ/รีเฟรช) แล้วรายการใหม่ที่ตรง ช่อง+ทะเบียน ปรากฏ = จองสำเร็จแล้ว
  if(S.req){const m=books.find(b=>b.status==='active'&&b.f===S.req.f&&b.i===S.req.i&&carObj(b.car).plate===S.req.car&&!old.has(b.id));
    if(m){pendClear();if(S.v==='check'||S.v==='pay'){S.v='check';S.st='ok';S.last=m.id;S.busy=0;S.msg='';render()}}}
  return true;
}
function loadMine(){
  const u=session;if(!u)return Promise.resolve();
  if(u.mineP)return u.mineP;
  if(u.mine!=='ok')u.mine='loading';
  u.mineP=api('GET','/api/me/bookings',undefined,{wake:on=>{if(session===u&&u.mine==='loading'){u.wake=on?1:0;refresh()}}})
    .then(j=>{u.mineTry=0;u.mineNb=0;if(session===u&&mineApply(j))refresh()},e=>{if(session!==u||(e&&e.api&&e.status===401))return;
      u.mineBusy=isBusyRead(e);if(u.mine!=='ok'){u.mine='err';u.wake=0}
      // คับคั่ง (503/429): รอตาม Retry-After แล้วลองใหม่เองไม่เกิน 3 ครั้ง (สตรีม SSE ส่งรายการให้อยู่แล้ว ถ้าสตรีมส่งมาก่อนก็ไม่ต้องลอง) ไม่ถล่มซ้ำ
      if(u.mineBusy){u.mineNb=Date.now()+(e.retry||5)*1000;if(u.mine!=='ok'&&(u.mineTry=(u.mineTry||0)+1)<=3){clearTimeout(u.mineTm);u.mineTm=setTimeout(()=>{if(session===u&&u.mine!=='ok'){u.mine='loading';loadMine()}},(e.retry||5)*1000+500+u.mineTry*1000)}}
      refresh()})
    .finally(()=>{u.mineP=null});
  return u.mineP;
}
// สถานะระหว่างยังไม่มีรายการ (แทน "ยังไม่มีการจอง") คืน '' เมื่อพร้อมแล้ว
const mineState=u=>u.mine==='loading'?`<div class="empty" role="status">⏳<p>กำลังโหลด…</p>${u.wake?'<p class="note">'+WAKE_TXT+'</p>':''}</div>`:u.mine==='err'?'<div class="empty" role="alert">⚠️<p>'+(u.mineBusy?BUSY_TXT:'โหลดการจองไม่สำเร็จ')+'</p><a role="button" tabindex="0" data-a="mineretry">ลองใหม่</a></div>':'';
const bs=b=>+b.s||new Date(b.time).getTime(),be=b=>+b.e||bs(b)+b.min*60000;
const mmss=ms=>{ms=Math.max(0,ms);const h=ms/36e5|0,m=ms/6e4%60|0,s=ms/1e3%60|0;return(h?h+':':'')+String(m).padStart(h?2:1,'0')+':'+String(s).padStart(2,'0')};
// 'u' เฉพาะเริ่มจริงในอนาคต เกิน 30 วิ (การจองเริ่มทันทีที่เซิร์ฟเวอร์รับ เวลา s เป็นของเซิร์ฟเวอร์ กันนาฬิกาเครื่องคลาดเคลื่อนเล็กน้อยทำให้การจองที่เพิ่งสร้างดูเป็น "ยังไม่เริ่ม")
const stat=b=>b.status==='cancelled'?'c':b.status==='noshow'?'n':(b.out||b.status==='done')?'d':nowS()+3e4<bs(b)?'u':nowS()<be(b)?'a':'o';
let tT;function toast(msg,fn,sys){const t=$('toast');t.textContent=msg;t.onclick=()=>{t.classList.remove('show');fn&&fn()};t.classList.add('show');clearTimeout(tT);tT=setTimeout(()=>t.classList.remove('show'),6000);if(sys&&window.Notification&&Notification.permission==='granted')new Notification('ParkHere',{body:LANG==='en'?tr(msg):msg})}
const isClosed=(f,i)=>{const k=f+'-'+i;return !!closedMap[k]||!!(slotMap[k]&&slotMap[k].closed===true)};
const busy=(f,i)=>isClosed(f,i)||unk(f,i)||occ(f,i)||resv(f,i);
const free=f=>[...Array(N).keys()].filter(i=>!busy(f,i)).length;
const price=m=>Math.ceil(m/60*RATE);
const sName=(f,i)=>'F'+f+'-'+phSlotName(f+'-'+i);   // ชื่อช่อง A1..C2 มาจาก slotname.js ที่เดียว
const sNameH=(f,i)=>escH(sName(f,i));   // ใช้ใน template (ค่า f/i อาจมาจากฐานข้อมูล)
const nowLocal=(add=0)=>{const d=new Date(Date.now()+add*6e4);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16)};
const fmt=t=>new Date(t).toLocaleString(LANG==='en'?'en-GB':'th-TH',{dateStyle:'short',timeStyle:'short'});
const payTxt=p=>p.t==='card'?'💳 บัตร •••• '+escH(String(p.info).slice(-4)):'📱 PromptPay •••• '+escH(String(p.info).slice(-4));
let S={v:'home',f:1,s:null,d:null,pm:'pp',msg:''};

function ticketHtml(b){
  let qr='<p class="note">โหลด QR ไม่ได้ (ต้องต่ออินเทอร์เน็ต)</p>';
  try{const q=qrcode(0,'M');q.addData(['PARKHERE',b.id,sName(b.f,b.i),b.car,bs(b),be(b)].join('|'));q.make();qr=q.createSvgTag({cellSize:5,margin:0,scalable:true})}catch(e){}
  return `<div class="back" data-a="close"><div class="modal tk" role="dialog" aria-modal="true" aria-labelledby="m-title" tabindex="-1"><button type="button" class="modal-close" aria-label="ปิด" data-a="close">×</button><div class="grab" data-a="close"></div><h2 id="m-title">🎫 บัตรเข้าลานจอด</h2><div class="qr">${qr}</div><h1>${sNameH(b.f,b.i)}</h1><p>${escH(b.car)}</p><p class="note">${fmt(bs(b))}</p><p class="note">แสดง QR นี้ที่ทางเข้าลานจอด</p>${gateBtn(b,'')}</div></div>`}
const liveInfo=b=>{const s0=bs(b),fe=s0+FREEMIN*6e4,n=nowS();
  return n<fe?`<span class="tag on">ฟรี</span>เหลือ <b class="cd" data-e="${fe}">${mmss(fe-n)}</b>`:`<span class="tag">คิดค่าจอด</span>จอดมา <b class="cd" data-e="${s0}" data-up="1">${mmss(n-s0)}</b> · ตอนนี้ (ประมาณ) <b class="cost" data-s="${s0}">฿${price(Math.max(0,Math.ceil((n-s0)/6e4)-FREEMIN))}</b>`};
// เก็บ/คืนค่าที่ผู้ใช้พิมพ์ค้างและโฟกัส เมื่อ render ซ้ำจากข้อมูลสดที่เข้ามา (QA6) ใช้เฉพาะเมื่อหน้า/ป๊อปอัปเดิม
let lastKey='';
function snapForm(){
  const o={};document.querySelectorAll('#view input[id],#view select[id],#modal input[id],#modal select[id]').forEach(el=>{o[el.id]=el.value});
  const a=document.activeElement;let f=null;
  if(a&&a!==document.body&&$('home').contains(a)){
    const d=a.dataset||{},sel=a.id?'':a.classList.contains('slot')&&d.i!=null?'.slot[data-i="'+d.i+'"]':d.a?'[data-a="'+d.a+'"]'+(d.i!=null?'[data-i="'+d.i+'"]':'')+(d.id!=null?'[data-id="'+d.id+'"]':''):'';
    if(a.id||sel){f={id:a.id,sel};try{f.s=a.selectionStart;f.e=a.selectionEnd}catch(x){}}
  }
  return {o,f};
}
function restoreForm(sn){
  Object.entries(sn.o).forEach(([id,val])=>{const el=$(id);if(el&&el.value!==val){el.value=val}});
  if(sn.f){
    let el=null;try{el=sn.f.id?$(sn.f.id):document.querySelector('#home '+sn.f.sel)}catch(x){}
    if(el){el.focus({preventScroll:true});if(sn.f.s!=null){try{el.setSelectionRange(sn.f.s,sn.f.e)}catch(x){}}}
  }
}
// ช่องจอดหนึ่งช่อง: ปุ่มจริง (โฟกัส/Enter/Space ได้) คลาสสถานะ s-free|s-booked|s-taken|s-mine|s-closed ไอคอน SVG แยกตามสถานะ
const SLOT_ICO={
  free:'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>',
  booked:'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.4 1.6"/></svg>',
  taken:'<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3.3 6.2L4.3 3.8C4.5 3.3 5 3 5.5 3h5c.5 0 1 .3 1.2.8l1 2.4c.7.2 1.3.9 1.3 1.7V11h-1.5v1a.8.8 0 0 1-1.6 0v-1H5.6v1a.8.8 0 0 1-1.6 0v-1H2.5V7.9c0-.8.5-1.5 1.3-1.7zM5.7 4.5l-.6 1.7h5.8l-.6-1.7zM4.6 8.4a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8zm6.8 0a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z"/></svg>',
  mine:'<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.3L8 11l-3.9 2.3.9-4.3-3.3-3 4.4-.5z"/></svg>',
  unknown:'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3"/><path d="M8 11.6v.1"/></svg>',
  closed:'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="5.8"/><path d="M3.9 12.1l8.2-8.2"/></svg>'
};
function slotHtml(f,i){
  const no=escH(phSlotName(f+'-'+i)),mine=session.books.some(x=>x.f==f&&x.i==i&&['a','u','o'].includes(stat(x)));
  let k,txt;
  if(isClosed(f,i)){k='closed';txt='ปิดใช้งาน'}
  else if(mine){k='mine';txt='ของคุณ'}
  else if(!unk(f,i)&&occ(f,i)){k='taken';txt='มีรถจอด'}
  else if(resv(f,i)){k='booked';txt='จองแล้ว'}
  else if(unk(f,i)){k='unknown';txt='ไม่ได้รับสัญญาณ'}   // occ เป็น null / conflict / ข้อมูลเก่า: ห้ามแสดงเป็นว่าง
  else{k='free';txt='ว่าง'}
  const lab='ช่อง '+sName(f,i)+' '+txt,lb=escH(LANG==='en'?tr(lab):lab);
  return `<button type="button" class="slot s-${k}" data-i="${i}"${k==='free'?' data-a="slot"':' aria-disabled="true" data-a="slotno" data-k="'+(k==='unknown'&&(slotMap[f+'-'+i]||{}).conflict===true?'conflict':k)+'"'} aria-label="${lb}"><span class="slot-no">${no}</span><span class="slot-ico" aria-hidden="true">${SLOT_ICO[k]}</span></button>`;
}

function render(){
  const v=S.v,u=session;let h='';
  const key=v+'|'+S.s+'|'+S.t,snap=key===lastKey?snapForm():null;lastKey=key;
  if(v==='home'){
    const b=u.books[0];
    h=`<div class="hero2"><small>ยินดีต้อนรับ</small><h1>${escH(u.user)}</h1><div class="chips2"><span>📋 ใช้งานอยู่ ${u.books.filter(x=>['a','u','o'].includes(stat(x))).length}</span><span>🚘 ${u.cars.length} คัน</span></div></div>
    ${session.books.filter(x=>stat(x)==='a').map(x=>`<div class="hero" style="border:1.5px solid var(--gold)"><div class="row"><b>🚗 ${sNameH(x.f,x.i)} · ${escH(x.car)}</b><span class="tag on">กำลังใช้งาน</span></div><p>${liveInfo(x)}</p><div class="acts">${gateBtn(x)}<button class="sm" data-a="ticket" data-id="${escH(x.id)}">🎫 บัตร</button>${outBtn(x)}</div></div>`).join('')}
    <button data-a="v" data-v="floors">🚗 จองที่จอดเลย</button>
    <h3>ที่ว่างตอนนี้</h3>`+floors().map(f=>`<div class="fl" data-a="floor" data-f="${f}"><div class="row"><b>ชั้น ${f}</b><span>${lot?'ว่าง '+free(f)+'/'+N:'กำลังโหลด…'}</span></div><div class="prog"><i style="width:${lot?free(f)/N*100:0}%"></i></div></div>`).join('')+
    `<h3>การจองล่าสุด</h3>`+(mineState(u)||(b?`<div class="item col"><b>${sNameH(b.f,b.i)} · ${escH(b.car)}</b><small>${fmt(bs(b))} · ฿${escH(b.amt)}${b.park?' + ฿'+escH(b.park):''}${stat(b)==='c'?' · ยกเลิกแล้ว':''}</small></div>`:'<div class="empty">🅿️<p>ยังไม่มีการจอง</p></div>'));
  }else if(v==='floors'){
    h='<h2>เลือกชั้นจอดรถ</h2>'+floors().map(f=>`<div class="fl" data-a="floor" data-f="${f}"><div class="row"><b>🅿️ ชั้น ${f}</b><span class="${!lot?'':free(f)?'okc':'errc'}">${lot?'ว่าง '+free(f)+' ช่อง'+(unkN(f)?' · ไม่ทราบ '+unkN(f):'')+' ›':'กำลังโหลด… ›'}</span></div><div class="prog"><i style="width:${lot?free(f)/N*100:0}%"></i></div></div>`).join('')+sigHtml()+`<p class="note">ค่าจอง ${BOOKFEE} บาท · จอดฟรี ${FREEMIN} นาทีแรก · หลังจากนั้น ${RATE} บาท/ชั่วโมง คิดตามเวลาที่ออกจริง</p>`;
  }else if(v==='map'){
    h=`<a role="button" tabindex="0" data-a="v" data-v="floors">← เลือกชั้น</a><h2>ชั้น ${S.f} · มุมมองด้านบน</h2>`+(lot?'<div class="map">'+[...Array(N).keys()].map(i=>(i%2==1?'<div class="road" aria-hidden="true"></div>':'')+slotHtml(S.f,i)).join('')+'</div>':'<div class="empty" role="status">⏳<p>กำลังโหลดสถานะที่จอด…</p></div>')+sigHtml()+'<div class="gate">⬇ ทางเข้า</div><div class="legend"><span><i class="g"></i>ว่าง</span><span><i class="b"></i>จองแล้ว</span><span><i class="r"></i>มีรถจอด</span><span><i class="m"></i>ของคุณ</span><span><i class="c"></i>ปิดใช้งาน</span><span><i class="u"></i>ไม่ทราบสถานะ / ไม่มีสัญญาณ</span></div>';
  }else if(v==='pay'){
    const d=S.d;
    h=`<h2>ชำระเงิน</h2><div class="demo-badge" role="note">ระบบชำระเงินจำลองสำหรับเดโม ห้ามใส่ข้อมูลบัตรจริง</div><div class="hero"><p>ที่จอด: <b>${sNameH(d.f,d.i)}</b></p><p>ทะเบียน: ${escH(d.car)}</p><p>ค่าจอง (ครั้งเดียว): ฿${d.amt}</p><p class="note">จอดฟรี ${FREEMIN} นาทีแรก หลังจากนั้น ฿${RATE}/ชม. คิดตามเวลาที่ออกจริง</p><h2>฿${d.amt}</h2></div>
    <div class="msg err">${escH(S.msg)}</div>
    <label class="item pm"><span>📱 PromptPay (QR)</span><input type="radio" name="pm" value="pp" ${S.pm==='pp'?'checked':''}${S.req?' disabled':''}></label>`+
    u.pays.filter(p=>p.id).map(p=>`<label class="item pm"><span>${payTxt(p)}</span><input type="radio" name="pm" value="${escH(p.id)}" ${S.pm===p.id?'checked':''}${S.req?' disabled':''}></label>`).join('')+
    `<button data-a="paynow">ชำระเงิน ฿${d.amt}</button><div class="links"><a role="button" tabindex="0" data-a="v" data-v="map">← ย้อนกลับ</a></div>`;
  }else if(v==='check'){
    h=S.st==='wait'?'<div class="center"><div class="spin"></div><h2>กำลังตรวจสอบ...</h2><p id="chk-msg" class="msg" role="status"></p></div>':
    '<div class="center"><div class="tick">✓</div><h2>ชำระเงินสำเร็จ</h2>'+(u.books.find(x=>x.id===S.last)?gateBtn(u.books.find(x=>x.id===S.last),''):'')+'<button data-a="ticketlast">🎫 ดูบัตรเข้าลานจอด</button><button class="out" data-a="home">ไปหน้าหลัก</button></div>';
  }else if(v==='books'){
    const card=b=>{const st=stat(b),e=be(b),s=bs(b);
      const btn=(a,t,c='')=>`<button class="sm ${c}" data-a="${a}" data-id="${escH(b.id)}">${t}</button>`;
      const fe=s+FREEMIN*6e4,cost=()=>price(Math.max(0,Math.ceil((nowS()-s)/6e4)-FREEMIN)),nsx=!b.arr&&sigOk()&&sensorMap[b.f+'-'+b.i]!==undefined?` · ⏳ ยกเลิกอัตโนมัติถ้ารถไม่มาใน ${Math.max(0,Math.ceil(NOSHOW_MIN-(nowS()-s)/6e4))} นาที`:'';
      const info=st==='a'?(nowS()<fe?`<span class="tag on">ฟรี</span>เหลือ <b class="cd" data-e="${fe}">${mmss(fe-nowS())}</b>`:`<span class="tag">คิดค่าจอด</span>จอดมา <b class="cd" data-e="${s}" data-up="1">${mmss(nowS()-s)}</b> · ตอนนี้ (ประมาณ) <b class="cost" data-s="${s}">฿${cost()}</b>`)+nsx:st==='c'?'<span class="tag x">ยกเลิกแล้ว</span>':st==='n'?'<span class="tag x">ไม่มาตามนัด (ไม่คืนค่าจอง)</span>':'<span class="tag">เสร็จสิ้น</span>'+` จอดไป ${escH(b.min||0)} นาที · ค่าจอด ฿${escH(b.park||0)}`;
      const act=st==='a'?gateBtn(b)+btn('ticket','🎫 บัตร')+outBtn(b):'';
      return `<div class="item col"><b>${sNameH(b.f,b.i)} · ${escH(b.car)}</b><small>${fmt(s)} · ค่าจอง ฿${escH(b.amt)}</small><div>${info}${(st==='a'||st==='o')&&sensorMap[b.f+'-'+b.i]!==undefined?(occ(b.f,b.i)?' · 🚗 รถอยู่ในช่อง':' · ช่องว่าง'):''}</div>${act?`<div class="acts">${act}</div>`:''}</div>`};
    const live=b=>['a','u','o'].includes(stat(b)),cur=u.books.filter(live),past=u.books.filter(b=>!live(b));
    h='<h2>การจองของฉัน</h2>'+(mineState(u)||(cur.map(card).join('')||'<div class="empty">🅿️<p>ยังไม่มีการจองที่ใช้งานอยู่</p></div>')+(past.length?'<h3>ประวัติ</h3>'+past.map(card).join(''):''))+`<p class="note">ค่าจอง ฿${BOOKFEE} · ฟรี ${FREEMIN} นาทีแรก · หลังจากนั้น ฿${RATE}/ชม. คิดตามเวลาที่ออกจริง</p>`;
  }else if(v==='cars'){
    h='<h2>รถของฉัน</h2>'+u.cars.map((c,i)=>`<div class="item" style="flex-wrap:wrap"><span>🚘 ${escH(c)}</span><a role="button" tabindex="0" data-a="delcar" data-i="${i}">ลบ</a>${S.delI===i?`<div class="msg err" style="flex-basis:100%">${escH(S.msg)}</div>`:''}</div>`).join('')+
    `<label>เพิ่มทะเบียนรถ</label><input id="c-new" placeholder="เช่น กข 1234"><label>จังหวัด</label><select id="c-prov" class="prov">${provOpts()}</select><button data-a="addcar">เพิ่มรถ</button><div class="msg err">${S.delI>=0?'':escH(S.msg)}</div>`;
  }else if(v==='rcp'){
    const tot=u.rcp.reduce((a,r)=>a+(+r.amt||0),0);
    h=`<a role="button" tabindex="0" data-a="v" data-v="me">← โปรไฟล์</a><h2 style="margin-top:8px">ใบเสร็จและประวัติการจ่ายเงิน</h2><div class="hero2"><small>ยอดสุทธิทั้งหมด</small><h1>${u.mine==='ok'?'฿'+tot:'฿–'}</h1></div>`+(mineState(u)||u.rcp.map(r=>`<div class="item"><span><b>${escH(r.desc)}</b><br><small>${fmt(r.t)} · ${escH(r.no)}</small></span><b class="${r.amt<0?'okc':''}">${r.amt<0?'+':''}฿${escH(Math.abs(r.amt))}</b></div>`).join('')||'<div class="empty">🧾<p>ยังไม่มีรายการ</p></div>');
  }else if(v==='me'){
    h=`<h2>โปรไฟล์</h2><div class="hero"><label style="margin-top:0">ชื่อที่แสดง</label><input id="n-name" value="${escH(u.user)}"><button class="sm" data-a="savename">บันทึกชื่อ</button><p class="note">${escH(u.email)}</p></div>
    <div class="item" data-a="v" data-v="rcp"><span>🧾 ใบเสร็จและประวัติการจ่ายเงิน</span><span>›</span></div>
    <div class="item" data-a="resetpw"><span>🔑 เปลี่ยนรหัสผ่าน (ส่งลิงก์ทางอีเมล)</span><span>›</span></div>
    <div class="item" data-a="notif"><span>🔔 เปิดการแจ้งเตือนก่อนหมดเวลา</span><span>›</span></div>
    <h2 style="margin-top:22px">วิธีชำระเงินที่บันทึกไว้</h2>`+
    (u.pays.map((p,i)=>`<div class="item"><span>${payTxt(p)}</span><a role="button" tabindex="0" data-a="delpay" data-i="${i}">ลบ</a></div>`).join('')||'<p class="note">ยังไม่มี</p>')+
    `<label>เพิ่มวิธีชำระเงิน</label><select id="p-type"><option value="card">บัตรเครดิต/เดบิต</option><option value="pp">PromptPay</option></select>
    <input id="p-info" inputmode="numeric" maxlength="19" autocomplete="off" placeholder="เลขบัตร หรือ เบอร์โทร PromptPay"><button data-a="addpay">บันทึก</button><div class="msg err">${escH(S.msg)}</div>
    <button class="out" data-a="logout">ออกจากระบบ</button>`;
  }
  if(v!=='pay'&&v!=='check')h=`<div class="topbar"><span class="mini">PARK<b>HERE</b></span><span class="rt"><span class="lang" data-a="lang">${LANG==='th'?'EN':'TH'}</span><span class="av">${escH((String(u.user||'').charAt(0)||'?').toUpperCase())}</span></span></div>`+h;
  $('view').innerHTML=h;
  $('nav').style.display=(v==='pay'||v==='check')?'none':'flex';
  document.querySelectorAll('#nav [data-v]').forEach(b=>b.classList.toggle('on',b.dataset.v===v||(v==='map'&&b.dataset.v==='floors')||(v==='rcp'&&b.dataset.v==='me')));
  let m='';
  if(S.s!=null){
    const cars=u.cars;
    m=`<div class="back" data-a="close"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title" tabindex="-1"><div class="grab" data-a="close"></div><h2 id="m-title">จองช่อง ${sNameH(S.f,S.s)}</h2>${slotInfo(S.f,S.s)}
    <label>เลือกรถ</label>${cars.length?`<select id="m-car">${cars.map(c=>`<option>${escH(c)}</option>`).join('')}</select>`:'<p class="note">ยังไม่มีรถ <a role="button" tabindex="0" data-a="v" data-v="cars">เพิ่มทะเบียนรถ</a></p>'}
    <p class="note">จอดฟรี ${FREEMIN} นาทีแรก หลังจากนั้น ฿${RATE}/ชม. คิดตามเวลาที่ออกจริง</p><div class="total">ค่าจอง <b>฿${BOOKFEE}</b></div>
    <div class="msg err">${escH(S.msg)}</div><button data-a="topay">ไปชำระเงิน</button><div class="links"><button type="button" class="btn-cancel" data-a="close">ยกเลิก</button></div></div></div>`;
  }
  if(S.t){const b=u.books.find(x=>x.id===S.t);if(b)m=ticketHtml(b)}
  const wasOpen=!!document.querySelector('#modal .modal');
  $('modal').innerHTML=m;
  if(m&&!wasOpen){const dlg=document.querySelector('#modal .modal');if(dlg)dlg.focus({preventScroll:true})}   // ย้ายโฟกัสเข้าป๊อปอัป
  if(snap)restoreForm(snap);
  else if(S.fk&&!S.t&&S.s==null){const b=document.querySelector('#view '+S.fk)||document.querySelector('#nav .on')||document.querySelector('#view button');S.fk=null;if(b)b.focus({preventScroll:true})}   // ปิดบัตรแล้วคืนโฟกัสให้ปุ่มเดิม
  else if(v==='map'&&S.s==null&&S.fs!=null){const b=document.querySelector('#view .slot[data-i="'+S.fs+'"]');S.fs=null;if(b)b.focus({preventScroll:true})}   // ปิดป๊อปอัปแล้วคืนโฟกัสให้ช่องเดิม
}

// เขียนข้อมูลผู้ใช้แล้ว render: สำเร็จ -> ok() / ล้ม -> ย้อนค่าในหน้าจอ (rollback) + แสดง "บันทึกไม่สำเร็จ" ไม่บอกว่าสำเร็จ (QA9)
function commit(rollback,ok){
  const u=session;
  persistProfile().then(()=>{if(session===u){S.msg='';ok&&ok()}}).catch(e=>{if(session===u){rollback();S.msg=saveErr(e)}}).then(()=>{if(session===u)render()});
}

// ===== ข้อมูลการจอง/ใบเสร็จที่มาจากเซิร์ฟเวอร์ (ไม่เชื่อชนิดข้อมูล: ตรวจและจำกัดช่วงก่อนใช้ ทุกข้อความเข้า template ผ่าน escH) =====
const BK_ID=/^[\w-]{1,64}$/,BK_ST=['active','done','noshow','cancelled'];
const numIn=(v,lo,hi)=>typeof v==='number'&&Number.isFinite(v)&&v>=lo&&v<=hi?v:undefined;
const intIn=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi?v:undefined;
const strIn=(v,n)=>typeof v==='string'?v.slice(0,n):'';
// ทะเบียนล้วนจากเซิร์ฟเวอร์ -> สตริงแสดงผลของรถที่ทะเบียนตรงกันในบัญชี ("ทะเบียน · จังหวัด") ไม่เจอก็ใช้ทะเบียนล้วน
const carShow=p=>{const c=session&&session.cars.find(x=>carObj(x).plate===p);return c||p};
function bookFromApi(x){
  if(!x||typeof x!=='object'||typeof x.id!=='string'||!BK_ID.test(x.id))return null;
  const f=intIn(x.f,1,99),i=intIn(x.i,0,999),s=numIn(x.s,1,9e15);
  if(f===undefined||i===undefined||s===undefined)return null;
  const e=numIn(x.e,1,9e15),b={id:x.id,f,i,s,e:e===undefined?s+30*864e5:e,car:carShow(strIn(x.car,40)),status:BK_ST.includes(x.status)?x.status:'active',amt:numIn(x.amt,-1e7,1e7)||0,pm:strIn(x.pm,64),min:0};
  [['arr'],['out'],['min',0,1e7],['park',0,1e7]].forEach(([k,lo,hi])=>{const n=numIn(x[k],lo===undefined?1:lo,hi===undefined?9e15:hi);if(n!==undefined)b[k]=n});
  if(typeof x.by==='string')b.by=x.by.slice(0,20);
  if(typeof x.reason==='string')b.reason=x.reason.slice(0,200);
  return b;
}
function rcpFromApi(x){
  if(!x||typeof x!=='object'||typeof x.no!=='string'||!/^[\w-]{1,40}$/.test(x.no))return null;
  const t=numIn(x.t,1,9e15),amt=numIn(x.amt,-1e7,1e7);if(t===undefined||amt===undefined)return null;
  const f=intIn(x.f,1,99),i=intIn(x.i,0,999),m=numIn(x.min,0,1e7),sn=f!==undefined&&i!==undefined?sName(f,i):'';
  let desc=strIn(x.desc,200);   // ประกอบข้อความเองจาก kind,f,i,min เพื่อให้โหมด EN แปลได้ ไม่รู้จัก kind ก็ใช้ desc ของเซิร์ฟเวอร์
  if(sn&&x.kind==='book')desc='ค่าจองช่อง '+sn;
  else if(sn&&x.kind==='park'&&m!==undefined)desc='ค่าจอดตามเวลา '+sn+' ('+m+' นาที)';
  else if(sn&&x.kind==='refund')desc='คืนเงิน (ผู้ดูแลยกเลิก) '+sn;
  return {no:x.no,t,amt,desc,pm:strIn(x.pm,64)};
}
// ใส่/แทนที่การจองและใบเสร็จที่ได้จากคำตอบของเซิร์ฟเวอร์ (sn = serverNow ของคำตอบ กันคำตอบ mine เก่าที่มาถึงทีหลังเขียนทับ)
function upsertMine(b,r,sn){
  const u=session;if(!u)return;
  u.books=[b,...u.books.filter(x=>x.id!==b.id)].sort((x,y)=>bs(y)-bs(x));
  if(r)u.rcp=[r,...u.rcp.filter(x=>x.no!==r.no)].sort((x,y)=>y.t-x.t);
  if(sn&&sn>(u.mineAt||0))u.mineAt=sn;
}

// ===== จองช่องจอด: POST /api/bookings (สัญญา docs/migration/M3-api.md) =====
// เว็บไม่เขียนการจอง/ใบเสร็จ/ยอดเงินเอง: ส่งแค่ {f,i,car(ทะเบียนล้วน),pm("pp"|id บัตร),reqId} แล้วรอผลจากเซิร์ฟเวอร์ ผลชำระเดโมสุ่มที่เบราว์เซอร์ก่อนเรียก (ล้ม = ไม่เรียก API)
const MSG_UNK='ไม่ทราบสถานะช่องนี้ (ไม่ได้รับสัญญาณหรือยังไม่มีข้อมูล) จึงจองไม่ได้ในตอนนี้ กรุณาเลือกช่องอื่น';
const SLOT_NO={unknown:MSG_UNK,conflict:'ช่องนี้มีข้อมูลจากบอร์ดสองตัวขัดกัน จึงไม่ทราบสถานะและจองไม่ได้ชั่วคราว กรุณาแจ้งผู้ดูแล',closed:'ช่องนี้ปิดใช้งานชั่วคราว',mine:'ช่องนี้เป็นของคุณ ดูได้ที่การจองของฉัน',taken:'ช่องนี้มีรถจอดอยู่',booked:'ช่องนี้ถูกจองแล้ว'},MSG_NOFREE='ช่องนี้ไม่ว่างแล้ว';
const NC=' ไม่มีการตัดเงิน (ระบบจำลอง)';
const MSG_TAKEN='ช่องนี้เพิ่งถูกจองไปแล้ว'+NC+' กรุณาเลือกช่องอื่น';
const MSG_UNSURE='ยังไม่ทราบผลการจอง (การเชื่อมต่อขัดข้อง) กรุณากดชำระเงินอีกครั้ง ระบบจะไม่จองซ้ำ หรือตรวจดูที่ "การจองของฉัน"';
// ผลที่ "แน่ใจ" ว่าเซิร์ฟเวอร์ของเราตอบแล้ว (มี error.code ตามสัญญา) นอกนั้น (timeout/network/5xx ที่ไม่มี code/รหัสไม่รู้จัก) = ไม่ทราบผล ห้ามบอกว่าไม่มีการตัดเงิน
const SURE=new Set(['BAD_INPUT','CAR_UNKNOWN','PAY_UNKNOWN','REQ_REUSED','UNAUTHORIZED','TOKEN_INVALID','TOKEN_EXPIRED','FORBIDDEN','NO_SLOT','NOT_FOUND','SLOT_TAKEN','SLOT_CLOSED','SLOT_CONFLICT','SLOT_UNKNOWN','SLOT_OCCUPIED','CAR_BOOKED','LIMIT','NOT_ACTIVE','RATE_LIMIT','UPSTREAM','WRITES_DISABLED','BUSY','NOT_CONFIGURED']);
const unsure=e=>!(e&&e.api&&SURE.has(e.code));
// -> {msg,uncertain,to,reload}  to: map = กลับแผนที่ + toast, modal = เปิดป๊อปอัปเลือกรถของช่องเดิม, pay = กลับหน้าชำระ
function bookErr(e){
  if(unsure(e))return {msg:MSG_UNSURE,uncertain:1,to:'pay'};
  const c=e.code,T={
    SLOT_UNKNOWN:[MSG_UNK+NC,'map'],SLOT_CONFLICT:[SLOT_NO.conflict+NC,'map'],SLOT_CLOSED:['ช่องนี้ถูกปิดใช้งาน ไม่สามารถจองได้'+NC,'map'],
    SLOT_OCCUPIED:['ช่องนี้มีรถจอดอยู่'+NC+' กรุณาเลือกช่องอื่น','map'],SLOT_TAKEN:[MSG_TAKEN,'map'],NO_SLOT:['ไม่พบช่องนี้ในระบบ'+NC,'map'],
    CAR_BOOKED:['รถคันนี้มีการจองอยู่แล้ว'+NC,'modal'],
    LIMIT:['คุณมีการจองที่ยังไม่จบครบ 3 รายการแล้ว ต้องออกจากลานจอดก่อนจึงจองเพิ่มได้'+NC,'pay'],
    BAD_INPUT:['ข้อมูลการจองไม่ถูกต้อง กรุณาลองใหม่'+NC,'pay'],CAR_UNKNOWN:['ไม่พบรถคันนี้ในบัญชีของคุณ'+NC,'pay'],PAY_UNKNOWN:['ไม่พบวิธีชำระเงินนี้'+NC,'pay'],
    RATE_LIMIT:[API_MSG.RATE_LIMIT+NC,'pay'],UPSTREAM:['ระบบหลังบ้านไม่ตอบสนอง การจองไม่สำเร็จ'+NC+' กรุณาลองใหม่อีกครั้ง','pay'],
    BUSY:[API_MSG.BUSY+NC,'pay'],WRITES_DISABLED:[API_MSG.WRITES_DISABLED+NC,'pay'],NOT_CONFIGURED:[API_MSG.NOT_CONFIGURED+NC,'pay'],
    FORBIDDEN:[API_MSG.FORBIDDEN,'pay']
  };
  if(c==='REQ_REUSED')return {msg:'คำขอซ้ำไม่ตรงกับครั้งก่อน กรุณาลองใหม่ หรือตรวจดูที่ "การจองของฉัน"',to:'pay',reload:1};   // อาจมีการจองจากคำขอแรกอยู่แล้ว: ไม่พูดว่าไม่ตัดเงิน ทิ้ง reqId แล้วโหลดรายการใหม่
  if(c==='CAR_BOOKED'||c==='LIMIT'||c==='SLOT_TAKEN')return {msg:T[c][0],to:T[c][1],reload:1};
  const t=T[c];return t?{msg:t[0],to:t[1]}:{msg:MSG_UNSURE,uncertain:1,to:'pay'};
}
// reqId ต่อการกดชำระหนึ่งครั้ง (รูปแบบ ^[A-Za-z0-9_-]{8,64}$) ใช้ซ้ำเฉพาะการลองส่งใหม่ของการกดครั้งเดิม
const newReqId=()=>{try{if(window.crypto&&crypto.randomUUID)return crypto.randomUUID()}catch(e){}const a=new Uint8Array(16);crypto.getRandomValues(a);return Array.from(a,x=>x.toString(16).padStart(2,'0')).join('')};
// ค้างส่งอยู่ (ph_pend ใน sessionStorage): เก็บเฉพาะ reqId,uid,f,i,ทะเบียน,pm,เวลา ไม่มีข้อมูลบัตร รีเฟรชระหว่าง "กำลังตรวจสอบ" แล้วส่ง reqId เดิมซ้ำได้ (เซิร์ฟเวอร์คืนผลเดิม ไม่จองซ้ำ)
const PEND='ph_pend',PEND_MS=6e5,REQ_RE=/^[A-Za-z0-9_-]{8,64}$/;
const pendSave=()=>{try{const q=S.req;sessionStorage.setItem(PEND,JSON.stringify({reqId:q.reqId,uid:session.uid,f:q.f,i:q.i,car:q.car,pm:q.pm,t:q.t}))}catch(e){}};
const pendClear=()=>{S.req=null;try{sessionStorage.removeItem(PEND)}catch(e){}};
function pendResume(){
  let o=null;try{o=JSON.parse(sessionStorage.getItem(PEND)||'null')}catch(e){}
  const ok=o&&typeof o==='object'&&o.uid===session.uid&&REQ_RE.test(String(o.reqId))&&Number.isInteger(o.f)&&Number.isInteger(o.i)&&typeof o.car==='string'&&o.car.length<=40&&typeof o.pm==='string'&&o.pm.length<=64&&typeof o.t==='number'&&Date.now()-o.t<PEND_MS;
  if(!ok){try{sessionStorage.removeItem(PEND)}catch(e){}return}
  S.req={reqId:o.reqId,f:o.f,i:o.i,car:o.car,pm:o.pm,t:o.t};S.d={f:o.f,i:o.i,car:carShow(o.car),amt:BOOKFEE};S.f=o.f;S.pm=o.pm;S.v='check';S.st='wait';S.busy=1;
}
// ส่งคำขอจอง: คืน {book,rcp} (rcp เป็น null ได้) หรือ throw (ให้ bookErr แยกสาเหตุ)
async function bookSlot(q){
  const j=await api('POST','/api/bookings',{f:q.f,i:q.i,car:q.car,pm:q.pm,reqId:q.reqId},{wake:wakeMsg('chk-msg')});
  const book=bookFromApi(j&&j.booking);if(!book)throw {code:'BAD_RESPONSE'};
  return {book,rcp:j.receipt?rcpFromApi(j.receipt):null,sn:numIn(j.serverNow,1,9e15)};
}
// หลังกด "ชำระเงิน": สุ่มผลเดโมก่อน (ถ้ายังไม่เคยส่ง) แล้วส่ง API ครั้งเดียวต่อ reqId ถ้ายังมี S.req (ผลไม่ทราบ/รีเฟรช) = ส่ง reqId เดิมทันที ข้ามการสุ่ม
function payRun(u){
  setTimeout(async()=>{
    if(session!==u||S.v!=='check')return;
    const d=S.d;
    if(!S.req){
      // ผลชำระเงินจำลอง: สุ่ม (สำเร็จ 70%) ยกเว้นบน localhost ที่บังคับด้วย ?pay=ok|fail (FORCE_PAY) ล้ม = ไม่เรียก API ไม่สร้าง reqId ไม่มีการจอง
      const okPay=FORCE_PAY?FORCE_PAY==='ok':Math.random()<0.7;
      if(!okPay){S.busy=0;S.v='pay';S.msg='ชำระเงินไม่สำเร็จ กรุณาลองอีกครั้ง';return render();}
      if(isClosed(d.f,d.i)){S.busy=0;S.v='map';S.f=d.f;S.s=null;toast('ช่องนี้ถูกปิดใช้งาน ไม่สามารถจองได้');return render()}
      if(unk(d.f,d.i)){S.busy=0;S.v='map';S.f=d.f;S.s=null;S.d=null;toast(MSG_UNK+NC);return render()}   // ตรวจเร็วฝั่งเว็บ เซิร์ฟเวอร์ตัดสินจริงอีกครั้ง
      S.req={reqId:newReqId(),f:+d.f,i:+d.i,car:carObj(d.car).plate,pm:S.pm,t:Date.now()};pendSave();
    }
    const q=S.req;S.busy=1;let r,err=null;
    try{r=await bookSlot(q)}catch(e){err=e}
    if(session!==u)return;
    S.busy=0;
    if(!err){
      upsertMine(r.book,r.rcp,r.sn);
      if(S.req===q){pendClear();S.v='check';S.st='ok';S.last=r.book.id}   // S.req ถูกเคลียร์แล้ว = ผลมาถึงก่อนทางสตรีม mine
      return render();
    }
    if(S.req!==q)return;
    const x=bookErr(err);
    if(!x.uncertain)pendClear();   // ผลแน่ใจ: เลิกใช้ reqId นี้ (กดชำระครั้งหน้าใช้ใหม่) ผลไม่ทราบ: คง reqId/ph_pend ไว้
    if(x.reload)loadMine();
    if(x.to==='map'){S.v='map';S.f=q.f;S.s=null;S.d=null;toast(x.msg)}
    else if(x.to==='modal'){S.v='map';S.f=q.f;S.s=q.i;S.fs=q.i;S.d=null;S.msg=x.msg}
    else{S.v='pay';S.msg=x.msg}
    render();
  },S.req?400:2000);
}

$('home').addEventListener('click',e=>{
  const el=e.target.closest('[data-a]');if(!el)return;
  if(el.classList.contains('back')&&e.target.closest('.modal'))return;
  const a=el.dataset.a,u=session;S.msg='';S.delI=-1;
  if(a==='chip'){$('m-min').value=el.dataset.m;upd();return;}
  else if(a==='v'){S.v=el.dataset.v;S.s=null;S.t=null;}
  else if(a==='floor'){S.f=+el.dataset.f;S.v='map';}
  else if(a==='slot'){if(isClosed(S.f,+el.dataset.i)){toast('ช่องนี้ปิดใช้งานชั่วคราว');return render()}if(unk(S.f,+el.dataset.i)){toast(MSG_UNK);return render()}S.s=+el.dataset.i;S.fs=S.s;}
  else if(a==='slotno'){toast(SLOT_NO[el.dataset.k]||MSG_NOFREE);el.classList.add('tap-no');setTimeout(()=>el.classList.remove('tap-no'),400);return;}
  else if(a==='close'){const bk=document.querySelector('#modal .back');if(bk){bk.classList.add('out');setTimeout(()=>{S.s=null;S.t=null;render()},280);return;}S.s=null;S.t=null;}
  else if(a==='topay'){   // ยังไม่จอง/ไม่ตัดเงิน แค่ไปหน้าชำระ การจองจริงทำใน bookSlot หลังผลชำระ
    const car=$('m-car')&&$('m-car').value;
    if(!car)S.msg='กรุณาเพิ่มทะเบียนรถก่อน';
    else if(unk(S.f,S.s))S.msg=MSG_UNK;
    else if(occ(S.f,S.s)||resv(S.f,S.s))S.msg='ช่องนี้ไม่ว่างแล้ว';
    else if(session.books.some(x=>carObj(x.car).plate===carObj(car).plate&&['a','u'].includes(stat(x))))S.msg='รถคันนี้มีการจองอยู่แล้ว';   // ตรวจเร็วเท่านั้น เซิร์ฟเวอร์ตัดสินจริง (CAR_BOOKED)
    else{const pl=carObj(car).plate;if(S.req&&(S.req.f!==S.f||S.req.i!==S.s||S.req.car!==pl))pendClear();   // เลือกช่อง/รถใหม่ = การกดชำระใหม่ (reqId ใหม่) เลือกชุดเดิมซ้ำหลังผลไม่ทราบ = คง reqId เดิม
      S.d={f:S.f,i:S.s,car,amt:BOOKFEE};S.s=null;S.v='pay';S.pm=S.req?S.req.pm:'pp';}
  }
  else if(a==='paynow'){
    if(S.busy)return;
    const r=document.querySelector('input[name=pm]:checked'),v=r?r.value:'pp';
    S.pm=S.req?S.req.pm:(v!=='pp'&&u.pays.some(p=>p.id&&p.id===v)?v:'pp');   // ลองส่งซ้ำของการกดครั้งเดิมต้องใช้ pm เดิม (ไม่งั้นเซิร์ฟเวอร์ตอบ REQ_REUSED)
    S.v='check';S.st='wait';S.busy=1;render();payRun(u);return;
  }
  else if(a==='out'){
    const b=u.books.find(x=>x.id===el.dataset.id);if(!b||b.out||LEAVING[b.id])return;
    // ยอดในกล่องยืนยันเป็นค่า "ประมาณ" ที่คำนวณบนจอ ยอดจริงคิดโดยเซิร์ฟเวอร์ตอนออก (แสดงหลังออกจากคำตอบของเซิร์ฟเวอร์)
    const m=parkMin(b),fee0=price(Math.max(0,m-FREEMIN));
    if(confirm((isIn(b)?'ออกจากลานจอดช่อง ':'ยกเลิกการจองก่อนรถมาถึง ช่อง ')+sName(b.f,b.i)+(isIn(b)?'\nจอดมา '+m+' นาที → ':'\n')+'ค่าจอดประมาณ ฿'+fee0+' (ยอดจริงคิดโดยระบบตอนออก)'+(isIn(b)?'':'\nค่าจองไม่คืนเงิน')+'\nยืนยัน?'))leaveBooking(b);
  }
  else if(a==='gate'){const b=u.books.find(x=>x.id===el.dataset.id);if(b&&canGate(b))openGate(b);else toast('การจองนี้ลดไม้กั้นไม่ได้แล้ว');return;}
  else if(a==='ticket'){S.t=el.dataset.id;S.fk='[data-a="ticket"][data-id="'+CSS.escape(el.dataset.id)+'"]';}
  else if(a==='ticketlast'){S.v='books';S.t=S.last;S.fk='[data-a="ticket"][data-id="'+CSS.escape(S.last)+'"]';}
  else if(a==='savename'){const n=clip($('n-name').value);if(n&&n!==u.user){if(n.length>40)return toast('ชื่อยาวได้ไม่เกิน 40 ตัวอักษร');if(longNum(n))return toast(LONGNUM_TXT);const prev=u.user;u.user=n;api('PUT','/api/me',{name:n}).then(()=>toast('บันทึกชื่อแล้ว')).catch(e=>{if(session===u){u.user=prev;toast(saveErr(e));render()}})}}
  else if(a==='resetpw'){api('POST','/api/forgot',{email:u.email},{auth:false}).then(()=>toast('ส่งลิงก์เปลี่ยนรหัสผ่านไปที่ '+u.email)).catch(e=>toast(errTh(e)));}
  else if(a==='notif'){if(window.Notification)Notification.requestPermission().then(p=>toast(p==='granted'?'เปิดการแจ้งเตือนแล้ว':'ยังไม่ได้อนุญาตการแจ้งเตือน'));else toast('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน');}
  else if(a==='mineretry'){u.mine='loading';u.wake=0;clearTimeout(u.mineTm);const w=(u.mineNb||0)-Date.now();if(w>0){u.mineTm=setTimeout(()=>{if(session===u)loadMine()},w+300)}else loadMine()}
  else if(a==='lang'){setLang(LANG==='th'?'en':'th');return;}
  else if(a==='home'){S.v='home';S.d=null;}
  else if(a==='addcar'){
    const c0=clip($('c-new').value),c=c0&&c0+' · '+$('c-prov').value;
    if(!c)S.msg='กรุณากรอกทะเบียน';else if(c0.length>12)S.msg='ทะเบียนยาวได้ไม่เกิน 12 ตัวอักษร';else if(longNum(c0))S.msg=LONGNUM_TXT;else if(u.cars.includes(c))S.msg='มีทะเบียนนี้แล้ว';
    else{const prev=u.cars.slice();u.cars.push(c);return commit(()=>{u.cars=prev},()=>{$('c-new').value=''})}
  }
  else if(a==='delcar'){
    const i=+el.dataset.i,c=u.cars[i];
    if(c!==undefined&&u.mine!=='ok'){S.delI=i;S.msg='กำลังโหลดการจอง กรุณารอสักครู่';loadMine()}   // ยังไม่รู้ว่ารถคันนี้มีการจองไหม: ไม่ลบ
    else if(c!==undefined&&u.books.some(x=>carObj(x.car).plate===carObj(c).plate&&['a','u','o'].includes(stat(x)))){S.delI=i;S.msg='ลบทะเบียนนี้ไม่ได้ เพราะรถคันนี้มีการจองที่ใช้งานอยู่'}
    else if(c!==undefined){const prev=u.cars.slice();u.cars.splice(i,1);return commit(()=>{u.cars=prev})}
  }
  else if(a==='addpay'){
    const t=$('p-type').value,x=$('p-info').value.replace(/\D/g,'');
    if(x.length>19)S.msg='เลขยาวเกินไป';else if(t==='card'&&x.length<12)S.msg='กรอกเลขบัตรให้ครบ';
    else if(t==='pp'&&x.length<9)S.msg='กรอกเบอร์โทรให้ถูกต้อง';
    else{const prev=u.pays.slice();u.pays.push({t,info:x.slice(-4)});return commit(()=>{u.pays=prev},()=>{$('p-info').value=''})}   // บัตรและ PromptPay: เก็บแค่ 4 ตัวท้าย (เดโม ไม่เก็บเลขเต็ม/CVV)
  }
  else if(a==='delpay'){const prev=u.pays.slice();u.pays.splice(+el.dataset.i,1);return commit(()=>{u.pays=prev})}
  else if(a==='logout'){tokSet();teardown();$('view').innerHTML='';$('modal').innerHTML='';show('login');return;}
  render();
});

const upd=()=>{};
document.addEventListener('input',e=>{if(e.target.id==='m-min')upd()});
// ปุ่มแสดง/ซ่อนรหัสผ่าน
document.querySelectorAll('input[type=password]').forEach(i=>{
  const w=document.createElement('div');w.className='pw';i.parentNode.insertBefore(w,i);w.appendChild(i);
  const b=document.createElement('button');b.type='button';b.className='eye';b.textContent='👁';
  b.onclick=()=>{i.type=i.type==='password'?'text':'password'};w.appendChild(b);
});


// ตัวเลือกจังหวัด: แตะแล้วเปิดรายการครบทุกจังหวัด พร้อมช่องค้นหา
function openProv(sel){
  const w=document.createElement('div');w.className='back';w.id='pick';
  w.innerHTML=`<div class="modal"><div class="grab" data-a="close"></div><h2>เลือกจังหวัด (${PROV.length})</h2><input id="p-q" placeholder="🔍 ค้นหาจังหวัด"><div class="plist"></div></div>`;
  const draw=q=>{w.querySelector('.plist').innerHTML=PROV.filter(p=>p.includes(q)).map(p=>`<div class="pitem ${p===sel.value?'on':''}" data-p="${p}">${p}<span>${p===sel.value?'✓':''}</span></div>`).join('')||'<p class="note">ไม่พบจังหวัด</p>'};
  document.body.appendChild(w);draw('');
  w.onclick=e=>{const p=e.target.closest('[data-p]');if(p)sel.value=p.dataset.p;if(p||e.target===w||e.target.closest('.grab')){w.classList.add('out');setTimeout(()=>w.remove(),280)}};
  w.querySelector('#p-q').oninput=e=>draw(e.target.value.trim());
}
document.addEventListener('mousedown',e=>{if(e.target.matches('select.prov')){e.preventDefault();openProv(e.target)}});

// นับเวลาถอยหลัง + แจ้งเตือนก่อนหมดเวลา
const notified={};let tick=0;
// รถมาถึง / no-show / รถออก ตัดสินที่เซิร์ฟเวอร์ (หน้าเว็บรับผลผ่านสตรีม mine) ลูปนี้ทำแค่นับเวลาบนจอและแจ้งเตือนช่วงฟรี
setInterval(()=>{
  if(!session)return;
  document.querySelectorAll('.cd').forEach(el=>el.textContent=mmss(el.dataset.up?nowS()-el.dataset.e:+el.dataset.e-nowS()));
  document.querySelectorAll('.cost').forEach(el=>el.textContent='฿'+price(Math.max(0,Math.ceil((nowS()-el.dataset.s)/6e4)-FREEMIN)));
  session.books.forEach(b=>{
    if(b.status!=='active'||b.out)return;
    const fl=bs(b)+FREEMIN*6e4-nowS();
    if(fl>0&&fl<=3e5&&!notified[b.id+'w']){notified[b.id+'w']=1;toast('⏰ ช่อง '+sName(b.f,b.i)+' ฟรีอีกไม่ถึง 5 นาที จากนั้นคิด ฿'+RATE+'/ชม.',()=>{S.v='books';render()},true)}
    if(fl<=0&&fl>-6e4&&!notified[b.id+'x']){notified[b.id+'x']=1;toast('หมดช่วงฟรี '+FREEMIN+' นาทีของช่อง '+sName(b.f,b.i)+' แล้ว เริ่มคิด ฿'+RATE+'/ชม. แตะเพื่อดู',()=>{S.v='books';render()},true);if(S.v==='books')render()}
  });
  if(++tick%20===0&&S.s==null&&!S.t&&S.v!=='check'&&S.v!=='pay')render();
},1000);

// ลากขีดด้านบนลง = เลื่อนหน้าต่างลงตามนิ้ว ปล่อยเกิน 90px จะปิด
let dragged=false;
document.addEventListener('pointerdown',e=>{
  const g=e.target.closest('.grab');if(!g)return;
  const m=g.closest('.modal'),bk=g.closest('.back'),y0=e.clientY;let dy=0;
  g.setPointerCapture(e.pointerId);
  const mv=ev=>{dy=Math.max(0,ev.clientY-y0);if(dy>6){m.style.transition='none';m.style.transform='translateY('+dy+'px)';bk.style.opacity=Math.max(.2,1-dy/400)}};
  const up=()=>{
    g.removeEventListener('pointermove',mv);g.removeEventListener('pointerup',up);g.removeEventListener('pointercancel',up);
    if(dy<=6)return;
    m.style.transition='transform .2s';m.style.transform='';bk.style.opacity='';
    if(dy>90)g.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    dragged=true;setTimeout(()=>dragged=false,60);
  };
  g.addEventListener('pointermove',mv);g.addEventListener('pointerup',up);g.addEventListener('pointercancel',up);
});
document.addEventListener('keydown',e=>{const t=e.target;if((e.key==='Enter'||e.key===' ')&&t&&t.matches&&t.matches('a[role="button"]')){e.preventDefault();t.click()}});
// ป๊อปอัป: Escape ปิด + กักโฟกัสไว้ในกล่อง (Tab วนในป๊อปอัป)
document.addEventListener('keydown',e=>{
  const dlg=document.querySelector('#modal .modal[role="dialog"]');if(!dlg)return;
  if(e.key==='Escape'){const bk=dlg.closest('.back');if(bk&&!bk.classList.contains('out')){e.preventDefault();bk.click()}return}
  if(e.key!=='Tab')return;
  const fs=[...dlg.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(x=>x.offsetParent!==null);
  if(!fs.length){e.preventDefault();dlg.focus();return}
  const first=fs[0],last=fs[fs.length-1],ac=document.activeElement;
  if(!dlg.contains(ac)||ac===dlg){e.preventDefault();(e.shiftKey?last:first).focus()}
  else if(e.shiftKey&&ac===first){e.preventDefault();last.focus()}
  else if(!e.shiftKey&&ac===last){e.preventDefault();first.focus()}
});
document.addEventListener('click',e=>{if(dragged){e.stopPropagation();e.preventDefault()}},true);

// ===== สลับภาษา ไทย/อังกฤษ (แปลข้อความบนหน้าจอด้วยพจนานุกรม) =====
const DICT=`ใช้งานอยู่=Active|เลือกชั้น=Select floor|ระบบชำระเงินจำลองสำหรับเดโม ห้ามใส่ข้อมูลบัตรจริง=Demo payment system. Do not enter real card details|ช่องนี้เป็นของคุณ ดูได้ที่การจองของฉัน=This slot is yours. See it under My bookings|ช่องนี้มีรถจอดอยู่=This slot has a car in it|ช่องนี้ถูกจองแล้ว=This slot is already reserved|บาท=THB|ฟรี=Free|ช่องนี้เพิ่งถูกจองไปแล้ว ไม่มีการตัดเงิน (ระบบจำลอง) กรุณาเลือกช่องอื่น=This slot was just booked by someone else. You were not charged (demo payment). Please pick another slot|บันทึกไม่สำเร็จ=Could not save|กรุณาลองอีกครั้ง=Please try again|เชื่อมต่อไม่ได้=Cannot connect|เชื่อมต่อช้า=Connection is slow|ลองใหม่=Retry|ไปหน้าเข้าสู่ระบบ=Go to log in|ไม่มีสิทธิ์บันทึก กรุณารีเฟรชหน้าแล้วลองใหม่=No permission to save. Please refresh and try again|เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง=Something went wrong. Please try again|ลบทะเบียนนี้ไม่ได้ เพราะรถคันนี้มีการจองที่ใช้งานอยู่=This plate cannot be deleted because it has an active booking|บัญชีนี้ยังไม่มีทะเบียนรถ กรุณาเพิ่มทะเบียนรถก่อนจอง=This account has no license plate yet. Please add one before booking|ผู้ดูแลรีเซ็ตข้อมูลทั้งระบบ การจองและใบเสร็จถูกล้างแล้ว=The admin reset all data. Your bookings and receipts were cleared.|ที่จอดที่คุณจองถูกยกเลิก=Your booked parking slot was cancelled|ผู้ดูแลระบบยกเลิกการจองนี้=This booking was cancelled by the administrator|เหตุผล:=Reason:|คืนเงิน (ผู้ดูแลยกเลิก)=Refund (cancelled by admin)|ตกลง=OK|คุณได้รับแต่งตั้งเป็นผู้ดูแลระบบ=You have been appointed as an Admin|สิทธิ์ผู้ดูแลระบบของคุณถูกยกเลิก=Your Admin access has been revoked|ผู้ดูแลสูงสุดแต่งตั้งคุณเป็นผู้ดูแลระบบแล้ว=The Master has made you a system administrator|ชื่อผู้ใช้ผู้ดูแลระบบ:=Admin username:|รหัสผ่านจะได้รับจากผู้ดูแลสูงสุดโดยตรง=Your password will be given to you directly by the Master|บัญชีของคุณเข้าหน้าผู้ดูแลระบบไม่ได้อีก=Your account can no longer access the Admin page|ค่าจองช่อง =Booking fee |ค่าจอง (ครั้งเดียว):=Booking fee (one-time):|ค่าจอดตามเวลา=Parking fee by time|จอดฟรี =Free parking: first |นาทีแรก=min|หลังจากนั้น=then|คิดตามเวลาที่ออกจริง=charged by actual exit time|/ชม.=/hr|ฟรีอีกไม่ถึง 5 นาที=free for under 5 more min|จากนั้นคิด=then charged|หมดช่วงฟรี=Free period ended|แล้ว เริ่มคิด=- now charging|แตะเพื่อดู=tap to view|คิดค่าจอด=Metered|จอดมา=Parked for|จอดไป=Parked for|ไม่มาตามนัด (ไม่คืนค่าจอง)=No-show (booking fee not refunded)|ตรวจพบว่ารถออกแล้ว=Car departure detected|ช่องนี้ไม่ว่างแล้ว=This slot is no longer available|ช่องนี้ปิดใช้งานชั่วคราว=This slot is temporarily closed|ช่องนี้ถูกปิดใช้งาน ไม่สามารถจองได้=This slot is closed and cannot be booked|ปิดใช้งาน=Closed|ไม่ว่าง (จองแล้ว/มีรถ)=Unavailable (booked/occupied)|รถคันนี้มีการจองอยู่แล้ว=This car already has an active booking|การจองที่กำลังใช้งาน=Active booking|กำลังใช้งาน=In use|ของคุณ=Yours|จองไว้ตั้งแต่= booked since |ค่าจอง=Booking fee|ช่วงเวลาที่ช่องนี้ถูกจองไว้:=Times this slot is booked:|ยังไม่มีใครจองช่องนี้=No one has booked this slot yet|ผู้ใช้อื่น=Another user| จองไว้ = booked | ถึง = until |เข้าสู่ระบบ=Log in|กำลังเข้าสู่ระบบ...=Logging in...|ลืมรหัสผ่าน=Forgot password|กำลังสมัครสมาชิก...=Signing up...|สมัครสมาชิกสำเร็จ! กรุณาเข้าสู่ระบบ=Signed up! Please log in|สมัครสมาชิก=Sign up|อีเมลที่สมัครไว้=Registered email|อีเมลหรือรหัสผ่านไม่ถูกต้อง=Incorrect email or password|อีเมลนี้ถูกใช้แล้ว=Email already in use|รูปแบบอีเมลไม่ถูกต้อง=Invalid email format|อีเมล=Email|ยืนยันรหัสผ่าน=Confirm password|รหัสผ่านและการยืนยันรหัสผ่านไม่ตรงกัน=Passwords do not match|รหัสผ่าน=Password|ชื่อผู้ใช้=Username|กรุณากรอกข้อมูลให้ครบ=Please fill in all fields|จังหวัดบนป้ายทะเบียน=Province on plate|จังหวัด=Province|ทะเบียนรถ=License plate|ทะเบียน=Plate|เช่น กข 1234=e.g. AB 1234|หรือ=or|กลับไปเข้าสู่ระบบ=Back to log in|ส่งลิงก์ตั้งรหัสผ่านใหม่=Send reset link|หน้าหลัก=Home|การจองของฉัน=My bookings|การจองล่าสุด=Latest booking|การจอง=Bookings|รถของฉัน=My cars|โปรไฟล์=Profile|ยินดีต้อนรับ=Welcome|คัน=cars|จองที่จอดเลย=Book parking now|ที่ว่างตอนนี้=Available now|ยังไม่มีการจองที่ใช้งานอยู่=No active bookings|ยังไม่มีการจอง=No bookings yet|ช่องว่าง=empty slot|ช่อง=slot|ว่าง=Free|เลือกชั้นจอดรถ=Select floor|ชั้น=Floor|มุมมองด้านบน=top view|ทางเข้า=Entrance|มีรถจอด=Occupied|จองแล้ว=Reserved|แตะช่องสีเขียวเพื่อจอง=Tap a green slot to book|ค่าจอด=Parking fee|บาท/ชั่วโมง=THB/hour|ต้องจองล่วงหน้าอย่างน้อย 1 ชั่วโมง=Book at least 1 hour in advance|จอดเกินเวลาปรับ=Overstay fine|บาท ต่อ 10 นาที (ปัดขึ้น)=THB per 10 min (rounded up)|ต่อ 10 นาที=per 10 min|ชั่วโมง=hour|ชม.=h|นาที=min|เซนเซอร์/กล้องออนไลน์=Sensors/camera online|ไม่ได้รับสัญญาณจากบอร์ด=No signal from board|ยังไม่ได้เชื่อมต่อบอร์ด (แสดงเฉพาะการจอง)=Board not connected (bookings only)|จองช่อง=Book slot|เลือกรถ=Select car|เวลาเข้าจอด (จองล่วงหน้าอย่างน้อย 1 ชม.)=Start time (at least 1 h ahead)|เวลาเข้าจอด=Start time|จอดกี่นาที=Minutes|ไปชำระเงิน=Go to payment|ยกเลิกการจอง=Cancel booking|ยกเลิกแล้ว=Cancelled|ยกเลิก=Cancel|ยังไม่มีรถ=No cars yet|เพิ่มทะเบียนรถ=Add license plate|ช่วงเวลานี้ช่องนี้ถูกจองแล้ว กรุณาเลือกเวลาอื่น=This slot is already booked then. Pick another time|ชำระเงินไม่สำเร็จ กรุณาลองอีกครั้ง=Payment failed. Please try again|ชำระเงินสำเร็จ=Payment successful|ชำระเงิน=Payment|กำลังตรวจสอบ...=Verifying...|ที่จอด:=Slot:|เข้าจอด:=Start:|ระยะเวลา:=Duration:|ย้อนกลับ=Back|ดูบัตรเข้าลานจอด=View entry pass|ไปหน้าหลัก=Go to home|ประวัติ=History|กำลังจอด=Parked|รอเข้าจอด=Upcoming|เหลือ=Left|เริ่มใน=Starts in|จอดเกินเวลา=Overstay|เกิน=Over|ค่าปรับ=Fine|เสร็จสิ้น=Completed|ไม่มาตามนัด (ไม่คืนเงิน)=No-show (no refund)|ยกเลิกอัตโนมัติถ้ารถไม่มาใน=auto-cancel if no car in|ออกจากลานจอด=Exit lot|ออกจากลานจอดช่อง=Exit slot|⚠️ ช่อง =⚠️ Slot |ยกเลิกการจองก่อนรถมาถึง ช่อง=Cancel booking before your car arrives, slot|ค่าจองไม่คืนเงิน=The booking fee is not refunded|รถอยู่ในช่อง=car in slot|ยกเลิกได้ก่อนถึงเวลาเข้าจอด=Cancel before the start time|🎫 บัตร=🎫 Pass|บัตรเข้าลานจอด=Entry pass|แสดง QR นี้ที่ทางเข้าลานจอด=Show this QR at the entrance|💳 บัตร=💳 Card|เพิ่มรถ=Add car|ลบ=Delete|ชื่อที่แสดง=Display name|บันทึกชื่อ=Save name|ใบเสร็จและประวัติการจ่ายเงิน=Receipts & payment history|เปลี่ยนรหัสผ่าน (ส่งลิงก์ทางอีเมล)=Change password (link by email)|เปิดการแจ้งเตือนก่อนหมดเวลา=Enable expiry notifications|วิธีชำระเงินที่บันทึกไว้=Saved payment methods|เพิ่มวิธีชำระเงิน=Add payment method|บัตรเครดิต/เดบิต=Credit/debit card|เลขบัตร หรือ เบอร์โทร PromptPay=Card number or PromptPay phone|บันทึก=Save|ออกจากระบบ=Log out|ยังไม่มี=None yet|ยอดสุทธิทั้งหมด=Net total|ยังไม่มีรายการ=No transactions|จองที่จอด=Parking booking|ต่อเวลา=Extend|คืนเงิน=Refund|ค่าปรับจอดเกินเวลา=Overstay fine|ยืนยัน?=Confirm?|ต่อเวลาสำเร็จ=Extended|ออกจากลานจอดแล้ว=Exited the lot|ขอบคุณที่ใช้บริการ=Thank you|ถูกยกเลิก เพราะรถไม่มาภายใน=cancelled: no car arrived within|ไม่คืนเงิน=no refund|หมดเวลาจอดช่อง=Parking time ended for slot|เหลืออีก 10 นาที แตะเพื่อต่อเวลา=10 min left. Tap to extend|กำลังลดไม้กั้น…=Lowering barrier…|ไม้กั้นลดแล้ว=Barrier lowered|ลดไม้กั้น=Lower barrier|กำลังส่งคำสั่งลดไม้กั้น…=Sending barrier command…|ไม่ได้รับสัญญาณจากบอร์ด คำสั่งอาจไปไม่ถึงไม้กั้น=No signal from board. The command may not reach the barrier|ยังไม่ทราบผลคำสั่งไม้กั้น อาจเพราะอินเทอร์เน็ตหลุด กรุณาตรวจสอบอินเทอร์เน็ต แล้วดูสถานะไม้กั้นจากแผนที่ก่อนกดซ้ำ=The barrier command result is not known, possibly because the internet connection dropped. Please check your connection, then check the barrier status on the map before tapping again|รอผลคำสั่งไม้กั้นเกิน 20 วินาทีแล้วแต่ยังไม่ทราบผล กรุณาดูสถานะไม้กั้นจากแผนที่ก่อนกดซ้ำ=No result for the barrier command after more than 20 seconds. Please check the barrier status on the map before tapping again|ยังไม่ทราบผลคำสั่งไม้กั้น กรุณาดูสถานะไม้กั้นจากแผนที่ก่อนกดซ้ำ=The barrier command result is not known yet. Please check the barrier status on the map before tapping again|ส่งคำสั่งแล้ว แต่ไม่ได้รับการยืนยันว่าไม้กั้นลดลงภายใน 15 วินาที กรุณาดูที่ช่องจอดก่อนกดซ้ำ=The command was sent but the barrier was not confirmed lowered within 15 seconds. Please check at the slot before tapping again|ระบบสั่งไม้กั้นยังไม่เปิดใช้งาน กรุณาติดต่อเจ้าหน้าที่=The barrier control is not enabled yet. Please contact staff|ยังไม่ทราบสถานะช่องนี้ (บอร์ดอาจออฟไลน์) จึงสั่งไม้กั้นไม่ได้ กรุณาลองใหม่ภายหลัง=The status of this slot is unknown (the board may be offline), so the barrier cannot be controlled. Please try again later|มีรถอยู่ในช่องนี้แล้ว จึงลดไม้กั้นไม่ได้=A car is already in this slot, so the barrier cannot be lowered|ไม่พบการจองที่ใช้งานอยู่ของคุณในช่องนี้=No active booking of yours was found for this slot|รถของคุณเข้าช่องแล้ว ไม่ต้องลดไม้กั้น=Your car is already in the slot. No need to lower the barrier|ช่องนี้ปิดใช้งานอยู่=This slot is closed|ข้อมูลช่องนี้ขัดแย้งกัน กรุณาแจ้งเจ้าหน้าที่=The data for this slot conflicts. Please tell staff|เพิ่งสั่งไม้กั้นช่องนี้ไป กรุณารอสักครู่แล้วลองอีกครั้ง=The barrier of this slot was just commanded. Please wait a moment and try again|ส่งคำสั่งไปถึงบอร์ดไม่ได้ (บอร์ดอาจออฟไลน์) กรุณาลองอีกครั้ง=The command could not reach the board (it may be offline). Please try again|บัญชีนี้ไม่มีสิทธิ์ลดไม้กั้น=This account is not allowed to lower the barrier|ไม่พบช่องจอดนี้=This parking slot was not found|ไม้กั้นช่อง =Barrier at slot | ลดลงแล้ว เชิญเข้าจอด= is down. Please park|การจองนี้ลดไม้กั้นไม่ได้แล้ว=This booking can no longer lower the barrier|บัญชีถูกเปลี่ยนหรือออกจากระบบในแท็บอื่น กรุณาเข้าสู่ระบบอีกครั้ง=Your account changed or logged out in another tab. Please log in again|กำลังปลุกเซิร์ฟเวอร์… (อาจใช้เวลาประมาณ 1 นาที)=Waking the server up… (this can take about 1 minute)|เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองอีกครั้ง=Cannot reach the server. Please try again|รหัสผ่านต้องยาว 8-64 ตัวอักษร=Password must be 8-64 characters|ชื่อยาวได้ไม่เกิน 40 ตัวอักษร=Name can be at most 40 characters|ทะเบียนยาวได้ไม่เกิน 12 ตัวอักษร=Plate can be at most 12 characters|เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง=Your session expired. Please log in again|รหัสผ่านไม่ผ่านเงื่อนไขของระบบ ลองตั้งให้ยาวและคาดเดายากขึ้น=Password was rejected. Try a longer, harder-to-guess one|ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่=Too many requests. Please wait a moment and try again|ระบบหลังบ้านไม่ตอบสนอง ลองใหม่อีกครั้ง=The server is not responding. Please try again|ระบบรับสมาชิกเต็มแล้ว กรุณาติดต่อผู้ดูแล=Registration is full. Please contact the administrator|บัญชีนี้ไม่มีสิทธิ์ใช้ ParkHere=This account cannot use ParkHere|ใส่รหัสผ่านผิดหลายครั้ง บัญชีถูกพักชั่วคราว ลองใหม่ใน=Too many wrong passwords, account paused. Try again in|กำลังส่งลิงก์...=Sending link...|ถ้าอีเมลนี้มีบัญชีอยู่ ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้ (ตรวจกล่องสแปมด้วย)=If this email has an account, a link to set a new password will be sent (check spam too)|ส่งลิงก์เปลี่ยนรหัสผ่านไปที่ =Password change link sent to |บันทึกชื่อแล้ว=Name saved|ทะเบียนรถไม่ถูกต้อง=Invalid license plate|ไม่ได้รับสัญญาณ=No signal|ไม่ทราบสถานะ / ไม่ได้รับสัญญาณ=Unknown status / no signal|ไม่ทราบสถานะช่องนี้ (ไม่ได้รับสัญญาณหรือยังไม่มีข้อมูล) จึงจองไม่ได้ในตอนนี้ กรุณาเลือกช่องอื่น=This slot's status is unknown (the board has no signal or no data yet), so it cannot be booked now. Please pick another slot|ช่องนี้มีข้อมูลจากบอร์ดสองตัวขัดกัน จึงไม่ทราบสถานะและจองไม่ได้ชั่วคราว กรุณาแจ้งผู้ดูแล=Two boards report conflicting data for this slot, so its status is unknown and it cannot be booked for now. Please tell the administrator|ไม่มีการตัดเงิน (ระบบจำลอง)=You were not charged (demo payment)|ไม่ทราบสถานะ=Status unknown|ไม่ทราบ=Unknown|กำลังโหลดสถานะที่จอด…=Loading parking status…|กำลังโหลด…=Loading…|บางช่องไม่ทราบสถานะ (ไม่ได้รับสัญญาณจากบอร์ดของช่องนั้น) จองไม่ได้=Some slots have unknown status (no signal from their board) and cannot be booked|ไม่ได้รับข้อมูลสดจากเซิร์ฟเวอร์ ช่องทั้งหมดแสดงเป็น "ไม่ทราบสถานะ"=No live data from the server. All slots are shown as "Status unknown"|ไม่ได้รับสัญญาณ ช่องที่ไม่ทราบสถานะจะจองไม่ได้=No signal. Slots with unknown status cannot be booked|อ่านสถานะบอร์ดไม่ได้ชั่วคราว ช่องที่ไม่ทราบสถานะจะจองไม่ได้=Cannot read the board status for now. Slots with unknown status cannot be booked|ยังไม่ได้เชื่อมต่อบอร์ด ทุกช่องไม่ทราบสถานะ จึงจองไม่ได้=Board not connected. All slots have unknown status, so none can be booked| · ข้อมูลอาจไม่ล่าสุด= · Data may be out of date|เชื่อมต่อสดอยู่=Live|ข้อมูลอาจไม่ล่าสุด (ระบบหลังบ้านอ่านข้อมูลจากบอร์ดไม่ได้ชั่วคราว)=Data may be out of date (the server cannot read the board for now)|กำลังเชื่อมต่อสถานะที่จอด…=Connecting to live parking status…|การเชื่อมต่อสดหลุด กำลังเชื่อมต่อใหม่… ข้อมูลที่เห็นอาจไม่ล่าสุด=Live connection lost. Reconnecting… What you see may be out of date|ระบบกำลังคับคั่ง ลองใหม่อีกครั้ง=The system is busy. Please try again.|ระบบกำลังคับคั่ง ลองใหม่อีกครั้ง (กำลังลองใหม่อัตโนมัติ)=The system is busy. Retrying automatically…|ห้ามใส่ตัวเลขยาวติดกัน (13 หลักขึ้นไป) ในชื่อ ทะเบียน หรือป้ายรถ เพื่อป้องกันการใส่เลขบัตร กรุณาแก้แล้วลองใหม่=Do not enter long digit strings (13 or more digits) in a name, plate or car label, to avoid card numbers. Please edit and try again.|ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่=Too many requests. Please wait a moment and try again.|ระบบสถานะที่จอดยังไม่พร้อมใช้งาน กำลังลองใหม่…=The parking status service is not ready yet. Retrying…|ปิดการเชื่อมต่อสดนี้แล้ว เพราะเปิดหน้านี้พร้อมกันเกิน 3 แท็บ/อุปกรณ์=This live connection was closed because this page is open in more than 3 tabs/devices|เชื่อมต่อใหม่=Reconnect|ลองใหม่ตอนนี้=Retry now|กรุณาเลือกช่องอื่น=Please pick another slot|ไม่พบช่องนี้ในระบบ=This slot was not found|คุณมีการจองที่ยังไม่จบครบ 3 รายการแล้ว ต้องออกจากลานจอดก่อนจึงจองเพิ่มได้=You already have 3 unfinished bookings. Exit the lot before booking another.|ข้อมูลการจองไม่ถูกต้อง กรุณาลองใหม่=The booking details are invalid. Please try again|ไม่พบรถคันนี้ในบัญชีของคุณ=This car was not found in your account|ไม่พบวิธีชำระเงินนี้=This payment method was not found|ระบบหลังบ้านไม่ตอบสนอง การจองไม่สำเร็จ=The server is not responding. The booking failed.|กรุณาลองใหม่อีกครั้ง=Please try again|ระบบกำลังประมวลผลคำขออื่น กรุณาลองใหม่=The system is busy with other requests. Please try again|ระบบจองยังไม่เปิดใช้งาน=Booking is not available yet|ระบบลานจอดยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง=The parking system is not ready. Please try again later|คำขอซ้ำไม่ตรงกับครั้งก่อน กรุณาลองใหม่ หรือตรวจดูที่ "การจองของฉัน"=This repeated request does not match the previous one. Please try again or check "My bookings"|ยังไม่ทราบผลการจอง (การเชื่อมต่อขัดข้อง) กรุณากดชำระเงินอีกครั้ง ระบบจะไม่จองซ้ำ หรือตรวจดูที่ "การจองของฉัน"=The booking result is not known yet (connection problem). Please tap Pay again - the system will not book twice - or check "My bookings"|โหลดการจองไม่สำเร็จ=Could not load your bookings|กำลังโหลดการจอง กรุณารอสักครู่=Loading your bookings. Please wait a moment|ค่าจอดประมาณ=Estimated parking fee|ยอดจริงคิดโดยระบบตอนออก=the final amount is calculated by the system on exit|ตอนนี้ (ประมาณ)=now (estimated)|ตอนนี้=now|กำลังบันทึก…=Saving…|ไม่พบการจองนี้=Booking not found|การจองนี้จบไปแล้ว=This booking has already ended|ยังไม่ทราบผลการออกจากลานจอด กรุณาลองกดอีกครั้ง หรือตรวจดูที่ "การจองของฉัน"=The exit result is not known yet. Please tap again or check "My bookings"`.split('|').map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}).sort((a,b)=>b[0].length-a[0].length);
const tr=s=>{for(const [a,b] of DICT)if(s.includes(a))s=s.split(a).join(b);return s};
const TH_RE=/[\u0E00-\u0E7F]/,orig=new WeakMap();let pend=0;
const obs=new MutationObserver(()=>{if(LANG==='en'&&!pend){pend=1;requestAnimationFrame(()=>{pend=0;applyLang()})}});
function applyLang(){
  obs.disconnect();
  const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
  while(n=w.nextNode()){
    if(/^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName)||(n.parentNode.nodeName==='OPTION'&&!(n.parentNode.parentNode&&n.parentNode.parentNode.id==='p-type')))continue;
    const o=orig.get(n);
    if(LANG==='en'){if(TH_RE.test(n.data)&&(!o||n.data!==o.en)){const th=n.data,en=tr(th);orig.set(n,{th,en});n.data=en}}
    else if(o&&n.data===o.en)n.data=o.th;
  }
  document.querySelectorAll('[placeholder]').forEach(i=>{const th=i.dataset.th||(TH_RE.test(i.placeholder)?i.placeholder:'');if(th){i.dataset.th=th;i.placeholder=LANG==='en'?tr(th):th}});
  document.querySelectorAll('[aria-label],[title]').forEach(i=>{for(const at of ['aria-label','title']){const k='th'+at.replace('-','');const th=i.dataset[k]||(i.hasAttribute(at)&&TH_RE.test(i.getAttribute(at))?i.getAttribute(at):'');if(th){i.dataset[k]=th;const v=LANG==='en'?(th==='ปิด'?'Close':tr(th)):th;if(i.getAttribute(at)!==v)i.setAttribute(at,v)}}});
  $('lang-btn').textContent=LANG==='th'?'EN':'TH';document.documentElement.lang=LANG;
  obs.observe(document.body,{childList:true,subtree:true,characterData:true});
}
function setLang(l){LANG=l;try{localStorage.setItem('ph_lang',l)}catch(e){}if(session&&$('home').classList.contains('active'))render();applyLang()}
$('lang-btn').onclick=()=>setLang(LANG==='th'?'en':'th');
const _cf=window.confirm.bind(window);window.confirm=m=>_cf(LANG==='en'?tr(m):m);
applyLang();
