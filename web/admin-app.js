import {api, apiMedia, setCsrf, setAccessToken, money, number, safe} from './api.js?v=20261105-secure-images';
import {icon} from './icons.js?v=20261105-price-tag';
import {filterArabicProducts} from './arabic-search.js?v=20261106-ar-v1';
import {resumePortal,switchPortal} from './portal-handoff.js?v=20261106-login-v2';

const state = {
  user:null, showRecovery:false, section:'home', products:[], alerts:[], users:[], quotes:[],
  search:'', homeSearch:'', quoteSearch:'', sidebarOpen:true, modal:null, draft:[], selectedQuote:null, loading:false,
};
const app = document.getElementById('app');
const printRoot = document.getElementById('print-root');
const isAdmin = () => state.user?.role === 'admin';
const canPurchase = () => state.user?.can_view_purchase;
const canSale = () => state.user?.can_view_sale;

function status(product) {
  if (product.quantity === 0) return '<span class="chip danger">نفدت المادة</span>';
  if (product.low_stock) return '<span class="chip warning">قريبة من النفاد</span>';
  return '<span class="chip success">متوفرة</span>';
}
function placeholder() { return `<div class="product-no-image">${icon('package',24)}</div>`; }
function image(product, cssClass='product-thumb') {
  return product.image_url ?
    '<img class="'+safe(cssClass)+'" data-private-image="'+safe(product.image_url)+'" alt="صورة '+safe(product.name||product.product_name)+'" loading="lazy">' :
    placeholder();
}
// Product photos remain protected when third-party cookies are blocked.
const privateImages = new Map();
function forgetPrivateImages() {
  for (const pending of privateImages.values()) pending.then(url=>URL.revokeObjectURL(url)).catch(()=>{});
  privateImages.clear();
}
function getPrivateImage(url) {
  if (!privateImages.has(url)) {
    const pending=apiMedia(url.slice(4)).then(blob=>URL.createObjectURL(blob)).catch(err=>{
      privateImages.delete(url);throw err;
    });
    privateImages.set(url,pending);
  }
  return privateImages.get(url);
}
async function hydrateImages(root) {
  const images=Array.from(root?.querySelectorAll('img[data-private-image]')||[]);
  await Promise.all(images.map(async node=>{
    try {
      const objectURL=await getPrivateImage(node.dataset.privateImage);
      if (node.isConnected) node.src=objectURL;
    } catch {
      if (node.isConnected){node.alt='تعذّر تحميل صورة المنتج';node.classList.add('image-failed');}
    }
  }));
}
function showToast(message, error=false) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast visible' + (error ? ' error' : '');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(()=>toast.classList.remove('visible'), 4000);
}
function errorToast(err) {
  if (err?.status === 401 && state.user) { state.user=null; setCsrf(null); setAccessToken(null); forgetPrivateImages(); render(); }
  showToast(err?.message || 'تعذر تنفيذ الطلب', true);
}
function showLoginError(message) {
  const target=document.getElementById('login-feedback');
  if (target) { target.textContent=message; target.hidden=false; }
  else showToast(message,true);
}
async function refresh() {
  const [products, alerts] = await Promise.all([api('/products'), api('/alerts')]);
  state.products = products;
  state.alerts = alerts;
  if (isAdmin()) {
    const [users, quotes] = await Promise.all([api('/users'), api('/quotes')]);
    state.users=users; state.quotes=quotes;
  } else { state.users=[]; state.quotes=[]; }
}
async function boot() {
  try {
    await resumePortal(api,setAccessToken,setCsrf);
    const res = await api('/admin/me');
    if (res.user?.role !== 'admin') throw new Error('هذه الصفحة للإدارة فقط');
    state.user = res.user;
    state.sidebarOpen = window.innerWidth >= 950;
    setCsrf(res.csrf);
    await refresh();
  } catch { state.user=null; setCsrf(null); setAccessToken(null); }
  render();
}
function loginView() {
  return `<div class="auth-page auth-v6 page page-center">
    <div class="auth-visual" aria-hidden="true">
      <div class="auth-visual-inner">
        <div class="auth-brand-mark"><span class="auth-brand-dot"></span> شركة أفراح الوطن <small>للتجارة العامة</small></div>
        <div class="auth-preview">
          <span class="auth-preview-top">بوابة الإدارة</span>
          <img src="/assets/tapello.svg?v=20261105-pdf-logo" alt="" class="auth-logo">
          <span class="auth-preview-bottom">المواد <i></i> الجرد <i></i> عروض الأسعار</span>
        </div>
      </div>
    </div>
    <section class="auth-content">
      <div class="auth-box card">
        <span class="auth-kicker">أفراح الوطن للتجارة العامة</span>
        <h1>أهلاً بك في أفراح الوطن</h1>
        <p class="muted">سجّل دخول الإدارة للوصول إلى المواد والجرد والصلاحيات وعروض الأسعار.</p>
        ${state.showRecovery? `<form data-form="recovery" class="stack-form card-body">
          <p class="auth-help">إذا فقدت رمز الإدارة، فعّل وضع الاستعادة على خادم الشركة وخذ الرمز المؤقت من شاشة الخادم. الاستعادة موقوفة افتراضياً.</p>
          <label>رمز الاستعادة من شاشة الخادم<input class="form-control" name="recovery_code" required autocomplete="off" maxlength="24" dir="ltr"></label>
          <label>اسم الدخول الجديد<input class="form-control" name="username" required autocomplete="username" pattern="[a-zA-Z0-9_.-]{3,60}" dir="ltr"></label>
          <label>كلمة المرور الجديدة<input class="form-control" name="new_password" type="password" required minlength="10" maxlength="128" autocomplete="new-password" dir="ltr"></label>
          <label>تأكيد كلمة المرور<input class="form-control" name="confirm_password" type="password" required minlength="10" maxlength="128" autocomplete="new-password" dir="ltr"></label>
          <button type="submit" class="btn primary btn-primary full">استعادة حساب الإدارة</button>
          <p id="recovery-feedback" class="login-feedback" role="alert" aria-live="assertive" hidden></p>
        </form>`:`<form data-form="login" class="stack-form card-body">
          <label>اسم المستخدم<input class="form-control" name="username" required autocomplete="username" maxlength="60" placeholder="اسم المستخدم" dir="ltr"></label>
          <label>كلمة المرور<input class="form-control" name="password" type="password" required autocomplete="current-password" placeholder="كلمة المرور" dir="ltr"></label>
          <button type="submit" class="btn primary btn-primary full">تسجيل الدخول ${icon('arrow',18)}</button>
          <p id="login-feedback" class="login-feedback" role="alert" aria-live="assertive" hidden></p>
        </form>`}
        <button class="auth-recovery-toggle" type="button" data-action="recovery-toggle">${state.showRecovery?'الرجوع لتسجيل الدخول':'رمز الإدارة ما يشتغل؟ استعادة الحساب'}</button>
      </div>
    </section>
  </div><div id="toast" class="toast" role="status"></div>`;
}
const navItems = [
  ['home','الرئيسية','home'], ['products','المواد','package'], ['inventory','الجرد','clipboard'],
  ['alerts','التنبيهات','bell'], ['prepare','جهّز قائمة','table'], ['quotes','عروض الأسعار','tag'], ['users','المستخدمون','users'], ['account','بيانات الدخول','shield'],
];
function renderShell() {
  const nav = navItems.filter(([key])=> isAdmin() || !['prepare','quotes','users'].includes(key));
  return `<div class="shell shell-v6 page ${state.sidebarOpen?'':'sidebar-narrow'}">
    <aside class="sidebar navbar navbar-vertical ${state.sidebarOpen?'':'collapsed'}" id="sidebar">
      <div class="sidebar-head">
        <span class="brand-square">${icon('package',24)}</span>
        <span class="sidebar-titles"><strong>أفراح الوطن</strong><small>للتجارة العامة</small></span>
      </div>
      <p class="menu-caption">القائمة الرئيسية</p>
      <nav aria-label="التنقل الرئيسي">${nav.map(([key,title,glyph])=>`<button type="button" class="nav-link ${state.section===key?'active':''}" data-action="nav" data-section="${key}" title="${title}"><span class="nav-icon nav-icon-${key}">${icon(glyph,20)}</span><span>${title}</span>${key==='alerts'&&state.alerts.length?`<b class="nav-count">${state.alerts.length}</b>`:''}</button>`).join('')}</nav>
      <div class="sidebar-bottom"><span class="sidebar-bottom-line"></span><span>Tapello</span></div>
    </aside>
    <div class="mobile-scrim ${state.sidebarOpen?'show':''}" data-action="toggle-sidebar"></div>
    <div class="main-shell">
      <header class="topbar navbar af-dual-header">
        <div class="af-brand-row" aria-label="الهوية الرسمية للشركة">
          <a class="af-brand-primary" href="/admin" title="أفراح الوطن — الرئيسية"><img src="/assets/afrah-alwatan.svg?v=20261106" alt="Afrah Al Watan — أفراح الوطن"></a>
          <div class="af-brand-secondary" aria-label="العلامة التجارية Tapello">
            <span class="af-brand-secondary-copy">علامتنا التجارية للمنتجات اللاصقة</span>
            <img src="/assets/tapello.svg?v=20261105-pdf-logo" alt="Tapello">
          </div>
        </div>
        <div class="topbar-start">
          <button type="button" class="icon-btn sidebar-toggle" data-action="toggle-sidebar" aria-label="فتح وإغلاق القائمة">${icon('menu',22)}</button>
        </div>
        <div class="af-utility-intro"><strong>لوحة الإدارة</strong><span>نظام تجهيز المواد والمخزون</span></div>
        <div class="topbar-actions">
          <button type="button" class="top-alert" data-action="nav" data-section="alerts" title="تنبيهات المخزون">${icon('bell',20)}${state.alerts.length?'<span>'+number(state.alerts.length)+'</span>':''}</button>
          <details class="af-account-menu">
            <summary class="af-account-trigger" aria-label="فتح قائمة الحساب">${icon('users',19)}<span>الحساب</span>${icon('arrow',14)}</summary>
            <div class="af-account-popover">
              <div class="af-account-name"><strong>${safe(state.user.full_name)}</strong><small>${isAdmin()?'الإدارة':'المستخدم الثاني'}</small></div>
              <button type="button" class="portal-switch-btn" data-action="switch-staff" title="فتح بوابة الموظفين بدون تسجيل ثانٍ">${icon('shield',17)} بوابة الموظفين</button>
              <button type="button" class="icon-btn logout" data-action="logout">${icon('logout',18)} تسجيل الخروج</button>
            </div>
          </details>
        </div>
      </header>
      <main id="workspace" class="workspace"></main>
    </div>
  </div><div id="modal-layer"></div><div id="toast" class="toast" role="status"></div>`;
}
function pageTitle(title, subtitle, buttons='') {
  return `<div class="page-title"><div><div class="eyebrow">شركة أفراح الوطن للتجارة العامة</div><h1>${title}</h1><p>${subtitle}</p></div><div class="page-buttons">${buttons}</div></div>`;
}
function primaryButton(action, label, plus=true) { return `<button type="button" class="btn primary btn-primary" data-action="${action}">${icon(plus?'plus':'check',18)} ${label}</button>`; }
function searchableProductList(query, context) {
  if (!query.trim()) return '';
  const results=filterArabicProducts(state.products, query, 12);
  if (!results.length) return '<p class="search-empty">ماكو مواد مطابقة للبحث.</p>';
  return results.map(p=>
    '<article class="search-product">'+
    image(p,'search-product-photo')+
    '<div class="search-product-info"><strong>'+safe(p.name)+'</strong>'+
    '<span>'+safe(p.description||'')+'</span>'+
    '<small>الصنع: '+safe(p.manufacture||'—')+(canSale()?' · '+money(p.sale_price):'')+'</small></div>'+
    (isAdmin()?'<button class="btn primary quote-add-result" type="button" data-action="quote-add-item" data-id="'+p.id+'" aria-label="إضافة '+safe(p.name)+' لعرض الأسعار">'+icon('plus',17)+' إضافة للقائمة</button>':
      '<button class="btn quiet" type="button" data-action="nav" data-section="products">عرض المواد</button>')+
    '</article>'
  ).join('');
}
function homeView() {
  const alerts = state.alerts.slice(0,5);
  return `<div class="af-home af-home-v4">
    <section class="card af-greeting-card" aria-label="الترحيب">
      <div class="card-status-top bg-blue"></div>
      <div class="card-body af-greeting-body">
        <div class="af-greeting-tag">شركة أفراح الوطن للتجارة العامة</div>
        <h1>يــا هـلا و مـرحـبـا</h1>
        <p>اكتشف المواد، تابع المخزون، وجهّز طلباتك بسهولة من مكان واحد.</p>
      </div>
    </section>
    <section class="af-home-search" aria-label="البحث عن المواد">
      <label for="home-search" class="af-home-search-label">ابحث عن مادة</label>
      <div class="af-search-input">${icon('search',23)}<input id="home-search" type="search" autocomplete="off" placeholder="اكتب اسم المنتج أو وصفه أو بلد الصنع..." value="${safe(state.homeSearch)}"></div>
      <div id="home-search-results" class="af-search-results" aria-live="polite">${searchableProductList(state.homeSearch,'home')}</div>
    </section>
    <section class="af-home-alerts">
      <div class="af-home-alert-heading"><div><span class="af-alert-ico">${icon('bell',20)}</span><h2>تنبيهات المواد</h2>
        ${state.alerts.length?`<span class="af-alert-count">${number(state.alerts.length)}</span>`:''}
        </div><button type="button" data-action="nav" data-section="alerts" class="af-link">عرض جميع التنبيهات ${icon('arrow',16)}</button></div>
      <div class="af-home-alert-list">
        ${alerts.length?alerts.map(a=>`<div class="af-home-alert-row">
          <span class="af-alert-dot ${a.quantity===0?'out':''}"></span>
          <strong>${safe(a.name)}</strong>
          <span class="af-alert-value">${a.quantity===0?'نفدت الكمية':'المتوفر: '+number(a.quantity)}</span>
        </div>`).join(''):`<div class="af-all-good">${icon('check',20)} لا توجد مواد وصلت إلى حد التنبيه.</div>`}
      </div>
    </section>
  </div>`;
}

