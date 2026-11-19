/* พิมพ์ cpe ช่องอีเมล แล้วกด Log in (ไม่ต้องใส่รหัสผ่าน) -> เข้าหน้า Admin */
(function(){
  var st=document.createElement('style');
  st.textContent='#adm-fx{position:fixed;inset:0;z-index:99;background:#101114;display:grid;place-items:center;opacity:0;animation:afx-in .35s ease forwards;overflow:hidden}'
  +'@keyframes afx-in{to{opacity:1}}'
  +'#adm-fx .r{position:absolute;width:40px;height:40px;border-radius:50%;border:2px solid #c9a24a;opacity:.9;animation:afx-r 1.1s ease-out forwards}'
  +'#adm-fx .r:nth-child(2){animation-delay:.2s}#adm-fx .r:nth-child(3){animation-delay:.4s}'
  +'@keyframes afx-r{to{transform:scale(22);opacity:0}}'
  +'#adm-fx .t{position:relative;text-align:center;color:#e8e8e6;font-family:Prompt,sans-serif;animation:afx-t .6s .25s ease both}'
  +'@keyframes afx-t{from{opacity:0;letter-spacing:10px}to{opacity:1;letter-spacing:3px}}'
  +'#adm-fx b{display:block;font-size:26px;font-weight:700;color:#c9a24a}#adm-fx small{color:#8b8e96;font-size:13px;letter-spacing:1px}'
  +'#adm-fx .ln{position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#c9a24a,transparent);top:0;animation:afx-s 1s .1s ease-in-out forwards}'
  +'@keyframes afx-s{to{top:100%}}';
  document.head.appendChild(st);
  function isAdmin(){var e=document.getElementById('l-email');return e&&e.value.trim().toLowerCase().replace(/\/+$/,'')==='cpe'}
  function go(){
    if(document.getElementById('adm-fx'))return;
    try{sessionStorage.setItem('ph-admin-from','1')}catch(e){}
    var d=document.createElement('div');d.id='adm-fx';
    d.innerHTML='<i class="r"></i><i class="r"></i><i class="r"></i><i class="ln"></i><div class="t"><b>ADMIN CONSOLE</b><small>กำลังเข้าสู่ระบบผู้ดูแล…</small></div>';
    document.body.appendChild(d);
    setTimeout(function(){location.href='admin.html'},1250);
  }
  function h(e){
    if(e.type==='keydown'&&!(e.key==='Enter'&&e.target&&(e.target.id==='l-email'||e.target.id==='l-pass')))return;
    if(e.type==='click'&&!(e.target.closest&&e.target.closest('#btn-login')))return;
    if(isAdmin()){e.preventDefault();e.stopImmediatePropagation();go()}
  }
  document.addEventListener('click',h,true);
  document.addEventListener('keydown',h,true);
})();
