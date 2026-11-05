import {api, setCsrf, money, number, safe} from './api.js';
import {icon} from './icons.js?v=20261105-ui3';

const state = {
  user:null, section:'home', products:[], alerts:[], users:[], quotes:[],
  search:'', sidebarOpen:true, modal:null, draft:[], selectedQuote:null, loading:false,
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
  return product.image_url ? `<img class="${cssClass}" src="${safe(product.image_url)}" alt="صورة ${safe(product.name||product.product_name)}" loading="lazy">` : placeholder();
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
  if (err?.status === 401) { state.user=null; setCsrf(null); render(); return; }
  showToast(err?.message || 'تعذر تنفيذ الطلب', true);
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
    const res = await api('/me');
    state.user = res.user;
    state.sidebarOpen = window.innerWidth >= 950;
    setCsrf(res.csrf);
    await refresh();
  } catch { state.user=null; setCsrf(null); }
  render();
}
function loginView() {
  return `<div class="auth-page">
    <section class="auth-visual" aria-hidden="true"><div class="auth-halo"></div><div class="auth-brand">أفراح الوطن<small>للتجارة العامة</small></div><img src="/assets/tapello.svg?v=20261105-pdf-logo" alt="" class="auth-logo"><div class="auth-caption">نظام المواد والجرد وعروض الأسعار</div></section>
    <section class="auth-content"><div class="auth-box">
      
      <h1>يا هلا ومرحبا</h1><p class="muted">سجّل دخولك للوصول إلى نظام أفراح الوطن</p>
      <form data-form="login" class="stack-form">
        <label>اسم المستخدم<input name="username" required autocomplete="username" maxlength="60" placeholder="اسم المستخدم" dir="ltr"></label>
        <label>كلمة المرور<input name="password" type="password" required autocomplete="current-password" placeholder="كلمة المرور" dir="ltr"></label>
        <button type="submit" class="btn primary full">${icon('arrow',18)} تسجيل الدخول</button>
      </form>
    </div></section></div><div id="toast" class="toast" role="status"></div>`;
}
const navItems = [
  ['home','الرئيسية','home'], ['products','المواد','package'], ['inventory','الجرد','clipboard'],
  ['alerts','التنبيهات','bell'], ['quotes','عروض الأسعار','file'], ['users','المستخدمون','users'],
];
function renderShell() {
  const nav = navItems.filter(([key])=> isAdmin() || !['quotes','users'].includes(key));
  return `<div class="shell ${state.sidebarOpen?'':'sidebar-narrow'}">
    <aside class="sidebar ${state.sidebarOpen?'':'collapsed'}" id="sidebar">
      <div class="sidebar-head"><span class="brand-square">${icon('package',25)}</span><span class="sidebar-titles"><strong>أفراح الوطن</strong><small>للتجارة العامة</small></span></div>
      <div class="sidebar-divider"></div><p class="menu-caption">القائمة الرئيسية</p>
      <nav aria-label="التنقل الرئيسي">${nav.map(([key,title,glyph])=>`<button type="button" class="nav-link ${state.section===key?'active':''}" data-action="nav" data-section="${key}" title="${title}"><span class="nav-icon nav-icon-${key}">${icon(glyph,20)}</span><span>${title}</span>${key==='alerts'&&state.alerts.length?`<b class="nav-count">${state.alerts.length}</b>`:''}</button>`).join('')}</nav>
      <div class="sidebar-bottom"><span>شركة أفراح الوطن للتجارة العامة</span></div>
    </aside>
    <div class="mobile-scrim ${state.sidebarOpen?'show':''}" data-action="toggle-sidebar"></div>
    <div class="main-shell">
      <header class="topbar">
        <button type="button" class="icon-btn sidebar-toggle" data-action="toggle-sidebar" aria-label="فتح وإغلاق القائمة">${icon('menu',22)}</button>
        <div class="top-identity"><strong>شركة أفراح الوطن</strong><span>للتجارة العامة</span></div>
        <label class="search-field">${icon('search',20)}<input id="global-search" aria-label="البحث عن مادة" placeholder="ابحث عن مادة أو وصف..." value="${safe(state.search)}" autocomplete="off"></label>
        <button type="button" data-action="nav" data-section="alerts" class="top-alert" title="تنبيهات المخزون">${icon('bell',20)}${state.alerts.length?`<span>${number(state.alerts.length)}</span>`:''}</button>
        <div class="user-badge"><div class="user-circle">${icon('users',18)}</div><div class="user-detail"><strong>${safe(state.user.full_name)}</strong><small>${isAdmin()?'الإدارة':'المستخدم الثاني'}</small></div></div>
        <button type="button" class="icon-btn logout" data-action="logout" title="تسجيل خروج">${icon('logout',20)}</button>
      </header>
      <main id="workspace" class="workspace"></main>
      <footer class="footer">شركة أفراح الوطن للتجارة العامة <span>•</span> نظام إدارة المواد</footer>
    </div>
  </div><div id="modal-layer"></div><div id="toast" class="toast" role="status"></div>`;
}
function pageTitle(title, subtitle, buttons='') {
  return `<div class="page-title"><div><div class="eyebrow">شركة أفراح الوطن للتجارة العامة</div><h1>${title}</h1><p>${subtitle}</p></div><div class="page-buttons">${buttons}</div></div>`;
}
function primaryButton(action, label, plus=true) { return `<button type="button" class="btn primary" data-action="${action}">${icon(plus?'plus':'check',18)} ${label}</button>`; }
function homeView() {
  const total = state.products.reduce((n,p)=>n+p.quantity,0);
  return `${pageTitle('الرئيسية','مساحة عمل المواد والتجهيزات')}
  <section class="hero">
    <div class="hero-ring one"></div><div class="hero-ring two"></div>
    <span class="hero-kicker">أهلاً بك في نظام شركتنا</span>
    <h2>يــا هـلا و مـرحـبـا</h2><div class="hero-divider"><i></i></div>
    <p>شركة أفراح الوطن للتجارة العامة</p><img src="/assets/tapello.svg?v=20261105-pdf-logo" alt="Tapello" class="hero-logo">
  </section>
  <div class="stat-grid">
    <button type="button" class="stat-card" data-action="nav" data-section="products"><span class="stat-icon blue">${icon('package',24)}</span><div><small>المواد المسجّلة</small><strong>${number(state.products.length)}</strong></div>${icon('arrow',18)}</button>
    <button type="button" class="stat-card" data-action="nav" data-section="inventory"><span class="stat-icon teal">${icon('clipboard',24)}</span><div><small>مجموع القطع المتوفرة</small><strong>${number(total)}</strong></div>${icon('arrow',18)}</button>
    <button type="button" class="stat-card" data-action="nav" data-section="alerts"><span class="stat-icon amber">${icon('alert',24)}</span><div><small>مواد تحتاج انتباهاً</small><strong>${number(state.alerts.length)}</strong></div>${icon('arrow',18)}</button>
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
  const q = state.search.trim().toLowerCase();
  const rows = q?state.products.filter(p=>(p.name+' '+p.description+' '+p.manufacture).toLowerCase().includes(q)):state.products;
  return `${pageTitle('المواد','إدارة مواد تجهيز المطاعم وأسعارها وصورها.',isAdmin()?primaryButton('new-product','إضافة مادة'): '')}
    <section class="panel"><div class="panel-head"><h2>المواد المسجّلة</h2><span class="count-label">${number(rows.length)} مادة</span></div>${productTable(rows)}</section>`;
}
function inventoryView() {
  return `${pageTitle('الجرد','متابعة العدد الفعلي لكل مادة وحدّ التنبيه عند النقص.')}
    <section class="panel"><div class="panel-head"><h2>الكميات الحالية</h2><span class="count-label">${number(state.products.length)} مادة</span></div>${productTable(state.products,true)}</section>`;
}
function alertsView() {
  return `${pageTitle('التنبيهات','المواد التي وصلت إلى الحد الأدنى أو نفدت من المخزون.')}
    <section class="panel"><div class="panel-head"><h2>تنبيهات المخزون</h2><span class="count-label">${number(state.alerts.length)} تنبيه</span></div>
      ${!state.alerts.length?emptyState('المخزون بحالة جيدة','لا توجد مواد وصلت إلى حد التنبيه.','check'):
      `<div class="alert-list">${state.alerts.map(a=>`<div class="alert-line"><span class="alert-badge">${icon('alert',21)}</span><div><strong>${safe(a.name)}</strong><small>${a.quantity===0?'نفدت المادة':'اقتربت من النفاد'} — المتوفر: ${number(a.quantity)} / حد التنبيه: ${number(a.min_quantity)}</small></div>${isAdmin()?`<button class="btn quiet small" data-action="count" data-id="${a.product_id}">تعديل العدد ${icon('arrow',16)}</button>`:''}</div>`).join('')}</div>`}
    </section>`;
}
function emptyState(head,sub,glyph) { return `<div class="empty">${icon(glyph,32)}<h3>${head}</h3><p>${sub}</p></div>`; }
function usersView() {
  if (!isAdmin()) return '';
  return `${pageTitle('المستخدمون','حساب الإدارة والتحكم بصلاحيات الاطلاع على الأسعار.',primaryButton('new-user','إضافة مستخدم'))}
    <div class="user-cards">${state.users.map(u=>`<section class="user-card panel"><div class="user-avatar">${icon(u.role==='admin'?'user-check':'users',26)}</div><div class="user-info"><h3>${safe(u.full_name)}</h3><p dir="ltr">${safe(u.username)}</p><span class="chip ${u.is_active?'success':'danger'}">${u.role==='admin'?'الإدارة':u.is_active?'مستخدم مفعّل':'الحساب معطّل'}</span></div>
      <div class="permission-list"><div>عرض سعر الشراء <b class="${u.can_view_purchase?'allowed':'forbidden'}">${u.can_view_purchase?'مسموح':'ممنوع'}</b></div><div>عرض سعر البيع <b class="${u.can_view_sale?'allowed':'forbidden'}">${u.can_view_sale?'مسموح':'ممنوع'}</b></div></div>
      ${u.role==='staff'?`<button type="button" class="btn quiet small" data-action="edit-user" data-id="${u.id}">${icon('edit',16)} ضبط الصلاحيات</button>`:''}</section>`).join('')}</div>`;
}
function quotesView() {
  if (!isAdmin()) return '';
  return `${pageTitle('عروض الأسعار','عروض تتضمن صورة المنتج، الاسم، الوصف، العدد، الصنع والسعر.')}
    <div class="quotes-grid"><section class="panel quote-builder"><div class="panel-head"><h2>إنشاء عرض أسعار</h2></div>
      <div class="quote-inputs"><label>المادة<select id="quote-product"><option value="">اختر المادة</option>${state.products.map(p=>`<option value="${p.id}">${safe(p.name)}</option>`).join('')}</select></label><label>العدد<input id="quote-qty" type="number" min="1" step="1" value="1"></label><button class="btn secondary" data-action="quote-add">${icon('plus',17)} إضافة للعرض</button></div>
      <div class="draft-items">${state.draft.length?state.draft.map((item,idx)=>{const p=state.products.find(p=>p.id===item.product_id);return !p?'':`<div class="draft-line">${image(p)}<div><b>${safe(p.name)}</b><small>${number(item.quantity)} × ${money(p.sale_price)}</small></div><button class="tiny-btn red" data-action="quote-remove" data-idx="${idx}" title="حذف">${icon('x',17)}</button></div>`;}).join(''):emptyState('لم تُضف مواد بعد','اختر المادة والعدد لإعداد العرض.','file')}</div>
      <button class="btn primary full" data-action="quote-create" ${!state.draft.length?'disabled':''}>${icon('save',17)} حفظ عرض الأسعار</button>
    </section>
    <section class="panel quotes-history"><div class="panel-head"><h2>عروض الأسعار المحفوظة</h2><span class="count-label">${number(state.quotes.length)} عرض</span></div>
      ${state.quotes.length?state.quotes.map(q=>`<button class="history-item" data-action="quote-open" data-id="${q.id}"><span class="history-icon">${icon('file',22)}</span><span><b>عرض رقم ${number(q.id)}</b><small>${new Date(q.date).toLocaleDateString('ar-IQ')} • ${q.items.length} مادة</small></span><strong>${money(q.total)}</strong>${icon('arrow',16)}</button>`).join(''):emptyState('لا توجد عروض محفوظة','احفظ أول عرض ليظهر هنا.','file')}
    </section></div>${state.selectedQuote?quotePreview(state.selectedQuote):''}`;
}
function quotePreview(q) {
  return `<section class="panel quote-preview"><div class="panel-head"><h2>عرض أسعار رقم ${number(q.id)}</h2><button class="btn secondary" data-action="quote-print">${icon('printer',18)} طباعة / حفظ PDF</button></div>
    <div class="quote-meta"><b>شركة أفراح الوطن للتجارة العامة</b><span>التاريخ: ${new Date(q.date).toLocaleDateString('ar-IQ')}</span></div>
    <div class="table-wrap"><table class="data-table quote-table"><thead><tr><th>الصورة</th><th>المادة والوصف</th><th>الصنع</th><th>العدد</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>
    ${q.items.map(i=>`<tr><td>${image({...i,name:i.product_name})}</td><td><b>${safe(i.product_name)}</b><small class="subtext">${safe(i.description)}</small></td><td>${safe(i.manufacture||'—')}</td><td>${number(i.quantity)}</td><td>${money(i.unit_price)}</td><td class="strong">${money(i.total)}</td></tr>`).join('')}
    </tbody></table></div><div class="quote-sum">المجموع الكلي <strong>${money(q.total)}</strong></div></section>`;
}
function workspaceView() {
  return ({home:homeView,products:productsView,inventory:inventoryView,alerts:alertsView,quotes:quotesView,users:usersView}[state.section] || homeView)();
}
function renderWorkspace() {
  const w = document.getElementById('workspace');
  if (w) w.innerHTML=workspaceView();
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
      ${u?`<label>اسم الدخول<input disabled value="${safe(u.username)}"></label>`:`<label>اسم الدخول (إنجليزي) *<input name="username" required pattern="[a-zA-Z0-9_.-]{3,60}" placeholder="employee" dir="ltr"></label>`}</div>
      <label>${u?'كلمة مرور جديدة (اختياري)':'كلمة المرور *'}<input name="password" type="password" minlength="6" maxlength="256" ${u?'':'required'} placeholder="6 رموز على الأقل" autocomplete="new-password"></label>
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
  layer.innerHTML=`<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true">${content}</section></div>`;
  document.querySelector('.modal input:not([disabled])')?.focus();
}
function closeModal() {state.modal=null;renderModal();}
async function syncAndShow(message) {
  await refresh(); closeModal(); renderWorkspace(); showToast(message);
}
async function handleForm(form) {
  const type=form.dataset.form;
  const fields=new FormData(form);
  const submit=form.querySelector('button[type="submit"]');
  if (submit) submit.disabled=true;
  try {
    if (type==='login') {
      const result=await api('/auth/login',{method:'POST',data:{username:String(fields.get('username')).trim(),password:String(fields.get('password'))}});
      state.user=result.user;setCsrf(result.csrf);state.section='home';state.sidebarOpen=window.innerWidth >= 950;await refresh();render();return;
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
      if (!id) data.username=String(fields.get('username')||'');
      if (id) data.is_active=fields.has('is_active');
      await api(id?`/users/${id}`:'/users',{method:id?'PATCH':'POST',data});
      await syncAndShow('تم حفظ المستخدم والصلاحيات');
    }
  } catch(err) {errorToast(err);} finally { if (submit) submit.disabled=false; }
}
function printQuote(q) {
  if (!q) return;
  printRoot.innerHTML=`<div class="print-sheet"><header class="print-header"><div><h1>شركة أفراح الوطن للتجارة العامة</h1><p>عرض أسعار رقم ${number(q.id)} — ${new Date(q.date).toLocaleDateString('ar-IQ')}</p></div><img src="/assets/tapello.svg?v=20261105-pdf-logo" alt="Tapello"></header>
  <table><thead><tr><th>الصورة</th><th>اسم المنتج ووصفه</th><th>الصنع</th><th>العدد</th><th>سعر المنتج</th><th>المجموع</th></tr></thead><tbody>
  ${q.items.map(row=>`<tr><td>${row.image_url?`<img class="print-photo" src="${safe(row.image_url)}">`:'—'}</td><td><strong>${safe(row.product_name)}</strong><small>${safe(row.description)}</small></td><td>${safe(row.manufacture)}</td><td>${number(row.quantity)}</td><td>${money(row.unit_price)}</td><td>${money(row.total)}</td></tr>`).join('')}
  </tbody></table><footer>المجموع الكلي: <strong>${money(q.total)}</strong></footer></div>`;
  document.body.classList.add('printing');
  window.print();
  setTimeout(()=>document.body.classList.remove('printing'),1000);
}
window.addEventListener('afterprint',()=>document.body.classList.remove('printing'));

