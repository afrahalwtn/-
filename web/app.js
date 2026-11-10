// أفراح الوطن — بوابة الموظف المستقلة.
// There are no admin screens, edit forms, user controls, or quote builders here.
// Admin UI lives in /web/admin-app.js and is served by the separate /admin entry.
import {api,apiMedia,setCsrf,setAccessToken,money,number,safe} from './api.js?v=20261109-media-pool-3';
import {quantityEditor} from './numeric-input.js?v=20261110-safari-1';
import {makeOfflineVault} from './offline-vault.js?v=20261110-vault-1';
import {icon} from './icons.js?v=20261109-nudaui-5';
import {filterArabicProducts} from './arabic-search.js?v=20261106-ar-v1';
import {resumePortal,switchPortal} from './portal-handoff.js?v=20261106-login-v2';

const app=document.getElementById('app');
const state={user:null,products:[],alerts:[],section:'home',query:'',prepareQuery:'',draft:[],executionLists:[],pendingLists:[],sidebarOpen:innerWidth>=950,catalogLimit:100,offlineMode:false,offlineUpdatedAt:0,offlineEnabled:false,offlineGeneration:''};
const vault=makeOfflineVault('staff');
const photos=new Map();
function clearPhotos(){for(const p of photos.values())p.then(u=>URL.revokeObjectURL(u)).catch(()=>{});photos.clear();}
function asset(p){
  if(state.offlineMode)return '<span class="product-no-image">'+icon('package',22)+'</span>';
  if(!p.image_url)return '<span class="product-no-image">'+icon('package',22)+'</span>';
  return '<img class="product-thumb" data-photo="'+safe(p.image_url)+'" alt="صورة '+safe(p.name)+'" loading="lazy">';
}
async function loadStaffPhoto(img){
  if(!img.isConnected||img.dataset.imageLoading==='1'||img.src.startsWith('blob:'))return;
  const url=img.dataset.photo;
  if(!/^\/api\/images\/[0-9a-f]{32}\.(?:png|jpg|webp)$/i.test(url))return;
  img.dataset.imageLoading='1';
  if(photos.has(url)){
    const cached=photos.get(url);
    photos.delete(url);
    photos.set(url,cached);
  }else{
    const pending=apiMedia(url.slice(4)).then(b=>URL.createObjectURL(b)).catch(err=>{
      if(photos.get(url)===pending)photos.delete(url);
      throw err;
    });
    photos.set(url,pending);
    while(photos.size>(window.innerWidth<700?60:120)){
      const oldest=photos.keys().next().value;
      if(oldest===undefined)break;
      const evicted=photos.get(oldest);
      photos.delete(oldest);
      evicted.then(objectURL=>URL.revokeObjectURL(objectURL)).catch(()=>{});
    }
  }
  try{const object=await photos.get(url);if(img.isConnected)img.src=object;}
  catch{if(img.isConnected)img.alt='صورة غير متاحة';}
  finally{delete img.dataset.imageLoading;}
}
const staffPhotoObserver=typeof IntersectionObserver==='function'
  ?new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting)continue;
      staffPhotoObserver.unobserve(entry.target);
      void loadStaffPhoto(entry.target);
    }
  },{rootMargin:'320px'}):null;