function productTable(rows, inventory=false) {
  if (!rows.length) return emptyState('لا توجد مواد لعرضها','ابدأ بإضافة المواد من حساب الإدارة.','package');
  return `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>المادة</th><th>الصنع</th><th>العدد</th>${inventory?'<th>حد التنبيه</th>':''}<th>الحالة</th>${!inventory&&canPurchase()?'<th>سعر الشراء</th>':''}${!inventory&&canSale()?'<th>سعر البيع</th>':''}${isAdmin()?'<th>الإجراء</th>':''}</tr></thead>
    <tbody>${rows.map(p=>`<tr>
      <td><div class="product-name">${image(p)}<div><strong>${safe(p.name)}</strong><small>${safe(p.description||'—')}</small></div></div></td>
      <td>${safe(p.manufacture||'—')}</td><td class="num strong">${number(p.quantity)}</td>
      ${inventory?`<td class="num">${number(p.min_quantity)}</td>`:''}
      <td>${status(p)}</td>
      ${!inventory&&canPurchase()?`<td class="num">${money(p.purchase_price)}</td>`:''}
      ${!inventory&&canSale()?`<td class="num">${money(p.sale_price)}</td>`:''}
      ${isAdmin()?`<td><div class="table-actions">${inventory?`<button class="tiny-btn" title="تعديل العدد" data-action="count" data-id="${p.id}">${icon('clipboard',17)}</button>`:`<button class="tiny-btn" title="تعديل المادة" data-action="edit-product" data-id="${p.id}">${icon('edit',17)}</button><button class="tiny-btn red" title="حذف المادة" data-action="delete-product" data-id="${p.id}">${icon('trash',16)}</button>`}</div></td>`:''}
    </tr>`).join('')}</tbody></table></div>`;
}
function productsView() {
  const rows=filterArabicProducts(state.products,state.search);
  return `${pageTitle('المواد','إدارة مواد تجهيز المطاعم وأسعارها وصورها.',isAdmin()?primaryButton('new-product','إضافة مادة'):'')}
    <div class="products-searchbar"><label for="products-search">البحث في المواد</label><div class="af-search-input">
      ${icon('search',21)}<input id="products-search" type="search" autocomplete="off" value="${safe(state.search)}" placeholder="اسم المادة أو الوصف أو بلد الصنع..." />
    </div></div>
    <section class="panel card"><div class="panel-head"><h2>المواد المسجّلة</h2><span class="count-label">${number(rows.length)} مادة</span></div>${productTable(rows)}</section>`;
}