async function handleAction(action, el) {
  switch(action) {
    case 'nav': {
      const section=el.dataset.section;
      if (!isAdmin()&&['users','quotes'].includes(section)) return;
      state.section=section;state.selectedQuote=null;
      if (window.innerWidth<950) {state.sidebarOpen=false;document.getElementById('sidebar')?.classList.add('collapsed');document.querySelector('.mobile-scrim')?.classList.remove('show');}
      renderWorkspace();window.scrollTo(0,0);return;
    }
    case 'toggle-sidebar':
      state.sidebarOpen=!state.sidebarOpen;
      document.getElementById('sidebar')?.classList.toggle('collapsed',!state.sidebarOpen);
      document.querySelector('.shell')?.classList.toggle('sidebar-narrow',!state.sidebarOpen);
      document.querySelector('.mobile-scrim')?.classList.toggle('show',state.sidebarOpen);return;
    case 'logout':
      try {await api('/auth/logout',{method:'POST'});} catch(err) {errorToast(err);}
      state.user=null;setCsrf(null);state.draft=[];render();return;
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
        state.selectedQuote=q;state.draft=[];await refresh();renderWorkspace();showToast('تم حفظ عرض الأسعار');
        document.querySelector('.quote-preview')?.scrollIntoView({behavior:'smooth'});
      } catch(err){errorToast(err);}return;
    }
    case 'quote-open': {
      try { state.selectedQuote=await api(`/quotes/${Number(el.dataset.id)}`);renderWorkspace();document.querySelector('.quote-preview')?.scrollIntoView({behavior:'smooth'});}
      catch(err){errorToast(err);}return;
    }
    case 'quote-print': printQuote(state.selectedQuote);return;
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
  if(e.target.id==='global-search') {
    state.search=e.target.value;
    if(state.section!=='products') state.section='products';
    renderWorkspace();
  }
});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape'&&state.modal)closeModal();});
boot();
