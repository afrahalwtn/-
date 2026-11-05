import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = 43187;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
  env: { ...process.env, PORT: String(port), AFRAH_SECURE_COOKIES: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', data => { logs += data.toString(); });
server.stderr.on('data', data => { logs += data.toString(); });

async function request(path, opts = {}) {
  return fetch(origin + '/api' + path, { cache:'no-store', ...opts });
}

try {
  let live = false;
  for (let i=0; i<60; i++) {
    try {
      const res = await request('/health');
      if (res.ok && (await res.json()).status === 'ok') { live = true; break; }
    } catch {}
    if (server.exitCode !== null) break;
    await delay(500);
  }
  assert(live, 'Server did not start: ' + logs);

  // Actual free Tabler RTL assets and locally hosted Arabic fonts.
  const page = await fetch(origin + '/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert(html.includes('/vendor/tabler.rtl.min.css'));
  assert(html.includes('/vendor/tajawal/400.css'));
  assert(html.includes('/web/tabler-afrah.css'));

  const tabler = await fetch(origin + '/vendor/tabler.rtl.min.css');
  assert.equal(tabler.status, 200, 'Official Tabler RTL CSS must load offline');
  assert((await tabler.text()).length > 10000);

  for (const weight of [400,500,700,800,900]) {
    const font = await fetch(origin + '/vendor/tajawal/' + weight + '.css');
    assert.equal(font.status, 200, 'Self-hosted Tajawal ' + weight + ' must be accessible');
    assert((await font.text()).includes('@font-face'), 'Tajawal CSS must contain font-face declarations');
  }
  const tajawalFont = await fetch(origin + '/vendor/tajawal/files/tajawal-arabic-400-normal.woff2');
  assert.equal(tajawalFont.status, 200, 'Arabic Tajawal font binary must be served without CDN');
  const skin = await fetch(origin + '/web/tabler-afrah.css');
  assert.equal(skin.status, 200, 'Tabler premium Afrah customization must load');
  assert((await skin.text()).includes('"Tajawal"'));
  // KOA-inspired homepage styling must be served locally and include responsive layouts.
  assert(html.includes('/web/koa-theme.css?v=20261105-koa-home-v1'));
  const koaTheme = await fetch(origin + '/web/koa-theme.css');
  assert.equal(koaTheme.status, 200, 'New KOA brand theme must load');
  const koaCss = await koaTheme.text();
  for (const marker of ['.koa-hero','.koa-stats','.koa-stock-alerts','#1766df','#0abbd1','@media(max-width:760px)']) {
    assert(koaCss.includes(marker), 'Missing KOA theme rule: ' + marker);
  }
  const appSource = await fetch(origin + '/web/app.js');
  assert.equal(appSource.status, 200);
  const homepageCode = await appSource.text();
  assert(homepageCode.includes('af-home-search') && homepageCode.includes('af-home-alerts'));
  assert(homepageCode.includes('af-greeting-card'), 'Welcome must use a Tabler card');
  assert(homepageCode.includes('header-centered-logo'), 'Tapello must be centered in header');
  assert(homepageCode.includes("['prepare','جهّز قائمة','table']"), 'Prepare List nav must exist');
  assert(homepageCode.includes('function prepareView()'), 'Dedicated list preparation view must exist');
  assert(homepageCode.includes('id="quote-search"'), 'Prepare List must have product search');
  assert(homepageCode.includes("case 'quote-add-item'"), 'Search must append to draft');
  assert(homepageCode.includes('new window.Tabulator'), 'Grid must use a real MIT-licensed Tabulator engine');
  assert(homepageCode.includes('cellEdited') && homepageCode.includes("bottomCalc:'sum'"), 'Grid must support editable quantities and Excel-like sums');
  assert(homepageCode.includes("case 'quote-create'"), 'Existing quotation save must remain operational');
  assert(homepageCode.includes('safe(a.name)'), 'Alert names must be escaped');
  assert(html.includes('/web/afrah-layout-v5.css?v=20261105-v5'), 'New welcome/header/grid layout must be active');
  assert(html.includes('/vendor/tabulator.min.css') && html.includes('/vendor/tabulator.min.js'), 'Spreadsheet assets must be linked locally');
  const gridCss = await fetch(origin + '/vendor/tabulator.min.css');
  assert.equal(gridCss.status,200,'Tabulator CSS must be served offline');
  assert((await gridCss.text()).length>20000,'Tabulator CSS must not be empty');
  const gridJs = await fetch(origin + '/vendor/tabulator.min.js');
  assert.equal(gridJs.status,200,'Tabulator JS must be served offline');
  assert((await gridJs.text()).length>100000,'Real Tabulator JavaScript must not be empty');
  const newTheme = await fetch(origin + '/web/afrah-layout-v5.css');
  assert.equal(newTheme.status,200);
  const newCss = await newTheme.text();
  for(const marker of ['.header-centered-logo','.af-greeting-card','.af-prep-sheet','#prepare-grid.tabulator','@media(max-width:700px)']){
    assert(newCss.includes(marker),'Missing new free UI styles: '+marker);
  }
  const realIcons = await fetch(origin + '/web/icons.js');
  const iconCode=await realIcons.text();
  assert(iconCode.includes('"receipt"') && iconCode.includes('"tag"'),'Tabler quote and price icons are required');
  assert(homepageCode.includes('setAccessToken(result.access_token)'), 'Working embedded login path must remain intact');
  const mediaClient=await fetch(origin+'/web/api.js');
  assert.equal(mediaClient.status,200);
  assert((await mediaClient.text()).includes('export async function apiMedia(path)'),'Secure media client must exist');
  assert(homepageCode.includes('data-private-image'),'Product photos must request via protected image hydration');
  assert(homepageCode.includes('await hydrateImages(printRoot)'),'Photos must load before quote printing');
  const icons = await fetch(origin + '/web/icons.js');
  assert.equal(icons.status, 200);
  assert((await icons.text()).includes('Official Tabler SVG icons'));

  const login = await request('/auth/login', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'admin',password:'admin123456'}),
  });
  assert.equal(login.status, 200, 'Demo credentials should work with the real API');
  const session = await login.json();
  assert.match(session.access_token, /^[A-Za-z0-9_-]{48}$/, 'Login returns an ephemeral access token');
  assert.equal(typeof session.csrf,'string');

  const anonymous = await request('/products');
  assert.equal(anonymous.status,401,'No session must remain unauthorized');

  const auth = { Authorization:'Bearer ' + session.access_token };
  const withToken = await request('/products',{headers:auth});
  assert.equal(withToken.status,200,'Explicit bearer token must authenticate without cookies');
  assert(Array.isArray(await withToken.json()));

  const me = await request('/me',{headers:auth});
  assert.equal(me.status,200,'Session is accepted by /me');
  assert.equal((await me.json()).user.role,'admin');

  const missingCsrf = await request('/products',{
    method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{}',
  });
  assert.equal(missingCsrf.status,403,'CSRF check must remain enabled');

  // Product images must work with bearer authentication in cookie-blocking previews.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUqDjBwMDAxMDAwMDAAAAQagFs+4JkhgAAAABJRU5ErkJggg==','base64');
  const imageForm=new FormData();
  imageForm.set('file',new Blob([png],{type:'image/png'}),'sample.png');
  const uploaded=await request('/products/1/image',{
    method:'POST',headers:{...auth,'X-CSRF-Token':session.csrf},body:imageForm,
  });
  assert.equal(uploaded.status,200,'Uploading a real PNG must work');
  const uploadedImage=(await uploaded.json()).image_url;
  assert.match(uploadedImage,/^\/api\/images\/[0-9a-f]{32}\.png$/,'PNG must keep its real file type');
  const notAuthorized=await fetch(origin+uploadedImage);
  assert.equal(notAuthorized.status,401,'Private product images require login');
  const authorized=await fetch(origin+uploadedImage,{headers:auth});
  assert.equal(authorized.status,200,'Product images must load using bearer session without cookies');
  assert((authorized.headers.get('content-type')||'').includes('image/png'),'Image MIME type must be correct');
  assert.equal((await authorized.arrayBuffer()).byteLength,png.length);

  // Multiple searched materials must be printable in a single saved quote.
  const savedQuoteResponse=await request('/quotes',{
    method:'POST',
    headers:{...auth,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},
    body:JSON.stringify({items:[{product_id:1,quantity:2},{product_id:2,quantity:3}]}),
  });
  assert.equal(savedQuoteResponse.status,201,'Two-product receipt must be saved');
  const savedQuote=await savedQuoteResponse.json();
  assert.equal(savedQuote.items.length,2);
  assert.equal(savedQuote.items[0].quantity,2);
  assert.equal(savedQuote.items[1].quantity,3);
  assert.equal(savedQuote.items[0].product_name,'رول نايلون غذائي شفاف 45 سم');
  assert.equal(savedQuote.items[1].manufacture,'إماراتي');
  assert.equal(savedQuote.total,127000,'Quote total must multiply price by each quantity');
  assert('image_url' in savedQuote.items[0],'Receipt must preserve image field');
  assert.equal(savedQuote.items[0].image_url,uploadedImage,'Saved quote must retain the uploaded product photo');
  const storedQuote=await request('/quotes/'+savedQuote.id,{headers:auth});
  assert.equal(storedQuote.status,200,'Saved multi-item quote must be retrievable');
  assert.equal((await storedQuote.json()).total,127000);

  const badLogin = await request('/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'admin',password:'wrong'}),
  });
  assert.equal(badLogin.status,401,'Wrong passwords must still be rejected');

  const logout = await request('/auth/logout',{
    method:'POST',headers:{...auth,'X-CSRF-Token':session.csrf},
  });
  assert.equal(logout.status,200,'Logout must revoke the bearer session');

  const revoked = await request('/me',{headers:auth});
  assert.equal(revoked.status,401,'Revoked token must no longer work');

  console.log('PASS: centered logo, Tabler welcome, offline Tabulator, editable list, quote persistence, auth, CSRF');
} finally {
  server.kill('SIGTERM');
}
