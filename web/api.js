// Access to protected resources goes through this single same-origin API client.
// Session cookies are HttpOnly and never read or stored in JavaScript.
let csrfToken = null;
export function setCsrf(token) { csrfToken = token || null; }
export async function api(path, {method='GET', data, file} = {}) {
  const headers = {};
  const options = {method, credentials:'same-origin', cache:'no-store', headers};
  if (method !== 'GET') {
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (file) options.body = file;
    else if (data !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    }
  }
  const res = await fetch('/api' + path, options);
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
export function money(value) { return new Intl.NumberFormat('ar-IQ-u-nu-latn').format(value ?? 0) + ' د.ع'; }
export function number(value) { return new Intl.NumberFormat('ar-IQ-u-nu-latn').format(value ?? 0); }
export function safe(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
