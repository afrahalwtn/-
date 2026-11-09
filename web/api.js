// Access to protected resources goes through this single same-origin API client.
// Session cookies are HttpOnly and never read or stored in JavaScript.
let csrfToken = null;
let accessToken = null;
export function setCsrf(token) { csrfToken = token || null; }
// Ephemeral session token: never store it in localStorage, sessionStorage or URL.
export function setAccessToken(token) {
  accessToken = typeof token === 'string' && /^[A-Za-z0-9_-]{48}$/.test(token) ? token : null;
}
export async function api(path, {method='GET', data, file} = {}) {
  const headers = {};
  if (accessToken && path !== '/auth/login') headers['Authorization'] = 'Bearer ' + accessToken;
  // A stuck GET must never freeze the UI indefinitely; do not automatically
  // retry mutations because the server may already have committed the write.
  const options = {method, credentials:'same-origin', cache:'no-store', headers,
    signal:AbortSignal.timeout(method==='GET'?30000:90000)};
  if (method !== 'GET') {
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (file) options.body = file;
    else if (data !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    }
  }
  let res;
  try {res=await fetch('/api' + path, options);}
  catch(error){
    if(method==='GET' && (error?.name==='TimeoutError'||error?.name==='AbortError'))
      throw new Error('انتهت مهلة طلب البيانات؛ تحقق من الاتصال وحاول تحديث الصفحة.');
    if(method!=='GET')
      throw new Error('تعذّر تأكيد نتيجة الحفظ؛ افحص البيانات قبل إعادة إرسال العملية.');
    throw new Error('تعذّر الاتصال بالخادم. تحقق من الشبكة.');
  }
  let body;
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) {
    let message = typeof body.detail === 'string' ? body.detail : 'تعذر إكمال العملية';
    if (Array.isArray(body.detail)) message = body.detail.map(e=>e.msg).join('، ');
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}
// Authenticated media fetch for embedded Google AI Studio previews.
// <img src> cannot attach the in-memory bearer token when cookies are blocked.
// Bound media downloads so a 100-image catalogue or printed receipt cannot
// open hundreds of concurrent connections to Render/Supabase.
let activeMediaRequests=0;
const mediaWaiters=[];
const MAX_ACTIVE_MEDIA_REQUESTS=5;
async function acquireMediaSlot(){
  if(activeMediaRequests<MAX_ACTIVE_MEDIA_REQUESTS){activeMediaRequests++;return;}
  await new Promise(resolve=>mediaWaiters.push(resolve));
}
function releaseMediaSlot(){
  const waiter=mediaWaiters.shift();
  if(waiter)waiter(); // Hand off the existing slot without incrementing.
  else activeMediaRequests=Math.max(0,activeMediaRequests-1);
}
export async function apiMedia(path) {
  if (!/^\/images\/[a-f0-9]{32}\.(png|jpg|webp)$/i.test(path)) throw new Error('مسار الصورة غير صالح');
  const headers = {};
  if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
  await acquireMediaSlot();
  try {
    let res;
    try {
      res = await fetch('/api' + path, {method:'GET',credentials:'same-origin',cache:'no-store',headers,signal:AbortSignal.timeout(30000)});
    } catch {
      throw new Error('تأخر تحميل الصورة بسبب الاتصال؛ حاول فتحها لاحقاً');
    }
    if (!res.ok) throw new Error('تعذّر تحميل الصورة');
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size>3*1024*1024) throw new Error('ملف الصورة غير متوقع');
    return blob;
  } finally {
    releaseMediaSlot();
  }
}
export function money(value) { return new Intl.NumberFormat('ar-IQ-u-nu-latn').format(value ?? 0) + ' د.ع'; }
export function number(value) { return new Intl.NumberFormat('ar-IQ-u-nu-latn').format(value ?? 0); }
export function safe(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
