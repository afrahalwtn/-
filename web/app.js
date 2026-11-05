// أفراح الوطن — بوابة الموظف المستقلة.
// There are no admin screens, edit forms, user controls, or quote builders here.
// Admin UI lives in /web/admin-app.js and is served by the separate /admin entry.
import {api,apiMedia,setCsrf,setAccessToken,money,number,safe} from './api.js?v=20261106-staff';
import {icon} from './icons.js?v=20261105-price-tag';
import {filterArabicProducts} from './arabic-search.js?v=20261106-ar-v1';

const app=document.getElementById('app');
const state={user:null,products:[],alerts:[],section:'home',query:'',sidebarOpen:innerWidth>=950};
const photos=new Map();
function clearPhotos(){for(const p of photos.values())p.then(u=>URL.revokeObjectURL(u)).catch(()=>{});photos.clear();}
function asset(p){
  if(!p.image_url)return '<span class="product-no-image">'+icon('package',22)+'</span>';
  return '<img class="product-thumb" data-photo="'+safe(p.image_url)+'" alt="صورة '+safe(p.name)+'" loading="lazy">';
}
async function paintPhotos(root){
  await Promise.all(Array.from(root?.querySelectorAll('img[data-photo]')||[]).map(async img=>{
    const url=img.dataset.photo;
    if(!/^\/api\/images\/[0-9a-f]{32}\.(?:png|jpg|webp)$/i.test(url))return;
    if(!photos.has(url))photos.set(url,apiMedia(url.slice(4)).then(b=>URL.createObjectURL(b)).catch(err=>{photos.delete(url);throw err;}));
    try{const object=await photos.get(url);if(img.isConnected)img.src=object;}
    catch{if(img.isConnected)img.alt='صورة غير متاحة';}
  }));
}
function message(value,error=true){
  const node=document.getElementById('staff-toast');
  if(!node)return;
  node.textContent=value;
  node.className='toast visible'+(error?' error':'');
  clearTimeout(message.timer);
  message.timer=setTimeout(()=>node.classList.remove('visible'),4500);
}
function status(p){
  return p.quantity===0?'<span class="chip danger">نفدت المادة</span>':
  p.low_stock?'<span class="chip warning">قريبة من النفاد</span>':
  '<span class="chip success">متوفرة</span>';
}
function pricing(p){
  let out='';
  if(state.user?.can_view_purchase && p.purchase_price!==undefined)out+='<span class="staff-price"><small>سعر الشراء</small><b>'+money(p.purchase_price)+'</b></span>';
  if(state.user?.can_view_sale && p.sale_price!==undefined)out+='<span class="staff-price"><small>سعر البيع</small><b>'+money(p.sale_price)+'</b></span>';
  return out;
}
function loginView(){
  return '<div class="auth-page auth-v6 page page-center">'+
    '<div class="auth-visual"><div class="auth-visual-inner">'+
      '<div class="auth-brand-mark">شركة أفراح الوطن <small>للتجارة العامة</small></div>'+
      '<div class="auth-preview"><img class="auth-logo" src="/assets/tapello.svg?v=20261105-pdf-logo" alt="Tapello"></div>'+
    '</div></div>'+
    '<section class="auth-content"><div class="auth-box card"><span class="auth-kicker">بوابة الموظفين</span>'+
      '<h1>يــا هـلا و مـرحـبـا</h1><p class="muted">سجّل الدخول لمشاهدة المواد والجرد والتنبيهات حسب صلاحياتك.</p>'+
      '<form id="staff-login" class="stack-form card-body" autocomplete="on">'+
      '<label>اسم المستخدم<input class="form-control" name="username" maxlength="60" required autocomplete="username" dir="ltr"></label>'+
      '<label>كلمة المرور<input class="form-control" name="password" type="password" required autocomplete="current-password" dir="ltr"></label>'+
      '<button type="submit" class="btn primary btn-primary full">تسجيل الدخول '+icon('arrow',18)+'</button>'+
      '<p id="staff-login-feedback" class="login-feedback" role="alert" aria-live="assertive" hidden></p>'+
      '</form></div></section></div><div id="staff-toast" class="toast" role="status"></div>';
}
const sections=[['home','الرئيسية','home'],['products','المواد','package'],['inventory','الجرد','clipboard'],['alerts','التنبيهات','bell']];
function shell(){
 return '<div class="shell shell-v6 page '+(state.sidebarOpen?'':'sidebar-narrow')+'">'+
   '<aside id="sidebar" class="sidebar navbar navbar-vertical '+(state.sidebarOpen?'':'collapsed')+'">'+
     '<div class="sidebar-head"><span class="brand-square">'+icon('package',24)+'</span><span class="sidebar-titles"><strong>أفراح الوطن</strong><small>للتجارة العامة</small></span></div>'+
     '<p class="menu-caption">القائمة الرئيسية</p><nav aria-label="قائمة الموظفين">'+sections.map(([key,title,glyph])=>
       '<button type="button" class="nav-link '+(state.section===key?'active':'')+'" data-nav="'+key+'"><span class="nav-icon">'+icon(glyph,20)+'</span><span>'+title+'</span>'+
       (key==='alerts'&&state.alerts.length?'<b class="nav-count">'+number(state.alerts.length)+'</b>':'')+'</button>').join('')+'</nav>'+
     '<div class="sidebar-bottom">شركة أفراح الوطن</div></aside>'+
   '<div class="mobile-scrim '+(state.sidebarOpen?'show':'')+'" data-toggle="menu"></div>'+
   '<div class="main-shell"><header class="topbar navbar">'+
     '<div class="topbar-start"><button class="icon-btn sidebar-toggle" type="button" data-toggle="menu" aria-label="فتح القائمة">'+icon('menu',22)+'</button></div>'+
     '<div class="header-centered-logo"><img src="/assets/tapello.svg?v=20261105-pdf-logo" alt="Tapello"></div>'+
     '<div class="topbar-actions"><button type="button" class="top-alert" data-nav="alerts" aria-label="التنبيهات">'+icon('bell',20)+
       (state.alerts.length?'<span>'+number(state.alerts.length)+'</span>':'')+'</button>'+
       '<div class="user-badge"><div class="user-circle avatar">'+icon('users',18)+'</div>'+
       '<div class="user-detail"><strong>'+safe(state.user.full_name)+'</strong><small>الموظف</small></div></div>'+
       '<button type="button" class="icon-btn logout" data-logout="1" aria-label="تسجيل الخروج">'+icon('logout',20)+'</button></div></header>'+
     '<main class="workspace" id="staff-workspace"></main></div>'+
   '</div><div class="toast" id="staff-toast" role="status"></div>';
}
function results(q,limit=12){
 const data=filterArabicProducts(state.products,q,limit);
 if(!data.length)return '<p class="search-empty">ماكو مواد مطابقة للبحث.</p>';
 return data.map(p=>'<div class="search-product">'+asset(p)+
   '<div class="search-product-info"><strong>'+safe(p.name)+'</strong>'+
   '<span>'+safe(p.description)+'</span><small>الصنع: '+safe(p.manufacture||'—')+'</small></div>'+
   '<div class="staff-result-side"><span>المتوفر: '+number(p.quantity)+'</span>'+pricing(p)+'</div></div>').join('');
}
function home(){
 const alerts=state.alerts.slice(0,5);
 return '<div class="af-home af-home-v4">'+
   '<section class="card af-greeting-card"><div class="card-status-top bg-blue"></div>'+
     '<div class="card-body af-greeting-body"><div class="af-greeting-tag">شركة أفراح الوطن للتجارة العامة</div>'+
     '<h1>يــا هـلا و مـرحـبـا</h1><p>نظام تجهيزات المطاعم والمواد الاستهلاكية</p></div></section>'+
   '<section class="af-home-search"><label for="staff-home-search" class="af-home-search-label">ابحث عن مادة</label>'+
     '<div class="af-search-input">'+icon('search',21)+'<input id="staff-home-search" type="search" autocomplete="off" placeholder="اسم المادة أو وصفها أو الصنع..." value="'+safe(state.query)+'"></div>'+
     '<div id="staff-home-results" class="af-search-results" aria-live="polite">'+(state.query.trim()?results(state.query):'')+'</div></section>'+
   '<section class="af-home-alerts"><div class="af-home-alert-heading"><div><span class="af-alert-ico">'+icon('bell',20)+'</span>'+
     '<h2>تنبيهات المواد</h2></div><button type="button" class="af-link" data-nav="alerts">عرض الكل '+icon('arrow',17)+'</button></div>'+
     '<div class="af-home-alert-list">'+(alerts.length?alerts.map(a=>
       '<div class="af-home-alert-row"><strong>'+safe(a.name)+'</strong><span class="af-alert-value">'+
       (a.quantity===0?'نفدت المادة':'المتوفر: '+number(a.quantity))+'</span></div>').join(''):
       '<div class="af-all-good">'+icon('check',20)+' لا توجد مواد وصلت إلى حد التنبيه.</div>')+'</div></section>'+
   '</div>';
}
function pageHeading(title,subtitle){
 return '<div class="page-title"><div><h1>'+title+'</h1><p>'+subtitle+'</p></div></div>';
}
function productRows(list,inventory=false){
 return '<section class="panel card"><div class="panel-head"><h2>'+ (inventory?'جرد المواد':'المواد المسجّلة')+
    '</h2><span class="count-label">'+number(list.length)+' مادة</span></div>'+
   '<div class="staff-list">'+list.map(p=>
     '<article class="staff-product-row">'+asset(p)+
       '<div class="staff-product-info"><strong>'+safe(p.name)+'</strong><small>'+safe(p.description)+'</small>'+
       '<span>الصنع: '+safe(p.manufacture||'—')+'</span></div>'+
       '<div class="staff-product-meta"><span class="staff-qty">العدد: '+number(p.quantity)+'</span>'+status(p)+
       (inventory?'':pricing(p))+'</div></article>').join('')+'</div></section>';
}
function products(){
 const rows=state.query.trim()?filterArabicProducts(state.products,state.query):state.products;
 return pageHeading('المواد','قائمة المواد والأسعار المسموح لك بمشاهدتها.')+
   '<div class="products-searchbar"><label for="staff-products-search">البحث عن مادة</label>'+
   '<div class="af-search-input">'+icon('search',20)+'<input id="staff-products-search" type="search" autocomplete="off" placeholder="الاسم أو الوصف أو الصنع..." value="'+safe(state.query)+'"></div></div>'+
   productRows(rows);
}
function inventory(){return pageHeading('الجرد','الكميات الفعلية المتوفرة')+productRows(state.products,true);}
function alerts(){
 return pageHeading('التنبيهات','المواد التي قاربت على النفاد أو نفدت')+
   '<section class="panel card"><div class="staff-alert-list">'+
     (state.alerts.length?state.alerts.map(a=>'<div class="af-home-alert-row"><strong>'+
       safe(a.name)+'</strong><span class="af-alert-value">'+
       (a.quantity===0?'نفدت المادة':'المتوفر: '+number(a.quantity))+'</span></div>').join(''):
       '<p class="af-all-good">لا توجد تنبيهات حالياً.</p>')+'</div></section>';
}
function workspace(){
 const root=document.getElementById('staff-workspace');
 if(!root)return;
 root.innerHTML=({home,products,inventory,alerts}[state.section]||home)();
 void paintPhotos(root);
}
function render(){
 app.innerHTML=state.user?shell():loginView();
 if(state.user)workspace();
}
async function refresh(){
 const [products,alerts]=await Promise.all([api('/products'),api('/alerts')]);
 state.products=products;
 state.alerts=alerts;
}
function reset(){
 state.user=null;state.products=[];state.alerts=[];
 setAccessToken(null);setCsrf(null);clearPhotos();render();
}
async function boot(){
 try {
  const self=await api('/me');
  if(self.user?.role==='admin'){location.replace('/admin');return;}
  if(self.user?.role!=='staff')throw Error('Invalid role');
  state.user=self.user;setCsrf(self.csrf);await refresh();
 } catch {setAccessToken(null);setCsrf(null);state.user=null;}
 render();
}
document.addEventListener('submit',async e=>{
 const form=e.target.closest('#staff-login');if(!form)return;
 e.preventDefault();
 const submit=form.querySelector('button[type=submit]');
 const error=form.querySelector('#staff-login-feedback');
 error.hidden=true;error.textContent='';
 submit.disabled=true;submit.textContent='جارٍ التحقق...';
 try{
  const data=new FormData(form);
  const result=await api('/auth/login',{method:'POST',data:{username:String(data.get('username')||'').trim(),password:String(data.get('password')||'')}});
  if(result.user?.role!=='staff'){
   await api('/auth/logout',{method:'POST'}).catch(()=>{});
   throw Error('هذا حساب الإدارة. استخدم بوابة الإدارة المنفصلة.');
  }
  setAccessToken(result.access_token);setCsrf(result.csrf);
  state.user=result.user;state.section='home';state.query='';
  await refresh();render();
 } catch(err){
  // A failed login must not leave a half-authenticated staff session.
  setAccessToken(null);setCsrf(null);state.user=null;
  error.textContent=err.message||'تعذّر تسجيل الدخول';
  error.hidden=false;
 } finally {submit.disabled=false;submit.innerHTML='تسجيل الدخول '+icon('arrow',18);}
});
document.addEventListener('click',async e=>{
 const el=e.target.closest('[data-nav],[data-logout],[data-toggle]');
 if(!el||!state.user)return;
 if(el.dataset.toggle){state.sidebarOpen=!state.sidebarOpen;render();return;}
 if(el.dataset.nav){
  state.section=el.dataset.nav;state.query='';
  if(innerWidth<950)state.sidebarOpen=false;
  render();scrollTo(0,0);return;
 }
 if(el.dataset.logout){
  try{await api('/auth/logout',{method:'POST'});}catch{}
  reset();
 }
});
document.addEventListener('input',e=>{
 const input=e.target;
 if(input.id==='staff-home-search'){
  state.query=input.value;
  const dest=document.getElementById('staff-home-results');
  if(dest){dest.innerHTML=state.query.trim()?results(state.query):'';void paintPhotos(dest);}
 }
 if(input.id==='staff-products-search'){
  const selection=input.selectionStart;
  state.query=input.value;
  workspace();
  const field=document.getElementById('staff-products-search');
  field?.focus();
  if(selection!==null)field?.setSelectionRange(selection,selection);
 }
});
boot();