function inventoryView() {
  return `${pageTitle('الجرد','متابعة العدد الفعلي لكل مادة وحدّ التنبيه عند النقص.')}
    <section class="panel card"><div class="panel-head"><h2>الكميات الحالية</h2><span class="count-label">${number(state.products.length)} مادة</span></div>${productTable(state.products,true)}</section>`;
}
function alertsView() {
  return `${pageTitle('التنبيهات','المواد التي وصلت إلى الحد الأدنى أو نفدت من المخزون.')}
    <section class="panel card"><div class="panel-head"><h2>تنبيهات المخزون</h2><span class="count-label">${number(state.alerts.length)} تنبيه</span></div>
      ${!state.alerts.length?emptyState('المخزون بحالة جيدة','لا توجد مواد وصلت إلى حد التنبيه.','check'):
      `<div class="alert-list">${state.alerts.map(a=>`<div class="alert-line"><span class="alert-badge">${icon('alert',21)}</span><div><strong>${safe(a.name)}</strong><small>${a.quantity===0?'نفدت المادة':'اقتربت من النفاد'} — المتوفر: ${number(a.quantity)} / حد التنبيه: ${number(a.min_quantity)}</small></div>${isAdmin()?`<button class="btn quiet small" data-action="count" data-id="${a.product_id}">تعديل العدد ${icon('arrow',16)}</button>`:''}</div>`).join('')}</div>`}
    </section>`;
}
function emptyState(head,sub,glyph) { return `<div class="empty">${icon(glyph,32)}<h3>${head}</h3><p>${sub}</p></div>`; }
function accountView() {
  return `${pageTitle('بيانات الدخول','غيّر اسم المستخدم أو كلمة مرور الإدارة بنفسك، بدون تعديل ملفات المشروع.')}
  <section class="panel card account-form-card">
    <div class="panel-head"><h2>تغيير بيانات حساب الإدارة</h2></div>
    <form class="account-form" data-form="account">
      <label>اسم الدخول<input name="username" class="form-control" pattern="[a-zA-Z0-9_.-]{3,60}" maxlength="60" required value="${safe(state.user.username)}" autocomplete="username" dir="ltr"></label>
      <label>كلمة المرور الحالية (للتحقق)<input name="current_password" class="form-control" type="password" required autocomplete="current-password" dir="ltr"></label>
      <label>كلمة مرور جديدة (اختياري)<input name="new_password" class="form-control" type="password" minlength="10" maxlength="128" autocomplete="new-password" dir="ltr"></label>
      <label>تأكيد كلمة المرور الجديدة<input name="confirm_password" class="form-control" type="password" autocomplete="new-password" dir="ltr"></label>
      <p class="account-hint">إذا تريد تغيّر الاسم فقط، اترك كلمة المرور الجديدة فارغة. التغيير ينحفظ بقاعدة البيانات ويلغي جلسات الأجهزة الثانية.</p>
      <button class="btn primary" type="submit">${icon('save',18)} حفظ بيانات الدخول</button>
    </form>
  </section>`;
}
function usersView() {
  if (!isAdmin()) return '';
  return `${pageTitle('المستخدمون','حساب الإدارة والتحكم بصلاحيات الاطلاع على الأسعار.',primaryButton('new-user','إضافة مستخدم'))}
    <div class="user-cards">${state.users.map(u=>`<section class="user-card panel"><div class="user-avatar">${icon(u.role==='admin'?'user-check':'users',26)}</div><div class="user-info"><h3>${safe(u.full_name)}</h3><p dir="ltr">${safe(u.username)}</p><span class="chip ${u.is_active?'success':'danger'}">${u.role==='admin'?'الإدارة':u.is_active?'مستخدم مفعّل':'الحساب معطّل'}</span></div>
      <div class="permission-list"><div>عرض سعر الشراء <b class="${u.can_view_purchase?'allowed':'forbidden'}">${u.can_view_purchase?'مسموح':'ممنوع'}</b></div><div>عرض سعر البيع <b class="${u.can_view_sale?'allowed':'forbidden'}">${u.can_view_sale?'مسموح':'ممنوع'}</b></div></div>
      ${u.role==='staff'?`<button type="button" class="btn quiet small" data-action="edit-user" data-id="${u.id}">${icon('edit',16)} ضبط الصلاحيات</button>`:''}</section>`).join('')}</div>`;
}
function prepareView(){
  if(!isAdmin()) return '';
  const rows=state.draft.map((d,idx)=>({d,idx,p:state.products.find(p=>p.id===d.product_id)})).filter(r=>r.p);
  const sum=rows.reduce((n,r)=>n+r.d.quantity*r.p.sale_price,0);
  return `<div class="af-prep">
    <div class="af-prep-heading"><div><span class="af-prep-overline">شركة أفراح الوطن للتجارة العامة</span><h1>جهّز قائمة</h1><p>ابحث عن المواد وأضفها للجدول، ثم عدّل العدد واحفظ عرض الأسعار.</p></div></div>
    <section class="card af-prep-search-card">
      <div class="card-body">
        <label for="quote-search" class="af-input-label">ابحث عن مادة لإضافتها إلى القائمة</label>
        <div class="af-search-input">${icon('search',21)}<input id="quote-search" type="search" autocomplete="off" placeholder="اسم المنتج أو الوصف أو بلد الصنع..." value="${safe(state.quoteSearch)}"></div>
        <div id="quote-search-results" class="af-search-results" aria-live="polite">${state.quoteSearch.trim()?searchableProductList(state.quoteSearch,'prepare'):'<p class="af-search-hint">ابحث عن المادة ثم اضغط «إضافة للقائمة». المواد المختارة تبقى بالجدول أثناء البحث عن غيرها.</p>'}</div>
      </div>
    </section>
    <section class="card af-prep-sheet">
      <header class="af-prep-sheet-header">
        <div><span class="af-prep-sheet-title">${icon('table',23)}<h2>قائمة المواد المختارة</h2></span><p>جدول قابل للترتيب وتعديل الأعداد، مثل جداول إكسل.</p></div>
        <span class="af-prep-count" id="prepare-count">${number(rows.length)} مادة</span>
      </header>
      <p class="af-prep-scroll-tip">يمكنك تمرير الجدول أفقياً على الموبايل لرؤية بقية الأعمدة.</p>
      <div class="af-tabulator-wrap"><div id="prepare-grid" aria-label="جدول تجهيز القائمة"></div></div>
      <footer class="af-prep-footer">
        <div class="af-prep-sum"><span>إجمالي عرض الأسعار</span><strong id="prepare-total">${money(sum)}</strong></div>
        <button type="button" class="btn primary af-prep-save" data-action="quote-create" ${rows.length?'':'disabled'}>${icon('save',18)} حفظ عرض الأسعار</button>
      </footer>
    </section>
  </div>`;
}

