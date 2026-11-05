// أفراح الوطن — بوابة الموظف المستقلة.
// There are no admin screens, edit forms, user controls, or quote builders here.
// Admin UI lives in /web/admin-app.js and is served by the separate /admin entry.
import {api,apiMedia,setCsrf,setAccessToken,money,number,safe} from './api.js?v=20261106-staff';
import {icon} from './icons.js?v=20261105-price-tag';
import {filterArabicProducts} from './arabic-search.js?v=20261106-ar-v1';
import {resumePortal,switchPortal} from './portal-handoff.js?v=20261106-login-v2';

const app=document.getElementById('app');
const state={user:null,products:[],alerts:[],section:'home',query:'',prepareQuery:'',draft:[],executionLists:[],sidebarOpen:innerWidth>=950};
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
      '<h1>أهلاً بك في أفراح الوطن</h1><p class="muted">سجّل الدخول لمشاهدة المواد والجرد والتنبيهات حسب صلاحياتك.</p>'+
      '<form id="staff-login" class="stack-form card-body" autocomplete="on">'+
      '<label>اسم المستخدم<input class="form-control" name="username" maxlength="60" required autocomplete="username" dir="ltr"></label>'+
      '<label>كلمة المرور<input class="form-control" name="password" type="password" required autocomplete="current-password" dir="ltr"></label>'+
      '<button type="submit" class="btn primary btn-primary full">تسجيل الدخول '+icon('arrow',18)+'</button>'+
      '<p id="staff-login-feedback" class="login-feedback" role="alert" aria-live="assertive" hidden></p>'+
      '</form></div></section></div><div id="staff-toast" class="toast" role="status"></div>';
}
const sections=[['home','الرئيسية','home'],['products','المواد','package'],['inventory','الجرد','clipboard'],['alerts','التنبيهات','bell'],['prepare','جهّز قائمة','table'],['account','بيانات الدخول','shield']];
function shell(){
 return `<div class="shell shell-v6 page ${state.sidebarOpen?'':'sidebar-narrow'}">
   <aside id="sidebar" class="sidebar navbar navbar-vertical ${state.sidebarOpen?'':'collapsed'}">
     <div class="sidebar-head"><span class="brand-square">${icon('package',24)}</span><span class="sidebar-titles"><strong>أفراح الوطن</strong><small>للتجارة العامة</small></span></div>
     <p class="menu-caption">القائمة الرئيسية</p><nav aria-label="قائمة الموظفين">${sections.map(([key,title,glyph])=>'<button type="button" class="nav-link '+(state.section===key?'active':'')+'" data-nav="'+key+'"><span class="nav-icon">'+icon(glyph,20)+'</span><span>'+title+'</span>'+(key==='alerts'&&state.alerts.length?'<b class="nav-count">'+number(state.alerts.length)+'</b>':'')+'</button>').join('')}</nav>
     <div class="sidebar-bottom">شركة أفراح الوطن</div>
   </aside>
   <div class="mobile-scrim ${state.sidebarOpen?'show':''}" data-toggle="menu"></div>
   <div class="main-shell"><header class="topbar navbar af-dual-header">
        <div class="af-brand-row" aria-label="الهوية الرسمية للشركة">
          <a class="af-brand-primary" href="/" title="أفراح الوطن — الرئيسية"><img src="/assets/afrah-alwatan.svg?v=20261106" alt="Afrah Al Watan — أفراح الوطن"></a>
          <div class="af-brand-secondary" aria-label="العلامة التجارية Tapello">
            <span class="af-brand-secondary-copy">علامتنا التجارية للمنتجات اللاصقة</span>
            <img src="/assets/tapello.svg?v=20261105-pdf-logo" alt="Tapello">
          </div>
        </div>
        <div class="topbar-start">
          <button type="button" class="icon-btn sidebar-toggle" data-toggle="menu" aria-label="فتح القائمة">${icon('menu',22)}</button>
        </div>
        <div class="af-utility-intro"><strong>بوابة الموظفين</strong><span>نظام تجهيز المواد والمخزون</span></div>
        <div class="topbar-actions">
          <button type="button" class="top-alert" data-nav="alerts" aria-label="التنبيهات">${icon('bell',20)}${state.alerts.length?'<span>'+number(state.alerts.length)+'</span>':''}</button>
          <details class="af-account-menu">
            <summary class="af-account-trigger" aria-label="فتح قائمة الحساب">${icon('users',19)}<span>الحساب</span>${icon('arrow',14)}</summary>
            <div class="af-account-popover">
              <div class="af-account-name"><strong>${safe(state.user.full_name)}</strong><small>${state.user.role==='admin'?'الإدارة — عرض الموظفين':'الموظف'}</small></div>
              ${state.user.role==='admin'?'<button type="button" class="portal-switch-btn" data-switch="admin">'+icon('shield',17)+' العودة للإدارة</button>':''}
              <button type="button" class="icon-btn logout" data-logout="1">${icon('logout',18)} تسجيل الخروج</button>
            </div>
          </details>
        </div>
      </header>
     <main class="workspace" id="staff-workspace"></main>
   </div></div><div class="toast" id="staff-toast" role="status"></div>`;
}
function results(q,limit=12){
 const data=filterArabicProducts(state.products,q,limit);
 if(!data.length)return '<p class="search-empty">ماكو مواد مطابقة للبحث.</p>';
 return data.map(p=>'<div class="search-product">'+asset(p)+
   '<div class="search-product-info"><strong>'+safe(p.name)+'</strong>'+
   '<span>'+safe(p.description)+'</span><small>الصنع: '+safe(p.manufacture||'—')+'</small></div>'+
   '<div class="staff-result-side"><span>المتوفر: '+number(p.quantity)+'</span>'+pricing(p)+ '<button type="button" class="btn primary staff-add-to-list" data-add="'+p.id+'">'+icon('plus',17)+' إضافة للقائمة</button></div></div>').join('');
}
function home(){
 const alerts=state.alerts.slice(0,5);
 return '<div class="af-home af-home-v4">'+
   '<section class="card af-greeting-card"><div class="card-status-top bg-blue"></div>'+
     '<div class="card-body af-greeting-body"><div class="af-greeting-tag">شركة أفراح الوطن للتجارة العامة</div>'+
     '<h1>يــا هـلا و مـرحـبـا</h1><p>ابحث عن المواد، وجهّز قائمة التنفيذ، وتابع حالة المخزون بسهولة.</p></div></section>'+
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

let prepareGrid=null;
function selectedRows(){
 return state.draft.map(item=>{
  const p=state.products.find(x=>x.id===item.product_id);
  return p?{...p,quantity:item.quantity,sale_total:state.user.can_view_sale?item.quantity*p.sale_price:undefined}:null;
 }).filter(Boolean);
}
function preparedTotals(){
 const rows=selectedRows(),parts=[];
 if(state.user?.can_view_purchase)parts.push('<span>إجمالي الشراء: <b>'+money(rows.reduce((n,p)=>n+p.quantity*p.purchase_price,0))+'</b></span>');
 if(state.user?.can_view_sale)parts.push('<span>إجمالي البيع: <b>'+money(rows.reduce((n,p)=>n+p.quantity*p.sale_price,0))+'</b></span>');
 return parts.join(' ');
}
function prepare(){
 return '<div class="af-prep staff-prep">'+
  '<div class="af-prep-heading"><h1>جهّز قائمة</h1><p>ابحث عن المواد واجمعها في جدول واحد، وعدّل العدد قبل الطباعة.</p></div>'+
  '<section class="card af-prep-search-card"><div class="card-body">'+
  '<label class="af-input-label" for="staff-prepare-search">البحث عن المواد</label>'+
  '<div class="af-search-input">'+icon('search',21)+'<input id="staff-prepare-search" type="search" autocomplete="off" placeholder="اسم المادة أو وصفها أو الصنع..." value="'+safe(state.prepareQuery)+'"></div>'+
  '<div class="af-search-results" id="staff-prepare-results">'+(state.prepareQuery.trim()?results(state.prepareQuery):'<p class="af-search-hint">ابحث عن مادة واضغط «إضافة للقائمة»، وكرر العملية لإضافة غيرها.</p>')+'</div></div></section>'+
  '<section class="card af-prep-sheet"><header class="af-prep-sheet-header"><div><span class="af-prep-sheet-title">'+icon('table',22)+'<h2>قائمة المواد المختارة</h2></span>'+
  '<p>رتّب الأعمدة وعدّل الكميات داخل الجدول.</p></div><span class="af-prep-count">'+number(state.draft.length)+' مادة</span></header>'+
  '<p class="af-prep-scroll-tip">يمكن تمرير الجدول أفقياً على الموبايل.</p>'+
  '<div class="af-tabulator-wrap"><div id="staff-grid" aria-label="جدول تجهيز القائمة"></div></div>'+
  '<footer class="staff-prep-footer"><div class="staff-prep-total" id="staff-prep-total">'+preparedTotals()+'</div>'+
  '<div class="staff-prep-actions"><button class="btn quiet" type="button" id="staff-print-list" '+(state.draft.length?'':'disabled')+'>'+icon('printer',18)+' طباعة القائمة</button>'+
  (state.user.role==='staff'?'<button class="btn primary" type="button" id="staff-save-list" '+(state.draft.length?'':'disabled')+'>'+icon('save',18)+' حفظ قائمة التنفيذ</button>':'')+'</div></footer></section>'+
  '<section class="card staff-execution-history"><div class="staff-history-heading"><h2>قوائم التنفيذ المحفوظة</h2><span>'+number(state.executionLists.length)+' قائمة</span></div>'+
  '<div class="staff-history-body">'+(state.executionLists.length?state.executionLists.map(record=>
   '<details class="staff-history-entry"><summary><span>قائمة رقم '+number(record.id)+'</span><small>'+
   safe(new Date(record.created_at).toLocaleDateString('ar-IQ'))+' — '+number(record.items.length)+' مادة</small></summary>'+
   '<div class="staff-history-items">'+record.items.map(item=>
    '<div class="staff-history-item">'+(item.image_url?'<img data-photo="'+safe(item.image_url)+'" alt="صورة المادة">':icon('package',19))+
    '<div><strong>'+safe(item.name)+'</strong><small>'+safe(item.description||'')+
    ' — '+safe(item.manufacture||'—')+'</small></div><b>العدد: '+number(item.quantity)+'</b></div>'
   ).join('')+'</div></details>'
  ).join(''):'<p class="staff-history-empty">لم تُحفظ أي قائمة تنفيذ بعد.</p>')+'</div></section></div>';
}
function renderPreparedGrid(){
 const host=document.getElementById('staff-grid');
 if(!host)return;
 if(typeof window.Tabulator!=='function'){host.textContent='مكتبة الجدول غير متاحة. أعد تشغيل الخادم.';return;}
 const columns=[
  {title:'ت',formatter:'rownum',width:50,hozAlign:'center',headerSort:false},
  {title:'الصورة',field:'image_url',width:88,headerSort:false,formatter(cell){return asset(cell.getRow().getData()).replace('class="product-thumb"','class="af-grid-photo"');}},
  {title:'اسم المنتج',field:'name',width:190,formatter(cell){return '<strong class="af-grid-name">'+safe(cell.getValue())+'</strong>';}},
  {title:'الوصف',field:'description',width:200,variableHeight:true,formatter(cell){return '<span class="af-grid-description">'+safe(cell.getValue()||'—')+'</span>';}},
  {title:'الصنع',field:'manufacture',width:130,formatter(cell){return safe(cell.getValue()||'—');}},
  {title:'العدد',field:'quantity',width:108,hozAlign:'center',editor:'number',editorParams:{min:1,max:100000000,step:1},
   validator:['integer','min:1','max:100000000'],formatter(cell){return '<span class="af-grid-editable">'+number(cell.getValue())+' '+icon('edit',13)+'</span>';}},
 ];
 if(state.user?.can_view_purchase)columns.push({title:'سعر الشراء',field:'purchase_price',width:145,formatter(cell){return money(cell.getValue());}});
 if(state.user?.can_view_sale){
  columns.push({title:'سعر البيع',field:'sale_price',width:145,formatter(cell){return money(cell.getValue());}});
  columns.push({title:'إجمالي البيع',field:'sale_total',width:160,bottomCalc:'sum',
    formatter(cell){return money(cell.getValue());},bottomCalcFormatter(cell){return money(cell.getValue()||0);}});
 }
 columns.push({title:'حذف',width:70,hozAlign:'center',headerSort:false,formatter(cell){
  return '<button type="button" class="af-grid-remove" data-remove="'+cell.getRow().getData().id+'" aria-label="حذف المادة">'+icon('x',16)+'</button>';
 }});
 prepareGrid=new window.Tabulator(host,{data:selectedRows(),index:'id',layout:'fitDataStretch',textDirection:'rtl',
  editTriggerEvent:'click',placeholder:'القائمة فارغة. ابحث عن مادة وأضفها.',columns,
  rowFormatter:()=>queueMicrotask(()=>{void paintPhotos(host);})
 });
 prepareGrid.on('renderComplete',()=>{void paintPhotos(host)});
 prepareGrid.on('tableBuilt',()=>{void paintPhotos(host)});
 prepareGrid.on('cellEdited',cell=>{
  if(cell.getField()!=='quantity')return;
  const row=cell.getRow().getData(),n=Number(cell.getValue());
  if(!Number.isSafeInteger(n)||n<1||n>100000000){cell.restoreOldValue();message('العدد يجب أن يكون صحيحاً بين 1 و100000000');return;}
  const draft=state.draft.find(x=>x.product_id===row.id);
  if(!draft)return;
  draft.quantity=n;
  if(state.user?.can_view_sale)cell.getRow().update({sale_total:n*row.sale_price});
  const totals=document.getElementById('staff-prep-total');
  if(totals)totals.innerHTML=preparedTotals();
 });
}
async function saveExecutionList(){
 if(!state.draft.length)return;
 const button=document.getElementById('staff-save-list');
 if(button){button.disabled=true;button.textContent='جارٍ حفظ القائمة...';}
 try{
  const items=state.draft.map(item=>({product_id:item.product_id,quantity:item.quantity}));
  const saved=await api('/execution-lists',{method:'POST',data:{items}});
  state.executionLists.unshift(saved);
  state.draft=[];state.prepareQuery='';
  workspace();
  message('تم حفظ قائمة التنفيذ بنجاح',false);
 }catch(error){
  message(error?.message||'تعذّر حفظ القائمة');
  if(button){button.disabled=false;button.innerHTML='حفظ قائمة التنفيذ';}
 }
}
async function printPreparedList(){
 const rows=selectedRows(),purchase=Boolean(state.user.can_view_purchase),sale=Boolean(state.user.can_view_sale);
 if(!rows.length)return;
 const headers=['الصورة','اسم المادة','الوصف','الصنع','العدد',...(purchase?['سعر الشراء']:[]),...(sale?['سعر البيع','إجمالي البيع']:[])];
 const body=rows.map(p=>'<tr><td>'+asset(p)+'</td><td>'+safe(p.name)+'</td><td>'+safe(p.description)+'</td>'+
  '<td>'+safe(p.manufacture)+'</td><td>'+number(p.quantity)+'</td>'+
  (purchase?'<td>'+money(p.purchase_price)+'</td>':'')+
  (sale?'<td>'+money(p.sale_price)+'</td><td>'+money(p.sale_total)+'</td>':'')+'</tr>').join('');
 const root=document.getElementById('print-root');
 root.innerHTML='<div class="print-sheet staff-print"><header>شركة أفراح الوطن للتجارة العامة — قائمة مواد</header>'+
 '<table><thead><tr>'+headers.map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+body+'</tbody></table>'+
 '<footer>'+preparedTotals()+'</footer></div>';
 await paintPhotos(root);
 await Promise.all(Array.from(root.querySelectorAll('img')).map(img=>img.decode?.().catch(()=>{})||Promise.resolve()));
 document.body.classList.add('printing');window.print();
}
window.addEventListener('afterprint',()=>document.body.classList.remove('printing'));

function account(){
 return pageHeading('بيانات الدخول','غيّر اسم الدخول أو كلمة المرور الخاصة بحسابك.')+
 '<section class="panel card account-form-card"><div class="panel-head"><h2>إعدادات الحساب</h2></div>'+
 '<form id="staff-account-form" class="account-form">'+
 '<label>اسم الدخول<input class="form-control" name="username" required pattern="[a-zA-Z0-9_.-]{3,60}" value="'+safe(state.user.username)+'" autocomplete="username" dir="ltr"></label>'+
 '<label>كلمة المرور الحالية<input class="form-control" name="current_password" type="password" required autocomplete="current-password" dir="ltr"></label>'+
 '<label>كلمة مرور جديدة (اختياري)<input class="form-control" name="new_password" type="password" minlength="10" maxlength="128" autocomplete="new-password" dir="ltr"></label>'+
 '<label>تأكيد كلمة المرور الجديدة<input class="form-control" name="confirm_password" type="password" autocomplete="new-password" dir="ltr"></label>'+
 '<p class="account-hint">إذا تريد تغير اسم الدخول فقط، اترك خانة كلمة المرور الجديدة فارغة.</p>'+
 '<p id="staff-account-feedback" class="login-feedback" role="alert" hidden></p>'+
 '<button class="btn primary" type="submit">'+icon('save',18)+' حفظ بيانات الدخول</button></form></section>';
}
function workspace(){
 const root=document.getElementById('staff-workspace');
 if(!root)return;
 if(prepareGrid){prepareGrid.destroy();prepareGrid=null;}
 root.innerHTML=({home,products,inventory,alerts,prepare,account}[state.section]||home)();
 void paintPhotos(root);
 if(state.section==='prepare')renderPreparedGrid();
}
function render(){
 app.innerHTML=state.user?shell():loginView();
 if(state.user)workspace();
}
async function refresh(){
 const [products,alerts,executionLists]=await Promise.all([api('/products'),api('/alerts'),api('/execution-lists')]);
 state.products=products;
 state.alerts=alerts;
 state.executionLists=executionLists;
}
function reset(){
 state.user=null;state.products=[];state.alerts=[];state.draft=[];state.prepareQuery='';state.executionLists=[];
 setAccessToken(null);setCsrf(null);clearPhotos();render();
}
async function boot(){
 try {
  await resumePortal(api,setAccessToken,setCsrf);
  const self=await api('/me');
  if(!['staff','admin'].includes(self.user?.role))throw Error('Invalid role');
  state.user=self.user;setCsrf(self.csrf);await refresh();
 } catch {setAccessToken(null);setCsrf(null);state.user=null;}
 render();
}
document.addEventListener('submit',async e=>{
 if(e.target.id==='staff-account-form'){
  e.preventDefault();
  const form=e.target;
  const data=new FormData(form);
  const feedback=document.getElementById('staff-account-feedback');
  if(feedback)feedback.hidden=true;
  const newPassword=String(data.get('new_password')||'');
  const confirmPassword=String(data.get('confirm_password')||'');
  try{
   if(newPassword!==confirmPassword)throw Error('تأكيد كلمة المرور الجديدة مختلف');
   const body={username:String(data.get('username')||'').trim(),current_password:String(data.get('current_password')||'')};
   if(newPassword)body.new_password=newPassword;
   const result=await api('/auth/change-credentials',{method:'POST',data:body});
   state.user=result.user;
   workspace();message('تم حفظ بيانات الدخول الجديدة',false);
  }catch(err){
   if(feedback){feedback.textContent=err?.message||'تعذر حفظ البيانات';feedback.hidden=false;}
  }
  return;
 }
 const form=e.target.closest('#staff-login');if(!form)return;
 e.preventDefault();
 const submit=form.querySelector('button[type=submit]');
 const error=form.querySelector('#staff-login-feedback');
 error.hidden=true;error.textContent='';
 submit.disabled=true;submit.textContent='جارٍ التحقق...';
 try{
  const data=new FormData(form);
  const result=await api('/staff/auth/login',{method:'POST',data:{username:String(data.get('username')||'').trim(),password:String(data.get('password')||'')}});
  if(!['staff','admin'].includes(result.user?.role)){
   throw Error('حساب غير مسموح');
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
 const el=e.target.closest('[data-switch],[data-add],[data-remove],[data-nav],[data-logout],[data-toggle],#staff-print-list,#staff-save-list');
 if(el?.dataset.switch==='admin'&&state.user?.role==='admin'){
   try{await switchPortal(api,'/admin');}catch(err){message(err?.message||'تعذر الانتقال للإدارة');}
   return;
 }
 if(el?.hasAttribute('data-add') && state.user){
  const id=Number(el.dataset.add);
  if(!state.products.some(p=>p.id===id))return;
  const item=state.draft.find(x=>x.product_id===id);
  if(item)item.quantity=Math.min(100000000,item.quantity+1);
  else state.draft.push({product_id:id,quantity:1});
  state.section='prepare';state.query='';state.prepareQuery='';
  if(innerWidth<950)state.sidebarOpen=false;
  render();message('أُضيفت المادة إلى القائمة',false);
  document.getElementById('staff-prepare-search')?.focus();return;
 }
 if(el?.hasAttribute('data-remove') && state.user){
  state.draft=state.draft.filter(x=>x.product_id!==Number(el.dataset.remove));
  workspace();return;
 }
 if(el?.id==='staff-print-list' && state.user){await printPreparedList();return;}
 if(el?.id==='staff-save-list' && state.user){await saveExecutionList();return;}
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
 if(input.id==='staff-prepare-search'){
  state.prepareQuery=input.value;
  const target=document.getElementById('staff-prepare-results');
  if(target){target.innerHTML=state.prepareQuery.trim()?results(state.prepareQuery):
    '<p class="af-search-hint">ابحث عن مادة واضغط «إضافة للقائمة».</p>';
    void paintPhotos(target);}
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
