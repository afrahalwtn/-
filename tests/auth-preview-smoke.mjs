import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const testDataDir=mkdtempSync(path.join(tmpdir(),'afrah-auth-preview-'));
const port = 43187;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
  env: { ...process.env, SUPABASE_URL:'', SUPABASE_SECRET_KEY:'', AFRAH_ADMIN_RESET_PASSWORD:'', AFRAH_ADMIN_PASSWORD:'', AFRAH_STAFF_PASSWORD:'', AFRAH_ENABLE_ADMIN_RECOVERY:'', AFRAH_TRUST_PROXY_HOPS:'0', NODE_ENV:'development', AFRAH_DATA_DIR:testDataDir, PORT: String(port), AFRAH_SECURE_COOKIES: 'false' },
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
  const staffSource=await fetch(origin+'/web/app.js');
  assert.equal(staffSource.status,200);
  const staffCode=await staffSource.text();
  assert(staffCode.includes("['prepare','جهّز قائمة','table']"),'Employee portal must include Prepare List');
  assert(staffCode.includes('new window.Tabulator'),'Staff must use the real editable spreadsheet');
  assert(!staffCode.includes('function usersView()')&&!staffCode.includes('function productModal('),'No administrative UI may be bundled into staff app');
  const adminPage=await fetch(origin+'/admin');
  assert.equal(adminPage.status,200);
  const adminHtml=await adminPage.text();
  assert(adminHtml.includes('/web/admin-app.js'),'Separate admin page must load the admin bundle');
  assert(!html.includes('/web/admin-app.js'),'Staff homepage must not load admin bundle');
  assert(html.includes('/web/app.js'),'Staff homepage must load independent staff JS');
  const appSource = await fetch(origin + '/web/admin-app.js');
  assert.equal(appSource.status, 200);
  const homepageCode = await appSource.text();
  assert(homepageCode.includes('af-home-search') && homepageCode.includes('af-home-alerts'));
  assert(homepageCode.includes('af-greeting-card'), 'Welcome must use a Tabler card');
  assert(homepageCode.includes('af-brand-primary') && homepageCode.includes('af-brand-secondary'), 'Header must show primary Afrah and secondary Tapello marks');
  assert(homepageCode.includes("['prepare','جهّز قائمة','table']"), 'Prepare List nav must exist');
  assert(homepageCode.includes('function prepareView()'), 'Dedicated list preparation view must exist');
  assert(homepageCode.includes('id="quote-search"'), 'Prepare List must have product search');
  assert(homepageCode.includes("case 'quote-add-item'"), 'Search must append to draft');
  assert(homepageCode.includes('new window.Tabulator'), 'Grid must use a real MIT-licensed Tabulator engine');
  assert(homepageCode.includes('cellEdited') && homepageCode.includes("bottomCalc:'sum'"), 'Grid must support editable quantities and Excel-like sums');
  assert(homepageCode.includes("case 'quote-create'"), 'Existing quotation save must remain operational');
  assert(homepageCode.includes('safe(a.name)'), 'Alert names must be escaped');
  assert(html.includes('/web/afrah-layout-v5.css?v=20261105-v5'), 'Existing free UI layout must stay loaded');
   assert(html.includes('/web/afrah-brand-2026.css') && adminHtml.includes('/web/afrah-brand-2026.css'), 'Dual-brand theme must be active in both portals');
   const brandCss=await (await fetch(origin+'/web/afrah-brand-2026.css')).text();
   assert(brandCss.includes('.af-brand-primary') && brandCss.includes('.af-brand-secondary'), 'Missing dual-brand visual hierarchy');
   const logoResponse=await fetch(origin+'/assets/afrah-alwatan.svg');
   assert.equal(logoResponse.status,200,'Main Afrah logo asset must be served');
   assert((await logoResponse.text()).includes('viewBox'), 'Afrah logo must be an actual SVG');
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

  const adminPageSelf=await request('/admin/me',{headers:auth});
  assert.equal(adminPageSelf.status,200,'Admin session may enter admin site');

  const employeeLogin=await request('/staff/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'staff',password:'staff123456'})
  });
  assert.equal(employeeLogin.status,200,'Staff should login on public site');
  const employee=await employeeLogin.json();
  const employeeHeader={Authorization:'Bearer '+employee.access_token};
  assert.equal((await request('/admin/me',{headers:employeeHeader})).status,403,'Staff cannot enter admin API');
  assert.equal((await request('/users',{headers:employeeHeader})).status,403,'Staff cannot manage users');
  assert.equal((await request('/quotes',{headers:employeeHeader})).status,403,'Staff cannot read management quotations');
  // Item editor: separate IQD/USD values, dimensions, arbitrary specifications and server-side permissions.
  const itemCreation=await request('/products',{
    method:'POST',headers:{...auth,'Content-Type':'application/json','X-CSRF-Token':session.csrf},
    body:JSON.stringify({
      name:'ايتم ورقي جديد',description:'اختبار تفاصيل الايتم',manufacture:'العراق',
      quantity:13,min_quantity:3,purchase_price:8000,sale_price:11000,
      item_type:'ورقي',category:'تغليف',sku:'TEST-ITEM-2026',unit:'كارتون',
      length_cm:42,width_cm:33,height_cm:11,weight_g:850,
      wholesale_price_iqd:9500,purchase_price_usd:6.1,
      retail_price_usd:8.5,wholesale_price_usd:7.2,
      custom_fields:[{label:'السماكة',value:'40 مايكرون'}],
    }),
  });
  assert.equal(itemCreation.status,201,'Manager can create a complete item');
  const item=await itemCreation.json();
  assert.equal(item.item_type,'ورقي');
  assert.equal(item.retail_price_usd,8.5);
  assert.equal(item.wholesale_price_iqd,9500);
  assert.equal(item.length_cm,42);
  assert.equal(item.custom_fields[0].value,'40 مايكرون');
  const staffItems=await request('/products',{headers:employeeHeader});
  const visibleItem=(await staffItems.json()).find(p=>p.id===item.id);
  assert(visibleItem,'New item is available to staff');
  assert.equal(visibleItem.purchase_price_usd,undefined,'Staff cannot see hidden purchase USD prices');
  assert.equal(visibleItem.retail_price_usd,8.5,'Staff sale USD prices follow sale permission');
  assert.equal((await request('/products?q=%D8%A7%D9%84%D8%B3%D9%85%D8%A7%D9%83%D8%A9',{headers:auth})).status,200,'Extra attributes are searchable');
  const itemUpdate=await request('/products/'+item.id,{
    method:'PUT',headers:{...auth,'Content-Type':'application/json','X-CSRF-Token':session.csrf},
    body:JSON.stringify({wholesale_price_iqd:null,custom_fields:[],item_type:'بلاستك'}),
  });
  assert.equal(itemUpdate.status,200,'Manager can modify/remove item details');
  const changedItem=await itemUpdate.json();
  assert.equal(changedItem.wholesale_price_iqd,null);
  assert.equal(changedItem.item_type,'بلاستك');
  assert.equal(changedItem.custom_fields.length,0);
  const invalidSpecs=await request('/products/'+item.id,{
    method:'PUT',headers:{...auth,'Content-Type':'application/json','X-CSRF-Token':session.csrf},
    body:JSON.stringify({custom_fields:[{label:'',value:'nonempty'}]}),
  });
  assert.equal(invalidSpecs.status,422,'Invalid custom details must be rejected');
  const employeeProducts=await request('/products',{headers:employeeHeader});
  assert.equal(employeeProducts.status,200);
  const employeeRows=await employeeProducts.json();
  assert(!('purchase_price' in employeeRows[0]),'Staff may not receive a disabled purchase price');
  assert('sale_price' in employeeRows[0],'Enabled sale price remains visible to staff');
  assert.equal((await request('/products',{
    method:'POST',headers:{...employeeHeader,'Content-Type':'application/json','X-CSRF-Token':employee.csrf},
    body:JSON.stringify({name:'Unauthorized item',quantity:1})
  })).status,403,'Staff cannot modify products');
  assert.equal((await request('/quotes',{
    method:'POST',headers:{...employeeHeader,'Content-Type':'application/json','X-CSRF-Token':employee.csrf},
    body:JSON.stringify({items:[{product_id:1,quantity:1}]})
  })).status,403,'Staff cannot create a management quote');
  assert.equal((await request('/admin/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'staff',password:'staff123456'})
  })).status,403,'Staff login must be refused at admin gate');
  assert.equal((await request('/staff/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'admin',password:'admin123456'})
  })).status,200,'Admin can use staff view with admin credentials');

  // Staff records performed materials, but cannot change product catalogue or quantities.
  const beforeExecution=await request('/products',{headers:employeeHeader});
  const initialStock=(await beforeExecution.json()).find(x=>x.id===1).quantity;
  const done=await request('/execution-lists',{
   method:'POST',headers:{...employeeHeader,'X-CSRF-Token':employee.csrf,'Content-Type':'application/json'},
   body:JSON.stringify({items:[{product_id:1,quantity:4},{product_id:2,quantity:3}]})
  });
  assert.equal(done.status,201,'Staff must be able to record completed materials');
  const record=await done.json();
  assert.equal(record.items.length,2,'Performed items are saved as one list');
  assert.equal(record.created_by_id,employee.user.id);
  assert(!JSON.stringify(record).includes('purchase_price')&&!JSON.stringify(record).includes('sale_price'),'Execution list must not reveal prices');
  const savedLists=await request('/execution-lists',{headers:employeeHeader});
  assert.equal(savedLists.status,200);
  assert((await savedLists.json()).some(x=>x.id===record.id),'Staff must view their saved list');
  const adminLists=await request('/execution-lists',{headers:auth});
  assert.equal(adminLists.status,200);
  assert((await adminLists.json()).some(x=>x.id===record.id),'Admin can review staff execution data');
  const afterExecution=await request('/products',{headers:employeeHeader});
  assert.equal((await afterExecution.json()).find(x=>x.id===1).quantity,initialStock,'Executed list must not deduct stock without permission');
  const invalidExecution=await request('/execution-lists',{
   method:'POST',headers:{...employeeHeader,'X-CSRF-Token':employee.csrf,'Content-Type':'application/json'},
   body:JSON.stringify({items:[{product_id:1,quantity:-5}]})
  });
  assert.equal(invalidExecution.status,422,'Negative quantities must be rejected');
  const forbiddenAdminList=await request('/execution-lists',{
   method:'POST',headers:{...auth,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},
   body:JSON.stringify({items:[{product_id:1,quantity:1}]})
  });
  assert.equal(forbiddenAdminList.status,403,'Execution entry should belong to staff role');
  assert.equal((await request('/execution-lists')).status,401,'Anonymous list access must be denied');

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
  assert.match(authorized.headers.get('cache-control')||'',/no-store/,
    'Private product images must not remain cached when sessions are revoked');
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

  console.log('PASS: staff execution lists, no inventory mutation or price leakage, admin/staff permissions, offline grids, auth');
} finally {
  server.kill('SIGTERM');
  await delay(250);
  rmSync(testDataDir,{force:true,recursive:true});
}