function quotesView(){
  if(!isAdmin()) return '';
  return `<div class="af-quotes">
    ${pageTitle('عروض الأسعار','العروض المحفوظة وصورها وأسعارها.',`<button class="btn primary" type="button" data-action="nav" data-section="prepare">${icon('table',19)} جهّز قائمة جديدة</button>`)}
    <section class="af-quotes-archive">
      <div class="af-archive-heading"><h2>عروض الأسعار المحفوظة</h2><span>${number(state.quotes.length)} عرض</span></div>
      ${state.quotes.length?`<div class="af-archive-list">${state.quotes.map(q=>`<button class="af-archive-row" type="button" data-action="quote-open" data-id="${q.id}"><span class="af-archive-icon">${icon('tag',20)}</span><span><strong>عرض رقم ${number(q.id)}</strong><small>${new Date(q.date).toLocaleDateString('ar-IQ')} • ${number(q.items.length)} مادة</small></span><b>${money(q.total)}</b>${icon('arrow',16)}</button>`).join('')}</div>`:'<p class="af-no-quotes">لا توجد عروض أسعار محفوظة بعد.</p>'}
    </section>
    ${state.selectedQuote?quotePreview(state.selectedQuote):''}
  </div>`;
}

function quotePreview(q) {
  return `<section class="panel quote-preview"><div class="panel-head"><h2>عرض أسعار رقم ${number(q.id)}</h2><button class="btn secondary" data-action="quote-print">${icon('printer',18)} طباعة / حفظ PDF</button></div>
    <div class="quote-meta"><b>شركة أفراح الوطن للتجارة العامة</b><span>التاريخ: ${new Date(q.date).toLocaleDateString('ar-IQ')}</span></div>
    <div class="table-wrap"><table class="data-table quote-table"><thead><tr><th>الصورة</th><th>المادة والوصف</th><th>الصنع</th><th>العدد</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>
    ${q.items.map(i=>`<tr><td>${image({...i,name:i.product_name})}</td><td><b>${safe(i.product_name)}</b><small class="subtext">${safe(i.description)}</small></td><td>${safe(i.manufacture||'—')}</td><td>${number(i.quantity)}</td><td>${money(i.unit_price)}</td><td class="strong">${money(i.total)}</td></tr>`).join('')}
    </tbody></table></div><div class="quote-sum">المجموع الكلي <strong>${money(q.total)}</strong></div></section>`;
}
function workspaceView() {
  return ({home:homeView,products:productsView,inventory:inventoryView,alerts:alertsView,prepare:prepareView,quotes:quotesView,users:usersView,account:accountView}[state.section] || homeView)();
}
let prepareTable=null;
function drawPreparedGrid() {
  const host=document.getElementById('prepare-grid');
  if(!host||!isAdmin())return;
  const entries=state.draft.map((d,idx)=>{
    const p=state.products.find(p=>p.id===d.product_id);
    if(!p)return null;
    return {id:p.id,idx,name:p.name,description:p.description||'',manufacture:p.manufacture||'',image_url:p.image_url,quantity:d.quantity,unit_price:p.sale_price,total:d.quantity*p.sale_price};
  }).filter(Boolean);
  const sum=()=>state.draft.reduce((n,d)=>{const p=state.products.find(p=>p.id===d.product_id);return n+(p?p.sale_price*d.quantity:0)},0);
  const syncSummary=()=>{
    const count=document.getElementById('prepare-count');
    const total=document.getElementById('prepare-total');
    if(count)count.textContent=number(state.draft.length)+' مادة';
    if(total)total.textContent=money(sum());
  };
  if(typeof window.Tabulator!=='function'){
    host.innerHTML='<p class="af-grid-error">تعذّر تحميل محرّك الجداول. أعد تشغيل الخادم وتأكد من تثبيت المكتبات المحلية.</p>';
    showToast('مكتبة الجداول غير متاحة. تأكد من تشغيل الخادم وملفات النظام.',true);
    return;
  }
  prepareTable=new window.Tabulator(host,{
    data:entries,index:'id',layout:'fitDataStretch',textDirection:'rtl',editTriggerEvent:'click',
    placeholder:'ماكو مواد بالقائمة. ابحث عن مادة وأضفها للجدول.',
    rowFormatter:()=>{queueMicrotask(()=>{void hydrateImages(host);});},
    columns:[
      {title:'ت',formatter:'rownum',width:51,hozAlign:'center',headerSort:false,resizable:false},
      {title:'الصورة',field:'image_url',width:84,headerSort:false,formatter(cell){return image(cell.getRow().getData(),'af-grid-photo')}},
      {title:'اسم المادة',field:'name',width:188,minWidth:170,formatter(cell){return '<strong class="af-grid-name">'+safe(cell.getValue())+'</strong>'}},
      {title:'الوصف',field:'description',width:200,minWidth:170,formatter(cell){return '<span class="af-grid-description">'+safe(cell.getValue()||'—')+'</span>'},variableHeight:true},
      {title:'الصنع',field:'manufacture',width:135,minWidth:110,formatter(cell){return safe(cell.getValue()||'—')}},
      {title:'العدد',field:'quantity',width:99,hozAlign:'center',editor:'number',editorParams:{min:1,max:100000000,step:1},validator:['integer','min:1','max:100000000'],formatter(cell){return '<span class="af-grid-editable">'+number(cell.getValue())+' '+icon('edit',13)+'</span>'}},
      {title:'سعر الوحدة',field:'unit_price',width:142,hozAlign:'left',formatter(cell){return '<span class="af-grid-currency">'+money(cell.getValue())+'</span>'}},
      {title:'الإجمالي',field:'total',width:152,hozAlign:'left',formatter(cell){return '<b class="af-grid-currency">'+money(cell.getValue())+'</b>'},bottomCalc:'sum',bottomCalcFormatter(cell){return '<strong class="af-grid-total">'+money(cell.getValue()||0)+'</strong>'}},
      {title:'حذف',width:71,hozAlign:'center',headerSort:false,formatter(cell){return '<button class="af-grid-remove" type="button" data-action="quote-remove" data-idx="'+cell.getRow().getData().idx+'" aria-label="حذف المادة">'+icon('x',17)+'</button>'}}
    ]
  });
  prepareTable.on('renderComplete',()=>{void hydrateImages(host)});
  prepareTable.on('tableBuilt',()=>{void hydrateImages(host)});
  prepareTable.on('cellEdited',cell=>{
    if(cell.getField()!=='quantity')return;
    const d=cell.getRow().getData(),n=Number(cell.getValue()),item=state.draft[d.idx];
    if(!item||!Number.isSafeInteger(n)||n<1||n>100000000){
      cell.restoreOldValue();
      showToast('أدخل عدداً صحيحاً من 1 إلى 100000000',true);
      return;
    }
    item.quantity=n;
    cell.getRow().update({total:n*d.unit_price});
    syncSummary();
  });
}