async function paintPhotos(root){
  const images=Array.from(root?.querySelectorAll('img[data-photo]')||[]);
  const printing=root?.id==='print-root'||Boolean(root?.closest?.('#print-root'));
  if(printing||!staffPhotoObserver)await Promise.all(images.map(loadStaffPhoto));
  else for(const img of images){
    if(!img.src.startsWith('blob:')&&img.dataset.imageLoading!=='1')
      staffPhotoObserver.observe(img);
  }
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
  return p.quantity===0?'<span class="chip danger">نفد الايتم</span>':
  p.low_stock?'<span class="chip warning">قريبة من النفاد</span>':
  '<span class="chip success">متوفرة</span>';
}
function itemSpecs(p){
  const list=[p.item_type,p.category,p.unit,p.sku?'رمز: '+p.sku:null].filter(Boolean);
  const dims=[p.length_cm,p.width_cm,p.height_cm].filter(v=>v!==null&&v!==undefined);
  if(dims.length)list.push('القياسات: '+dims.join(' × ')+' سم');
  if(p.weight_g!==null&&p.weight_g!==undefined)list.push('الوزن: '+p.weight_g+' غرام');
  for(const extra of (p.custom_fields||[]))list.push(extra.label+': '+extra.value);
  return list.length?'<small class="af-item-meta">'+safe(list.join(' • '))+'</small>':'';
}
function usdPrice(value){
  return value===null||value===undefined?'':new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(value)+' $';
}
function pricing(p){
  let out='';
  if(state.user?.can_view_purchase && p.purchase_price!==undefined){
    out+='<span class="staff-price"><small>سعر الشراء</small><b>'+money(p.purchase_price)+'</b>'+
      (p.purchase_price_usd!==null&&p.purchase_price_usd!==undefined?'<small>'+usdPrice(p.purchase_price_usd)+'</small>':'')+'</span>';
  }
  if(state.user?.can_view_sale && p.sale_price!==undefined){
    out+='<span class="staff-price"><small>سعر المفرد</small><b>'+money(p.sale_price)+'</b>'+
      (p.retail_price_usd!==null&&p.retail_price_usd!==undefined?'<small>'+usdPrice(p.retail_price_usd)+'</small>':'')+'</span>';
    if(p.wholesale_price_iqd!==null&&p.wholesale_price_iqd!==undefined || p.wholesale_price_usd!==null&&p.wholesale_price_usd!==undefined){
      out+='<span class="staff-price"><small>سعر الجملة</small>'+
        (p.wholesale_price_iqd!==null&&p.wholesale_price_iqd!==undefined?'<b>'+money(p.wholesale_price_iqd)+'</b>':'')+
        (p.wholesale_price_usd!==null&&p.wholesale_price_usd!==undefined?'<small>'+usdPrice(p.wholesale_price_usd)+'</small>':'')+'</span>';
    }
  }
  return out;
}
function loginView(){
  return '<div class="auth-page auth-v6 page page-center">'+
    '<div class="auth-visual"><div class="auth-visual-inner">'+
      '<div class="auth-brand-mark"><img class="af-auth-main-logo" src="/assets/afrah-alwatan.svg?v=20261109-original" alt="أفراح الوطن"></div>'+
      '<div class="auth-preview"><img class="auth-logo" src="/assets/tapello.svg?v=20261105-pdf-logo" alt="Tapello"></div>'+
    '</div></div>'+
    '<section class="auth-content"><div class="auth-box card"><span class="auth-kicker">بوابة الموظفين</span>'+
      '<h1>أهلاً بك في أفراح الوطن</h1><p class="muted">سجّل الدخول لمشاهدة الايتمات والجرد والتنبيهات حسب صلاحياتك.</p>'+
      '<form id="staff-login" class="stack-form card-body" autocomplete="on">'+
      '<label>اسم المستخدم<input class="form-control" name="username" maxlength="60" required autocomplete="username" dir="auto"></label>'+
      '<label>كلمة المرور<input class="form-control" name="password" type="password" required autocomplete="current-password" dir="ltr"></label>'+
      '<button type="submit" class="btn primary btn-primary full">تسجيل الدخول '+icon('arrow',18)+'</button>'+
      '<p id="staff-login-feedback" class="login-feedback" role="alert" aria-live="assertive" hidden></p>'+
      '</form></div></section></div><div id="staff-toast" class="toast" role="status"></div>';
}
const sections=[['home','الرئيسية','home'],['products','الايتمات','package'],['inventory','الجرد','clipboard'],['alerts','التنبيهات','bell'],['prepare','جهّز قائمة','table'],['account','بيانات الدخول','shield']];
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
          <a class="af-brand-primary" href="/" title="أفراح الوطن — الرئيسية"><img src="/assets/afrah-alwatan.svg?v=20261109-original" alt="Afrah Al Watan — أفراح الوطن"></a>
          <div class="af-brand-secondary" aria-label="العلامة التجارية Tapello">
            <span class="af-brand-secondary-copy">علامتنا التجارية للمنتجات اللاصقة</span>
            <img src="/assets/tapello.svg?v=20261105-pdf-logo" alt="Tapello">
          </div>
        </div>
        <div class="topbar-start">
          <button type="button" class="icon-btn sidebar-toggle" data-toggle="menu" aria-label="فتح القائمة">${icon('menu',22)}</button>
        </div>
        <div class="af-utility-intro"><strong>بوابة الموظفين</strong><span>نظام تجهيز الايتمات والمخزون</span></div>
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
 if(!data.length)return '<p class="search-empty">ماكو ايتمات مطابقة للبحث.</p>';
 return data.map(p=>'<div class="search-product">'+asset(p)+
   '<div class="search-product-info"><strong>'+safe(p.name)+'</strong>'+
   '<span>'+safe(p.description)+'</span><small>الصنع: '+safe(p.manufacture||'—')+'</small>'+itemSpecs(p)+'</div>'+
   '<div class="staff-result-side"><span>المتوفر: '+number(p.quantity)+'</span>'+pricing(p)+ '<button type="button" class="btn primary staff-add-to-list" data-add="'+p.id+'">'+icon('plus',17)+' إضافة للقائمة</button></div></div>').join('');
}
function home(){
 const alerts=state.alerts.slice(0,5);
 return '<div class="af-home af-home-v4">'+
   '<section class="card af-greeting-card"><div class="card-status-top bg-blue"></div>'+
     '<div class="card-body af-greeting-body"><div class="af-greeting-tag">شركة أفراح الوطن للتجارة العامة</div>'+
     '<h1><span class="nuda-blur-reveal" dir="rtl" lang="ar">يا هلا ومرحبا</span></h1><p>ابحث عن الايتمات، وجهّز قائمة التنفيذ، وتابع حالة المخزون بسهولة.</p></div></section>'+
   '<section class="af-home-search"><label for="staff-home-search" class="af-home-search-label">ابحث عن ايتم</label>'+
     '<div class="af-search-input">'+icon('search',21)+'<input id="staff-home-search" type="search" autocomplete="off" placeholder="اسم الايتم أو وصفها أو الصنع..." value="'+safe(state.query)+'"></div>'+
     '<div id="staff-home-results" class="af-search-results" aria-live="polite">'+(state.query.trim()?results(state.query):'')+'</div></section>'+
   '<section class="af-home-alerts"><div class="af-home-alert-heading"><div><span class="af-alert-ico">'+icon('bell',20)+'</span>'+
     '<h2>تنبيهات الايتمات</h2></div><button type="button" class="af-link" data-nav="alerts">عرض الكل '+icon('arrow',17)+'</button></div>'+
     '<div class="af-home-alert-list">'+(alerts.length?alerts.map(a=>
       '<div class="af-home-alert-row"><strong>'+safe(a.name)+'</strong><span class="af-alert-value">'+
       (a.quantity===0?'نفد الايتم':'المتوفر: '+number(a.quantity))+'</span></div>').join(''):
       '<div class="af-all-good">'+icon('check',20)+' لا توجد ايتمات وصلت إلى حد التنبيه.</div>')+'</div></section>'+
   '</div>';
}
function pageHeading(title,subtitle){
 return '<div class="page-title"><div><h1>'+title+'</h1><p>'+subtitle+'</p></div></div>';
}
function productRows(list,inventory=false){
 return '<section class="panel card"><div class="panel-head"><h2>'+ (inventory?'جرد الايتمات':'الايتمات المسجّلة')+
    '</h2><span class="count-label">'+number(list.length)+' ايتم</span></div>'+
   '<div class="staff-list">'+list.slice(0,state.catalogLimit).map(p=>
     '<article class="staff-product-row">'+asset(p)+
       '<div class="staff-product-info"><strong>'+safe(p.name)+'</strong><small>'+safe(p.description)+'</small>'+
       '<span>الصنع: '+safe(p.manufacture||'—')+'</span>'+itemSpecs(p)+'</div>'+
       '<div class="staff-product-meta"><span class="staff-qty">العدد: '+number(p.quantity)+'</span>'+status(p)+
       (inventory?'':pricing(p))+'</div></article>').join('')+'</div>'+ (list.length>state.catalogLimit?'<div class="af-catalog-more"><span>معروض '+number(state.catalogLimit)+' من '+number(list.length)+' أيتم</span><button type="button" class="btn quiet" data-more="catalog">عرض 100 أيتم إضافي</button></div>':'')+'</section>';
}
function products(){
 const rows=state.query.trim()?filterArabicProducts(state.products,state.query):state.products;
 return pageHeading('الايتمات','قائمة الايتمات والأسعار المسموح لك بمشاهدتها.')+
   '<div class="products-searchbar"><label for="staff-products-search">البحث عن ايتم</label>'+
   '<div class="af-search-input">'+icon('search',20)+'<input id="staff-products-search" type="search" autocomplete="off" placeholder="الاسم أو الوصف أو الصنع..." value="'+safe(state.query)+'"></div></div>'+
   productRows(rows);
}
function inventory(){return pageHeading('الجرد','الكميات الفعلية المتوفرة')+productRows(state.products,true);}
function alerts(){
 return pageHeading('التنبيهات','الايتمات التي قاربت على النفاد أو نفدت')+
   '<section class="panel card"><div class="staff-alert-list">'+
     (state.alerts.length?state.alerts.map(a=>'<div class="af-home-alert-row"><strong>'+
       safe(a.name)+'</strong><span class="af-alert-value">'+
       (a.quantity===0?'نفد الايتم':'المتوفر: '+number(a.quantity))+'</span></div>').join(''):
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
  '<div class="af-prep-heading"><h1>جهّز قائمة</h1><p>ابحث عن الايتمات واجمعها في جدول واحد، وعدّل العدد قبل الطباعة.</p></div>'+
  '<section class="card af-prep-search-card"><div class="card-body">'+
  '<label class="af-input-label" for="staff-prepare-search">البحث عن الايتمات</label>'+
  '<div class="af-search-input">'+icon('search',21)+'<input id="staff-prepare-search" type="search" autocomplete="off" placeholder="اسم الايتم أو وصفها أو الصنع..." value="'+safe(state.prepareQuery)+'"></div>'+
  '<div class="af-search-results" id="staff-prepare-results">'+(state.prepareQuery.trim()?results(state.prepareQuery):'<p class="af-search-hint">ابحث عن ايتم واضغط «إضافة للقائمة»، وكرر العملية لإضافة غيرها.</p>')+'</div></div></section>'+
  '<section class="card af-prep-sheet"><header class="af-prep-sheet-header"><div><span class="af-prep-sheet-title">'+icon('table',22)+'<h2>قائمة الايتمات المختارة</h2></span>'+
  '<p>رتّب الأعمدة وعدّل الكميات داخل الجدول.</p></div><span class="af-prep-count">'+number(state.draft.length)+' ايتم</span></header>'+
  '<p class="af-prep-scroll-tip">يمكن تمرير الجدول أفقياً على الموبايل.</p>'+
  '<div class="af-tabulator-wrap"><div id="staff-grid" aria-label="جدول تجهيز القائمة"></div></div>'+
  '<footer class="staff-prep-footer"><div class="staff-prep-total" id="staff-prep-total">'+preparedTotals()+'</div>'+
  '<div class="staff-prep-actions"><button class="btn quiet" type="button" id="staff-print-list" '+(state.draft.length?'':'disabled')+'>'+icon('printer',18)+' طباعة القائمة</button>'+
  (state.user.role==='staff'?'<button class="btn primary" type="button" id="staff-save-list" '+(state.draft.length?'':'disabled')+'>'+icon('save',18)+(state.offlineMode?' حفظ مسودة محلية':' حفظ قائمة التنفيذ')+'</button>':'')+'</div></footer></section>'+
  (state.pendingLists.length?'<section class="card af-offline-outbox"><div class="staff-history-heading"><h2>قوائم محفوظة على الجهاز ولم تُرسل</h2><span>'+number(state.pendingLists.length)+' قائمة</span></div>'+
   '<p class="af-offline-outbox-note">كل قائمة محفوظة مستقلة، وتبقى حتى تتأكد مزامنتها مع الشركة.</p>'+
   '<div class="staff-history-body">'+state.pendingLists.map((entry,index)=>
     '<details class="staff-history-entry"><summary><span>قائمة محلية '+number(index+1)+'</span><small>'+safe(new Date(entry.created_at).toLocaleString('ar-IQ'))+
     ' — '+number(entry.items.length)+' أيتم</small></summary><div class="staff-history-items">'+entry.items.map(row=>{
       const product=state.products.find(p=>p.id===row.product_id);
       return '<div class="staff-history-item"><div><strong>'+safe(product?.name||'أيتم رقم '+row.product_id)+'</strong></div><b>العدد: '+number(row.quantity)+'</b></div>';
     }).join('')+'</div></details>').join('')+'</div>'+
   (!state.offlineMode?'<button type="button" class="btn primary" id="staff-sync-pending">مزامنة القوائم المحفوظة</button>':'')+'</section>':'')+
  '<section class="card staff-execution-history"><div class="staff-history-heading"><h2>قوائم التنفيذ المحفوظة</h2><span>'+number(state.executionLists.length)+' قائمة</span></div>'+
  '<div class="staff-history-body">'+(state.executionLists.length?state.executionLists.map(record=>
   '<details class="staff-history-entry"><summary><span>قائمة رقم '+number(record.id)+'</span><small>'+
   safe(new Date(record.created_at).toLocaleDateString('ar-IQ'))+' — '+number(record.items.length)+' ايتم</small></summary>'+
   '<div class="staff-history-items">'+record.items.map(item=>
    '<div class="staff-history-item">'+(item.image_url?'<img data-photo="'+safe(item.image_url)+'" alt="صورة الايتم">':icon('package',19))+
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
  {title:'العدد',field:'quantity',width:108,hozAlign:'center',editor:quantityEditor,
   validator:['integer','min:1','max:100000000'],formatter(cell){return '<span class="af-grid-editable">'+number(cell.getValue())+' '+icon('edit',13)+'</span>';}},
 ];
 if(state.user?.can_view_purchase)columns.push({title:'سعر الشراء',field:'purchase_price',width:145,formatter(cell){return money(cell.getValue());}});
 if(state.user?.can_view_sale){
  columns.push({title:'سعر البيع',field:'sale_price',width:145,formatter(cell){return money(cell.getValue());}});
  columns.push({title:'إجمالي البيع',field:'sale_total',width:160,bottomCalc:'sum',
    formatter(cell){return money(cell.getValue());},bottomCalcFormatter(cell){return money(cell.getValue()||0);}});
 }
 columns.push({title:'حذف',width:70,hozAlign:'center',headerSort:false,formatter(cell){
  return '<button type="button" class="af-grid-remove" data-remove="'+cell.getRow().getData().id+'" aria-label="حذف الايتم">'+icon('x',16)+'</button>';
 }});
 prepareGrid=new window.Tabulator(host,{data:selectedRows(),index:'id',layout:'fitDataStretch',textDirection:'rtl',
  editTriggerEvent:'click',placeholder:'القائمة فارغة. ابحث عن ايتم وأضفها.',columns,
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
  if(vault.unlocked)void vault.saveDraft(state.draft).catch(()=>message('تعذّر حفظ العدد محلياً'));
 });
}
let pendingSyncInFlight=false;
async function syncPendingLists(){
 if(pendingSyncInFlight||state.offlineMode||state.user?.role!=='staff'||!state.pendingLists.length)return;
 pendingSyncInFlight=true;
 let synced=0,failed=null;
 try{
  for(const record of [...state.pendingLists]){
   try{
    const saved=await api('/execution-lists',{method:'POST',
      data:{items:record.items,client_request_id:record.client_request_id}});
    // Acknowledge locally only AFTER the server confirms persistence.
    await vault.acknowledgeExecutionList(record.client_request_id);
    state.pendingLists=await vault.listPending();
    if(!state.executionLists.some(x=>x.id===saved.id))state.executionLists.unshift(saved);
    synced++;
   }catch(error){failed=error;break;}
  }
  if(!state.offlineEnabled&&state.pendingLists.length===0)await vault.clear();
  if(state.section==='prepare')workspace();
  if(synced)message('تمت مزامنة '+number(synced)+' قائمة محفوظة مع الشركة',false);
  if(failed)message('بقيت قوائم محلية لم تتأكد مزامنتها: '+(failed?.message||'تحقق من الاتصال'));
 }finally{pendingSyncInFlight=false;}
}
let executionSaveInFlight=false;
async function saveExecutionList(){
 if(!state.draft.length||executionSaveInFlight)return;
 executionSaveInFlight=true;
 const button=document.getElementById('staff-save-list');
 if(button){button.disabled=true;button.textContent='جارٍ حفظ القائمة...';}
 try{
  if(state.offlineMode){
    await vault.enqueueExecutionList(state.draft);
    state.pendingLists=await vault.listPending();
    state.draft=[];state.prepareQuery='';
    workspace();
    message('انحفظت قائمة مستقلة على الجهاز؛ تگدر تباشر بقائمة جديدة',false);
    return;
  }
  const items=state.draft.map(item=>({product_id:item.product_id,quantity:item.quantity}));
  const saved=await api('/execution-lists',{method:'POST',data:{items}});
  state.executionLists.unshift(saved);
  state.draft=[];state.prepareQuery='';
  workspace();
  message('تم حفظ قائمة التنفيذ بنجاح',false);
 }catch(error){
  message(error?.message||'تعذّر حفظ القائمة');
  if(button){button.disabled=false;button.innerHTML='حفظ قائمة التنفيذ';}
 }finally{
  executionSaveInFlight=false;
 }
}
async function printPreparedList(){
 const rows=selectedRows(),purchase=Boolean(state.user.can_view_purchase),sale=Boolean(state.user.can_view_sale);
 if(!rows.length)return;
 const headers=['الصورة','اسم الايتم','الوصف','الصنع','العدد',...(purchase?['سعر الشراء']:[]),...(sale?['سعر البيع','إجمالي البيع']:[])];
 const body=rows.map(p=>'<tr><td>'+asset(p)+'</td><td>'+safe(p.name)+'</td><td>'+safe(p.description)+'</td>'+
  '<td>'+safe(p.manufacture)+'</td><td>'+number(p.quantity)+'</td>'+
  (purchase?'<td>'+money(p.purchase_price)+'</td>':'')+
  (sale?'<td>'+money(p.sale_price)+'</td><td>'+money(p.sale_total)+'</td>':'')+'</tr>').join('');
 const root=document.getElementById('print-root');
 root.innerHTML='<div class="print-sheet staff-print"><header>شركة أفراح الوطن للتجارة العامة — قائمة ايتمات</header>'+
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
 '<label>اسم الدخول<input class="form-control" name="username" required minlength="3" maxlength="60" value="'+safe(state.user.username)+'" autocomplete="username" dir="auto"></label>'+
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
 root.innerHTML=(state.offlineMode?'<aside class="af-offline-banner" role="status"><strong>وضع أوفلاين — البيانات ليست مباشرة</strong><span>آخر تحديث: '+safe(new Date(state.offlineUpdatedAt).toLocaleString('ar-IQ'))+'</span><button class="btn quiet" type="button" id="staff-reconnect">الاتصال بالخادم</button></aside>':'')+
   ({home,products,inventory,alerts,prepare,account}[state.section]||home)();
 if(vault.unlocked)void vault.saveDraft(state.draft).catch(()=>message('تعذر حفظ المسودة محلياً'));
 void paintPhotos(root);
 if(state.section==='prepare')renderPreparedGrid();
}
function render(){
 app.innerHTML=state.user?shell():loginView();
 if(state.user)workspace();
}
async function refresh(){
 const [products,alerts,executionLists,policy]=await Promise.all([
  api('/products'),api('/alerts'),api('/execution-lists'),api('/offline-mode')
 ]);
 state.products=products;state.alerts=alerts;state.executionLists=executionLists;
 state.offlineEnabled=policy.enabled===true;state.offlineGeneration=policy.generation||'';
 if(state.offlineEnabled){
  try{
   await vault.enable({user:state.user,products,alerts,executionLists},state.draft,state.offlineGeneration);
   const snapshot=await vault.unlock();
   if(!state.draft.length&&snapshot.user.id===state.user.id)state.draft=snapshot.draft;
   state.pendingLists=snapshot.pendingLists||[];
  }catch(error){console.warn('Offline device copy unavailable',error?.message);}
 }else{
  // Management may disable offline while lists have not been sent.
  // Stop offline browsing immediately but never erase those work records.
  try{
   if(!vault.unlocked&&await vault.hasSnapshot())await vault.unlock({ignoreBlock:true});
   state.pendingLists=await vault.listPending();
   if(state.pendingLists.length)await vault.blockOffline();
   else await vault.clear();
  }catch(error){console.warn('Pending list preservation failed',error?.message);}
 }
 if(state.pendingLists.length&&state.user?.role==='staff'&&!state.offlineMode)
   setTimeout(()=>{void syncPendingLists();},0);
}
function reset(){
 state.user=null;state.products=[];state.alerts=[];state.draft=[];state.prepareQuery='';state.executionLists=[];state.pendingLists=[];state.offlineMode=false;state.offlineUpdatedAt=0;state.offlineEnabled=false;state.offlineGeneration='';
 vault.lock();
 setAccessToken(null);setCsrf(null);clearPhotos();render();
}
async function boot(){
 try {
  await resumePortal(api,setAccessToken,setCsrf);
  const self=await api('/me');
  if(!['staff','admin'].includes(self.user?.role))throw Error('Invalid role');
  state.user=self.user;setCsrf(self.csrf);state.offlineMode=false;await refresh();
 } catch(error){
  setAccessToken(null);setCsrf(null);state.user=null;
  if(error?.status===401||error?.status===403)await vault.clear().catch(()=>{});
  else{
   try{
    const snapshot=await vault.unlock();
    if(['staff','admin'].includes(snapshot.user?.role)){
     state.user=snapshot.user;state.products=snapshot.products;
     state.alerts=snapshot.alerts||[];state.executionLists=snapshot.executionLists||[];
     state.draft=snapshot.draft;state.pendingLists=snapshot.pendingLists||[];state.offlineMode=true;state.offlineEnabled=true;
     state.offlineGeneration=snapshot.generation;state.offlineUpdatedAt=snapshot.updatedAt;
     state.section='home';
    }
   }catch{}
  }
 }
 render();
}
document.addEventListener('submit',async e=>{
 if(e.target.id==='staff-account-form'){
  e.preventDefault();
  if(state.offlineMode){message('تغيير بيانات الدخول يحتاج اتصال بالخادم');return;}
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
window.addEventListener('online',()=>{
 if(state.offlineMode)document.getElementById('staff-reconnect')?.click();
 else void syncPendingLists();
});
document.addEventListener('click',async e=>{
 if(e.target.closest('#staff-sync-pending')){
  await syncPendingLists();
  return;
 }
 if(e.target.closest('#staff-reconnect')){
  try{
   const self=await api('/me');
   if(!self?.user||self.user.id!==state.user?.id||self.user.role!==state.user?.role)
    throw Error('سجّل دخولاً مباشراً بالحساب نفسه لإكمال العمل');
   const draft=state.draft;
   state.user=self.user;setCsrf(self.csrf);
   state.offlineMode=false;
   await refresh();state.draft=draft;
   if(state.offlineEnabled)await vault.saveDraft(draft);
   workspace();
   void syncPendingLists();
   message('اتصلنا بالخادم، وسنرسل القوائم المحلية مع التأكد من عدم تكرارها',false);
  }catch(err){message(err.message||'تعذّر الاتصال؛ المسودة ما زالت محلية');}
  return;
 }
 const el=e.target.closest('[data-switch],[data-add],[data-remove],[data-nav],[data-logout],[data-toggle],[data-more],#staff-print-list,#staff-save-list');
 if(el?.dataset.switch==='admin'&&state.user?.role==='admin'){
  if(state.offlineMode){message('تبديل البوابات يتطلب اتصالاً بالخادم');return;}
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
  render();message('أُضيفت الايتم إلى القائمة',false);
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
 if(el.dataset.more==='catalog'){
  state.catalogLimit=Math.min(state.products.length,state.catalogLimit+100);
  workspace();return;
 }
 if(el.dataset.nav){
  state.catalogLimit=100;
  state.section=el.dataset.nav;state.query='';
  if(innerWidth<950)state.sidebarOpen=false;
  render();scrollTo(0,0);return;
 }
 if(el.dataset.logout){
  if(state.offlineMode){await vault.clear().catch(()=>{});reset();return;}
  try{await api('/auth/logout',{method:'POST'});}catch(err){message(err?.message||'لم يتأكد تسجيل الخروج؛ تحقق من الاتصال وأعد المحاولة');return;}
  await vault.clear().catch(()=>{});reset();
 }
});
// Keep catalogue typing smooth without changing the staff UI or search results.
let staffSearchTimer;
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
    '<p class="af-search-hint">ابحث عن ايتم واضغط «إضافة للقائمة».</p>';
    void paintPhotos(target);}
 }
 if(input.id==='staff-products-search'){
  state.query=input.value;
  state.catalogLimit=100;
  clearTimeout(staffSearchTimer);
  staffSearchTimer=setTimeout(()=>{
   if(state.section!=='products')return;
   const previous=document.getElementById('staff-products-search');
   if(!previous)return;
   const focused=document.activeElement===previous;
   const selection=focused?previous.selectionStart:null;
   workspace();
   if(focused){
    const field=document.getElementById('staff-products-search');
    field?.focus();
    if(selection!==null)field?.setSelectionRange(selection,selection);
   }
  },120);
 }
});
document.addEventListener('click',e=>{
  if(!e.target.closest('.af-account-menu'))
    document.querySelectorAll('.af-account-menu[open]').forEach(menu=>menu.open=false);
},true);
boot();