function renderWorkspace() {
  const w = document.getElementById('workspace');
  if (prepareTable) {prepareTable.destroy();prepareTable=null;}
  if (w) {w.innerHTML=workspaceView();void hydrateImages(w);if(state.section==='prepare')drawPreparedGrid();}
  document.querySelectorAll('.nav-link').forEach(el=>el.classList.toggle('active',el.dataset.section===state.section));
  const alertNode=document.querySelector('.top-alert span');
  if (alertNode) alertNode.textContent=number(state.alerts.length);
}
function render() {
  app.innerHTML=state.user?renderShell():loginView();
  if (state.user) { renderWorkspace(); renderModal(); }
}
function productModal(p) {
  return `<div class="modal-head"><div><p class="eyebrow">إدارة المواد</p><h2>${p?'تعديل المادة':'إضافة مادة جديدة'}</h2></div><button class="icon-btn" data-action="close-modal" aria-label="إغلاق">${icon('x')}</button></div>
    <form class="modal-form" data-form="product" data-id="${p?.id||''}">
      <div class="form-grid"><label>اسم المنتج *<input name="name" required maxlength="140" value="${safe(p?.name||'')}" placeholder="مثال: رول نايلون"></label><label>الصنع / المنشأ<input name="manufacture" maxlength="140" value="${safe(p?.manufacture||'')}" placeholder="بلد الصنع"></label></div>
      <label>وصف المنتج<textarea name="description" maxlength="1500" rows="2" placeholder="وصف مختصر للمنتج">${safe(p?.description||'')}</textarea></label>
      <div class="form-grid"><label>العدد المتوفر *<input type="number" name="quantity" min="0" step="1" required value="${p?.quantity??0}"></label><label>حد التنبيه *<input type="number" name="min_quantity" min="0" step="1" required value="${p?.min_quantity??5}"></label></div>
      <div class="form-grid"><label>سعر الشراء (د.ع) *<input type="number" name="purchase_price" min="0" step="1" required value="${p?.purchase_price??0}"></label><label>سعر البيع (د.ع) *<input type="number" name="sale_price" min="0" step="1" required value="${p?.sale_price??0}"></label></div>
      <label>صورة المنتج <span class="field-note">اختياري — JPG / PNG / WebP بحد أقصى 3 ميغابايت</span><input name="image" type="file" accept="image/jpeg,image/png,image/webp"></label>
      ${p?.image_url?`<div class="image-current">${image(p)}<small>الصورة الحالية (تُستبدل عند رفع صورة جديدة)</small></div>`:''}
      <div class="modal-actions"><button type="button" class="btn quiet" data-action="close-modal">إلغاء</button><button type="submit" class="btn primary">${icon('save',17)} حفظ المادة</button></div>
    </form>`;
}
function stockModal(p) {
  return `<div class="modal-head"><h2>تحديث الجرد</h2><button class="icon-btn" data-action="close-modal">${icon('x')}</button></div>
    <p class="muted">${safe(p.name)}</p><form data-form="stock" data-id="${p.id}" class="modal-form"><label>العدد الفعلي الموجود<input name="quantity" required type="number" step="1" min="0" value="${p.quantity}"></label><div class="modal-actions"><button type="button" class="btn quiet" data-action="close-modal">إلغاء</button><button type="submit" class="btn primary">حفظ الجرد</button></div></form>`;
}
function userModal(u) {
  return `<div class="modal-head"><div><p class="eyebrow">إدارة الصلاحيات</p><h2>${u?'تعديل صلاحيات المستخدم':'إضافة المستخدم الثاني'}</h2></div><button class="icon-btn" data-action="close-modal">${icon('x')}</button></div>
    <form data-form="user" data-id="${u?.id||''}" class="modal-form">
      <div class="form-grid"><label>اسم الشخص *<input name="full_name" required minlength="2" maxlength="120" value="${safe(u?.full_name||'')}"></label>
      <label>اسم الدخول (إنجليزي) *<input name="username" required pattern="[a-zA-Z0-9_.-]{3,60}" value="${safe(u?.username||'')}" placeholder="employee" dir="ltr"></label></div>
      <label>${u?'كلمة مرور جديدة (اختياري)':'كلمة المرور *'}<input name="password" type="password" minlength="10" maxlength="128" ${u?'':'required'} placeholder="10 رموز على الأقل" autocomplete="new-password"></label>
      <div class="switch-block"><label class="switch-line"><span><b>إظهار سعر الشراء</b><small>يسمح بعرض تكلفة شراء المنتجات</small></span><input type="checkbox" name="can_view_purchase" ${u?.can_view_purchase?'checked':''}></label>
      <label class="switch-line"><span><b>إظهار سعر البيع</b><small>يسمح بعرض سعر بيع المنتجات</small></span><input type="checkbox" name="can_view_sale" ${u?.can_view_sale?'checked':''}></label>
      ${u?`<label class="switch-line"><span><b>الحساب مفعل</b><small>إيقاف الحساب يمنع تسجيل الدخول</small></span><input type="checkbox" name="is_active" ${u.is_active?'checked':''}></label>`:''}</div>
      <div class="modal-actions"><button type="button" class="btn quiet" data-action="close-modal">إلغاء</button><button type="submit" class="btn primary">${icon('shield',18)} حفظ الصلاحيات</button></div>
    </form>`;
}
function renderModal() {
  const layer=document.getElementById('modal-layer');
  if (!layer) return;
  if (!state.modal) {layer.innerHTML='';return;}
  const {type,id}=state.modal;
  let content='';
  if (type==='product') content=productModal(state.products.find(p=>p.id===id));
  if (type==='stock') content=stockModal(state.products.find(p=>p.id===id));
  if (type==='user') content=userModal(state.users.find(u=>u.id===id));
  layer.innerHTML=`<div class="af-modal-backdrop" data-action="backdrop"><section class="af-dialog" role="dialog" aria-modal="true">${content}</section></div>`;
  void hydrateImages(layer);
  document.querySelector('.af-dialog input:not([disabled])')?.focus();
}
function closeModal() {state.modal=null;renderModal();}
async function syncAndShow(message) {
  await refresh(); closeModal(); renderWorkspace(); showToast(message);
}
async function backendAvailable() {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8000);
  try {
    const response=await fetch('/api/health',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if (!response.ok) return false;
    const data=await response.json();
    return data?.status==='ok';
  } catch {return false;}
  finally {clearTimeout(timeout);}
}
async function handleForm(form) {
  const type=form.dataset.form;
  const fields=new FormData(form);
  const submit=form.querySelector('button[type="submit"]');
  if (submit) submit.disabled=true;
  if (type==='login') {
    const feedback=form.querySelector('#login-feedback');
    if (feedback) { feedback.hidden=true; feedback.textContent=''; }
    if (submit) { submit.dataset.originalLabel=submit.innerHTML; submit.textContent='جارٍ التحقق من الدخول...'; submit.setAttribute('aria-busy','true'); }
  }
  try {
    if (type==='login') {
      if (!(await backendAvailable())) {
        throw new Error('الخادم غير متصل. إذا فتحت الواجهة من Google AI Studio، تأكد من تشغيل Backend ومزامنة ملفات GitHub. المشكلة ليست بالضرورة في كلمة المرور.');
      }
      const result=await api('/admin/auth/login',{method:'POST',data:{username:String(fields.get('username')).trim(),password:String(fields.get('password'))}});
      if (!result?.user || !result?.csrf) throw new Error('الخادم لم يرجع بيانات دخول صالحة. تأكد من تشغيل خادم النظام، وليس صفحة المعاينة وحدها.');
      if (result.user.role !== 'admin') {
        await api('/auth/logout',{method:'POST'}).catch(()=>{});
        throw new Error('هذه لوحة الإدارة فقط. افتح واجهة الموظفين من الصفحة الرئيسية.');
      }
      setAccessToken(result.access_token);
      state.user=result.user;setCsrf(result.csrf);state.section='home';state.sidebarOpen=window.innerWidth >= 950;
      try {await refresh();}
      catch (loadError) {
        if (loadError?.status===401) throw new Error('تم قبول بيانات الدخول لكن تعذّر تثبيت الجلسة في المعاينة. تأكد من تحديث الخادم مع ملفات الواجهة.');
        throw loadError;
      }
      render();return;
    }
    if (type==='recovery') {
      const desired=String(fields.get('new_password')||'');
      if(desired!==String(fields.get('confirm_password')||''))throw new Error('تأكيد كلمة المرور مختلف');
      const result=await api('/admin/recover',{method:'POST',data:{
        recovery_code:String(fields.get('recovery_code')||''),
        username:String(fields.get('username')||'').trim(),
        new_password:desired,
      }});
      setAccessToken(result.access_token);setCsrf(result.csrf);
      state.user=result.user;state.showRecovery=false;state.section='account';
      await refresh();render();showToast('تم استعادة حساب الإدارة وتعيين بيانات الدخول التي اخترتها');
      return;
    }
    if (type==='account') {
      const password=String(fields.get('new_password')||'');
      if(password!==String(fields.get('confirm_password')||''))throw new Error('تأكيد كلمة المرور مختلف');
      const data={
        username:String(fields.get('username')||'').trim(),
        current_password:String(fields.get('current_password')||''),
      };
      if(password)data.new_password=password;
      const result=await api('/auth/change-credentials',{method:'POST',data});
      state.user=result.user;renderWorkspace();
      showToast('تم حفظ بيانات الدخول الجديدة');
      return;
    }
    if (type==='product') {
      const values={name:String(fields.get('name')||''),description:String(fields.get('description')||''),manufacture:String(fields.get('manufacture')||'')};
      for (const field of ['quantity','min_quantity','purchase_price','sale_price']) values[field]=Number(fields.get(field));
      const id=Number(form.dataset.id||0);
      const p=await api(id?`/products/${id}`:'/products',{method:id?'PUT':'POST',data:values});
      const file=fields.get('image');
      if (file instanceof File && file.size) {
        if (file.size>3*1024*1024) { await syncAndShow('تم حفظ المادة، لكن حجم الصورة أكبر من المسموح');return; }
        const formFile=new FormData();formFile.set('file',file);
        try {await api(`/products/${p.id}/image`,{method:'POST',file:formFile});}
        catch(err) {await syncAndShow('تم حفظ المادة، لكن تعذّر رفع الصورة: '+err.message);return;}
      }
      await syncAndShow('تم حفظ المادة بنجاح');
    }
    if (type==='stock') {
      await api(`/products/${Number(form.dataset.id)}/stock`,{method:'PATCH',data:{quantity:Number(fields.get('quantity'))}});
      await syncAndShow('تم تحديث الجرد');
    }
    if (type==='user') {
      const id=Number(form.dataset.id||0);
      const data={full_name:String(fields.get('full_name')||''),can_view_purchase:fields.has('can_view_purchase'),can_view_sale:fields.has('can_view_sale')};
      const pwd=String(fields.get('password')||'');
      if (pwd) data.password=pwd;
      data.username=String(fields.get('username')||'').trim();
      if (id) data.is_active=fields.has('is_active');
      await api(id?`/users/${id}`:'/users',{method:id?'PATCH':'POST',data});
      await syncAndShow('تم حفظ المستخدم والصلاحيات');
    }
  } catch(err) {
    if (type==='login') {
      showLoginError(err instanceof TypeError ? 'تعذّر الاتصال بخادم النظام. تأكد من أن الخادم شغّال وأن المعاينة مرتبطة به.' : (err?.message || 'تعذّر تسجيل الدخول، حاول مرة ثانية.'));
    } else if(type==='recovery') {
      const feedback=form.querySelector('#recovery-feedback');
      if(feedback){feedback.textContent=err?.message||'تعذّرت استعادة الحساب';feedback.hidden=false;}
    } else errorToast(err);
  } finally {
    if (submit) {
      submit.disabled=false;
      if (type==='login') {submit.innerHTML=submit.dataset.originalLabel||'تسجيل الدخول';submit.removeAttribute('aria-busy');}
    }
  }
}
async function printQuote(q) {
  if (!q) return;
  printRoot.innerHTML=`<div class="print-sheet"><header class="print-header"><div><h1>شركة أفراح الوطن للتجارة العامة</h1><p>عرض أسعار رقم ${number(q.id)} — ${new Date(q.date).toLocaleDateString('ar-IQ')}</p></div><img src="/assets/tapello.svg?v=20261105-pdf-logo" alt="Tapello"></header>
  <table><thead><tr><th>الصورة</th><th>اسم المنتج ووصفه</th><th>الصنع</th><th>العدد</th><th>سعر المنتج</th><th>المجموع</th></tr></thead><tbody>
  ${q.items.map(row=>`<tr><td>${row.image_url?`<img class="print-photo" data-private-image="${safe(row.image_url)}" alt="صورة المنتج">`:'—'}</td><td><strong>${safe(row.product_name)}</strong><small>${safe(row.description)}</small></td><td>${safe(row.manufacture)}</td><td>${number(row.quantity)}</td><td>${money(row.unit_price)}</td><td>${money(row.total)}</td></tr>`).join('')}
  </tbody></table><footer>المجموع الكلي: <strong>${money(q.total)}</strong></footer></div>`;
  await hydrateImages(printRoot);
  await Promise.all(Array.from(printRoot.querySelectorAll('img')).map(img=>img.decode?.().catch(()=>{})||Promise.resolve()));
  document.body.classList.add('printing');
  window.print();
  setTimeout(()=>document.body.classList.remove('printing'),1000);
}
window.addEventListener('afterprint',()=>document.body.classList.remove('printing'));

async function handleAction(action, el) {
  switch(action) {
    case 'nav': {
      const section=el.dataset.section;
      if (!isAdmin()&&['users','quotes','prepare'].includes(section)) return;
      state.section=section;state.selectedQuote=null;
      if (window.innerWidth<950) {state.sidebarOpen=false;document.getElementById('sidebar')?.classList.add('collapsed');document.querySelector('.mobile-scrim')?.classList.remove('show');}
      renderWorkspace();window.scrollTo(0,0);return;
    }
    case 'toggle-sidebar':
      state.sidebarOpen=!state.sidebarOpen;
      document.getElementById('sidebar')?.classList.toggle('collapsed',!state.sidebarOpen);
      document.querySelector('.shell')?.classList.toggle('sidebar-narrow',!state.sidebarOpen);
      document.querySelector('.mobile-scrim')?.classList.toggle('show',state.sidebarOpen);return;
    case 'recovery-toggle': state.showRecovery=!state.showRecovery;render();return;
    case 'switch-staff': await switchPortal(api,'/');return;
    case 'logout':
      try {await api('/auth/logout',{method:'POST'});} catch(err) {errorToast(err);}
      state.user=null;setCsrf(null);setAccessToken(null);forgetPrivateImages();state.draft=[];render();return;
    case 'new-product': state.modal={type:'product',id:0};renderModal();return;
    case 'edit-product': state.modal={type:'product',id:Number(el.dataset.id)};renderModal();return;
    case 'count': state.modal={type:'stock',id:Number(el.dataset.id)};renderModal();return;
    case 'new-user': state.modal={type:'user',id:0};renderModal();return;
    case 'edit-user': state.modal={type:'user',id:Number(el.dataset.id)};renderModal();return;
    case 'close-modal': closeModal();return;
    case 'backdrop': closeModal();return;
    case 'delete-product': {
      const id=Number(el.dataset.id);
      if (!confirm('تأكيد حذف المادة؟ ستبقى عروض الأسعار المحفوظة كما كانت.')) return;
      try {await api(`/products/${id}`,{method:'DELETE'});await syncAndShow('تم حذف المادة');}catch(err){errorToast(err);}return;
    }
    case 'quote-add-item': {
      if (!isAdmin()) return;
      const id=Number(el.dataset.id);
      const p=state.products.find(p=>p.id===id);
      if (!p) {showToast('المادة غير موجودة',true);return;}
      const existing=state.draft.find(item=>item.product_id===id);
      if (existing) {
        if (existing.quantity>=100000000) {showToast('بلغ العدد الحد المسموح',true);return;}
        existing.quantity+=1;
      } else state.draft.push({product_id:id,quantity:1});
      state.quoteSearch='';state.homeSearch='';state.section='prepare';state.selectedQuote=null;
      renderWorkspace();
      document.getElementById('quote-search')?.focus();
      showToast('تمت إضافة المادة إلى نفس الوصل');
      return;
    }
    case 'quote-increase':
    case 'quote-decrease': {
      const idx=Number(el.dataset.idx);
      const row=state.draft[idx];
      if (!row) return;
      const delta=action==='quote-increase'?1:-1;
      row.quantity=Math.min(100000000,Math.max(1,row.quantity+delta));
      renderWorkspace();return;
    }
    case 'quote-add': {
      const id=Number(document.getElementById('quote-product')?.value);
      const qty=Number(document.getElementById('quote-qty')?.value);
      if (!id||!Number.isSafeInteger(qty)||qty<1||qty>100000000) {showToast('اختر مادة وأدخل عدداً صحيحاً',true);return;}
      const found=state.draft.find(i=>i.product_id===id);
      if (found) found.quantity+=qty; else state.draft.push({product_id:id,quantity:qty});
      renderWorkspace();return;
    }
    case 'quote-remove': state.draft.splice(Number(el.dataset.idx),1);renderWorkspace();return;
    case 'quote-create': {
      if (!state.draft.length) return;
      try {
        const q=await api('/quotes',{method:'POST',data:{items:state.draft}});
        state.selectedQuote=q;state.draft=[];state.quoteSearch='';state.section='quotes';await refresh();renderWorkspace();showToast('تم حفظ عرض الأسعار');
        document.querySelector('.quote-preview')?.scrollIntoView({behavior:'smooth'});
      } catch(err){errorToast(err);}return;
    }
    case 'quote-open': {
      try { state.selectedQuote=await api(`/quotes/${Number(el.dataset.id)}`);renderWorkspace();document.querySelector('.quote-preview')?.scrollIntoView({behavior:'smooth'});}
      catch(err){errorToast(err);}return;
    }
    case 'quote-print': await printQuote(state.selectedQuote);return;
  }
}
document.addEventListener('click',async(e)=>{
  const btn=e.target.closest('[data-action]');if (!btn) return;
  if (btn.dataset.action==='backdrop' && e.target!==btn) return;
  try {await handleAction(btn.dataset.action,btn);}catch(err){errorToast(err);}
});
document.addEventListener('submit',async(e)=>{
  const form=e.target.closest('form[data-form]');if (!form) return;
  e.preventDefault();await handleForm(form);
});
document.addEventListener('input',(e)=>{
  if (e.target.id==='home-search') {
    state.homeSearch=e.target.value;
    const results=document.getElementById('home-search-results');
    if (results) {results.innerHTML=searchableProductList(state.homeSearch,'home');void hydrateImages(results);}
    return;
  }
  if (e.target.id==='quote-search') {
    state.quoteSearch=e.target.value;
    const results=document.getElementById('quote-search-results');
    if (results) results.innerHTML=state.quoteSearch.trim()?
      searchableProductList(state.quoteSearch,'quote'):
      '<p class="af-search-hint">اكتب اسم المادة، ثم اضغط «إضافة للقائمة».</p>';
    if (results) void hydrateImages(results);
    return;
  }
  if (e.target.id==='products-search') {
    const cursor=e.target.selectionStart;
    state.search=e.target.value;
    renderWorkspace();
    const field=document.getElementById('products-search');
    field?.focus();
    if (cursor!==null) field?.setSelectionRange(cursor,cursor);
    return;
  }
});
document.addEventListener('change',(e)=>{
  const input=e.target.closest('.af-qty-input');
  if (!input) return;
  const idx=Number(input.dataset.idx),row=state.draft[idx],qty=Number(input.value);
  if (!row) return;
  if(!Number.isSafeInteger(qty)||qty<1||qty>100000000) {
    input.value=String(row.quantity);
    showToast('أدخل عدداً صحيحاً بين 1 و100000000',true);
    return;
  }
  row.quantity=qty;
  renderWorkspace();
});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape'&&state.modal)closeModal();});
boot();
