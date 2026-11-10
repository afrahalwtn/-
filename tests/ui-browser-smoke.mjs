import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';


// Preparation panels must flow vertically, while the spreadsheet scrolls inside
// its own card. This guards against overlapping screens on mobile/tablet.
async function assertPreparationPanels(page,label){
  const layout=await page.evaluate(()=>{
    const root=document.querySelector('.af-prep');
    if(!root)return {missing:true};
    const selector='.af-prep-heading,.af-prep-search-card,.af-prep-sheet,.af-offline-outbox,.staff-execution-history';
    const boxes=Array.from(root.children).filter(node=>node.matches(selector)).map(node=>{
      const r=node.getBoundingClientRect();
      return {name:node.className,top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width};
    });
    const overlapping=[];
    for(let i=1;i<boxes.length;i++){
      if(boxes[i].top<boxes[i-1].bottom-1)
        overlapping.push([boxes[i-1].name,boxes[i].name]);
    }
    const wrapper=document.querySelector('.af-prep .af-tabulator-wrap')?.getBoundingClientRect();
    return {missing:false,boxes,overlapping,wrapperWidth:wrapper?.width||0,
      windowWidth:innerWidth,scrollWidth:document.documentElement.scrollWidth};
  });
  assert(!layout.missing,label+': preparation view was not rendered');
  assert(layout.boxes.length>=3,label+': missing preparation sections');
  assert.equal(layout.overlapping.length,0,label+': preparation sections overlap '+JSON.stringify(layout.overlapping));
  assert(layout.wrapperWidth<=layout.windowWidth+2,
    label+': spreadsheet escapes its card '+JSON.stringify(layout));
  assert(layout.scrollWidth<=layout.windowWidth+2,
    label+': page horizontal overflow '+JSON.stringify(layout));
}

const executablePath=[
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].find(x=>x && existsSync(x));
if(!executablePath){
  if(process.env.GITHUB_ACTIONS==='true')throw Error('Chromium/Chrome was not found on the CI runner');
  console.log('SKIP: Browser not installed in preview environment; GitHub Actions runs the full UI test.');
  process.exit(0);
}
const testDataDir=mkdtempSync(path.join(tmpdir(),'afrah-ui-smoke-'));
mkdirSync('screenshots',{recursive:true});
const port=43189,base='http://127.0.0.1:'+port;
const server=spawn(process.execPath,['--import','tsx','server.ts'],{
  env:{...process.env,SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',AFRAH_ADMIN_RESET_PASSWORD:'',AFRAH_ADMIN_PASSWORD:'',AFRAH_STAFF_PASSWORD:'',AFRAH_ENABLE_ADMIN_RECOVERY:'',AFRAH_TRUST_PROXY_HOPS:'0',NODE_ENV:'development',AFRAH_DATA_DIR:testDataDir,PORT:String(port),AFRAH_SECURE_COOKIES:'false'},
  stdio:['ignore','pipe','pipe'],
});
let logs='';
server.stdout.on('data',d=>logs+=d.toString());
server.stderr.on('data',d=>logs+=d.toString());
let browser;
try {
  let ready=false;
  for(let i=0;i<60;i++){
    try{const r=await fetch(base+'/api/health');if(r.ok){ready=true;break;}}catch{}
    if(server.exitCode!==null)break;
    await delay(400);
  }
  assert(ready,'Server unavailable: '+logs);
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  const errors=[];
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(e.message));

  await page.goto(base+'/admin',{waitUntil:'domcontentloaded'});
  await page.locator('form[data-form="login"]').waitFor();
  await page.screenshot({path:'screenshots/mobile-login.png',fullPage:true});
  const loginBg=await page.locator('.auth-preview').evaluate(el=>getComputedStyle(el).backgroundColor);
  assert(['rgba(0, 0, 0, 0)','transparent'].includes(loginBg),'Logo has an added background card: '+loginBg);
  await page.locator('input[name="username"]').fill('admin');
  await page.locator('input[name="password"]').fill('admin123456');
  await page.locator('button[type="submit"]').click();
  await page.locator('.af-home').waitFor({timeout:15000});
  assert.equal(await page.locator('.af-greeting-card.card').count(),1,'Welcome must use the real Tabler card layout');
  assert.equal(await page.locator('.af-welcome-brand').count(),0,'Logo must not be repeated in a large home panel');
  assert.equal(await page.locator('.af-brand-primary img').count(),1,'Primary Afrah logo belongs in header');
  assert.equal(await page.locator('.af-brand-secondary img').count(),1,'Secondary Tapello logo belongs in header');
  assert.equal(await page.locator('.af-home-search').count(),1);
  assert.equal(await page.locator('.af-home-alerts').count(),1);
  assert.equal(await page.locator('.koa-stats').count(),0,'Home must not contain dashboard stat cards');
  const mainLogoMobile=await page.locator('.af-brand-primary').boundingBox();
  const tapelloMobile=await page.locator('.af-brand-secondary').boundingBox();
  assert(mainLogoMobile && tapelloMobile && mainLogoMobile.x>=tapelloMobile.x+tapelloMobile.width-2,'RTL mobile logo placement must not overlap');
  assert(mainLogoMobile.width > tapelloMobile.width * 1.45,'The primary Afrah logo must be substantially larger than Tapello');
  const gradientBand=await page.locator('.af-brand-row').evaluate(el=>getComputedStyle(el).backgroundImage);
  assert(gradientBand.includes('linear-gradient'),'Both logos must sit on a shared full-width gradient band');
  await page.screenshot({path:'screenshots/mobile-home.png',fullPage:true});

  // Upload a genuine image, check it appears securely when the product is searched.
  await page.locator('.sidebar-toggle').click();
  await page.locator('.nav-link[data-section="products"]').click();
  await page.locator('[data-action="edit-product"][data-id="1"]').click();
  await page.locator('.af-dialog').waitFor({state:'visible'});
  // Product editor must expose all item attributes and support extra rows.
  await page.locator('.af-item-form input[name="item_type"]').fill('بلاستك');
  await page.locator('.af-item-form input[name="wholesale_price_iqd"]').fill('9000');
  await page.locator('.af-item-form input[name="retail_price_usd"]').fill('7.5');
  await page.locator('.af-item-form input[name="length_cm"]').fill('28');
  await page.locator('.af-item-form [data-action="add-extra-field"]').click();
  await page.locator('.af-extra-row [name="extra_label"]').fill('السماكة');
  await page.locator('.af-extra-row [name="extra_value"]').fill('30 مايكرون');
  assert.equal(await page.locator('.af-extra-row').count(),1,'Item custom field added');
  await page.screenshot({path:'screenshots/mobile-item-editor.png',fullPage:true});

  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUqDjBwMDAxMDAwMDAAAAQagFs+4JkhgAAAABJRU5ErkJggg==','base64');
  await page.locator('.af-dialog input[name="image"]').setInputFiles({name:'test-product.png',mimeType:'image/png',buffer:png});
  await page.locator('.af-dialog button[type="submit"]').click();
  await page.locator('[data-action="edit-product"][data-id="1"]').click();
  await page.locator('.af-item-form').waitFor({state:'visible'});
  assert.equal(await page.locator('.af-item-form input[name="item_type"]').inputValue(),'بلاستك');
  assert.equal(await page.locator('.af-item-form input[name="wholesale_price_iqd"]').inputValue(),'9000');
  assert.equal(await page.locator('.af-extra-row [name="extra_value"]').inputValue(),'30 مايكرون');
  await page.locator('.af-extra-row [data-action="remove-extra-field"]').click();
  assert.equal(await page.locator('.af-extra-row').count(),0,'Admin can remove a custom detail');
  await page.locator('.af-dialog [data-action="close-modal"]').first().click();

  // Debounced catalogue filtering must preserve visible results and keyboard focus.
  await page.locator('#products-search').fill('no-such-afrah-item-99999');
  await page.waitForFunction(()=>document.querySelector('.products-searchbar') &&
    document.querySelector('.count-label')?.textContent?.includes('0'),null,{timeout:5000});
  assert.equal(await page.locator('#products-search').inputValue(),'no-such-afrah-item-99999');
  await page.locator('#products-search').fill('');
  await page.waitForFunction(()=>document.querySelectorAll('.af-item-table tbody tr').length>=2,null,{timeout:5000});

  await page.waitForFunction(
    ()=>Array.from(document.querySelectorAll('img.product-thumb[data-private-image]')).some(img=>img.src.startsWith('blob:')&&img.naturalWidth>0),
    null,{timeout:15000}
  );
  await page.locator('.sidebar-toggle').click();
  await page.locator('.nav-link[data-section="home"]').click();
  await page.locator('#home-search').fill('رول');
  await page.locator('.quote-add-result[data-id="1"]').click();

  // The first search takes the item to the dedicated "جهّز قائمة" page.
  await page.locator('#quote-search').waitFor();
  await page.locator('#prepare-grid .tabulator-tableholder .tabulator-table .tabulator-row').first().waitFor({timeout:15000});
  assert.equal(await page.locator('.nav-link[data-section="prepare"]').count(),1,'Dedicated Prepare List section is required');
  assert(await page.evaluate(()=>typeof window.Tabulator==='function'),'Real MIT Tabulator library must initialize');
  assert.equal(await page.locator('#prepare-grid .tabulator-tableholder .tabulator-table .tabulator-row').count(),1,'First material must be in spreadsheet');
  await page.screenshot({path:'screenshots/mobile-prepare-first.png',fullPage:true});
   await assertPreparationPanels(page,'Admin mobile');
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('img.af-grid-photo')).some(img=>img.src.startsWith('blob:')&&img.naturalWidth>0),null,{timeout:15000});

  await page.locator('#quote-search').fill('علب');
  await page.locator('.quote-add-result').first().click();
  await page.locator('#prepare-grid .tabulator-tableholder .tabulator-table .tabulator-row').nth(1).waitFor({timeout:15000});
  assert.equal(await page.locator('#prepare-grid .tabulator-tableholder .tabulator-table .tabulator-row').count(),2,'Second item must append to the same spreadsheet');

  // Edit quantity in a native Tabulator cell like Excel.
  const quantityCell=page.locator('#prepare-grid .tabulator-tableholder .tabulator-table .tabulator-row .tabulator-cell[tabulator-field="quantity"]').first();
  await quantityCell.click();
  await page.locator('#prepare-grid input[type="number"]').waitFor({state:'visible',timeout:6500});
  await page.locator('#prepare-grid input[type="number"]').fill('2');
  await page.locator('#prepare-grid input[type="number"]').press('Enter');
  await page.waitForFunction(()=>document.querySelector('.af-grid-editable')?.textContent?.includes('2'),null,{timeout:7000});
  assert(await page.locator('#prepare-total').textContent(),'Sheet must recalculate total');
  await page.screenshot({path:'screenshots/mobile-receipt.png',fullPage:true});

  let quoteWriteRequests=0;
  const countQuoteWrites=req=>{
    if(req.method()==='POST'&&req.url().endsWith('/api/quotes'))quoteWriteRequests++;
  };
  page.on('request',countQuoteWrites);
  // Two very rapid clicks must never save the same quotation twice.
  await page.locator('[data-action="quote-create"]').evaluate(button=>{
    button.click();
    button.click();
  });
  await page.locator('.quote-preview').waitFor({timeout:15000});
  page.off('request',countQuoteWrites);
  assert.equal(quoteWriteRequests,1,'Rapid repeated save clicks must create one quotation only');
  assert.equal(await page.locator('.quote-preview tbody tr').count(),2,'Saved quotation must contain both selected items');
  assert.equal(await page.locator('.nav-link[data-section="quotes"]').count(),1,'Saved quotations remain a separate section');

  // Navigation should not overflow the mobile screen.
  const mobileWidth=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
  assert(mobileWidth.scroll<=mobileWidth.width+2,'Mobile layout overflows: '+JSON.stringify(mobileWidth));

  const desktop=await browser.newPage({viewport:{width:1366,height:768}});
  desktop.on('pageerror',e=>errors.push(e.message));
  await desktop.goto(base+'/admin',{waitUntil:'domcontentloaded'});
  await desktop.locator('form[data-form="login"]').waitFor();
  await desktop.locator('input[name="username"]').fill('admin');
  await desktop.locator('input[name="password"]').fill('admin123456');
  await desktop.locator('button[type="submit"]').click();
  await desktop.locator('.af-home').waitFor({timeout:15000});
  await desktop.screenshot({path:'screenshots/desktop-home.png',fullPage:true});
  const mainLogoDesktop=await desktop.locator('.af-brand-primary').boundingBox();
  const tapelloDesktop=await desktop.locator('.af-brand-secondary').boundingBox();
  assert(mainLogoDesktop && tapelloDesktop && mainLogoDesktop.x>=tapelloDesktop.x+tapelloDesktop.width-2,'RTL desktop logos must not overlap');
  assert(mainLogoDesktop.width > tapelloDesktop.width * 1.5,'Desktop main Afrah logo must dominate over the subordinate Tapello brand');
  await desktop.locator('.nav-link[data-section="prepare"]').click();
  await desktop.locator('#prepare-grid').waitFor({timeout:8000});
  await desktop.screenshot({path:'screenshots/desktop-prepare.png',fullPage:true});
   await assertPreparationPanels(desktop,'Admin desktop');

  const deskWidth=await desktop.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
  assert(deskWidth.scroll<=deskWidth.width+2,'Desktop layout overflows: '+JSON.stringify(deskWidth));
  const ipad=await browser.newPage({viewport:{width:820,height:1180},deviceScaleFactor:1});
  ipad.on('pageerror',e=>errors.push(e.message));
  await ipad.goto(base+'/admin',{waitUntil:'domcontentloaded'});
  await ipad.locator('form[data-form="login"]').waitFor();
  await ipad.locator('input[name="username"]').fill('admin');
  await ipad.locator('input[name="password"]').fill('admin123456');
  await ipad.locator('button[type="submit"]').click();
  await ipad.locator('.af-home').waitFor({timeout:15000});
  // Off-canvas navigation must not be a hidden clickable overlay on the iPad.
  assert.equal(await ipad.locator('#sidebar').evaluate(el=>getComputedStyle(el).visibility),
    'hidden','Closed tablet menu must be genuinely hidden');
  const palette=await ipad.evaluate(()=>{
    const el=document.createElement('select');
    el.innerHTML='<option value="a">الفئات</option>';
    document.querySelector('.shell').append(el);
    const cs=getComputedStyle(el);
    const values={background:cs.backgroundColor,color:cs.color,
      fontFamily:cs.fontFamily,image:cs.backgroundImage};
    el.remove();return values;
  });
  assert.equal(palette.background,'rgb(248, 250, 255)','Select color must match light indigo theme');
  assert(palette.image.includes('svg'),'Native dropdown must use the themed arrow icon');
  await ipad.screenshot({path:'screenshots/ipad-home.png',fullPage:true});
  await ipad.locator('.sidebar-toggle').click();
  await ipad.locator('.nav-link[data-section="prepare"]').click();
  await ipad.locator('#prepare-grid').waitFor({timeout:8000});
  await ipad.screenshot({path:'screenshots/ipad-prepare.png',fullPage:true});
   await assertPreparationPanels(ipad,'Admin iPad');

  const ipadWidth=await ipad.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
  assert(ipadWidth.scroll<=ipadWidth.width+2,'iPad layout overflows: '+JSON.stringify(ipadWidth));
  // Independent employee site; it must share Prepare List but never include admin controls.
  const staff=await browser.newPage({viewport:{width:390,height:844}});
  staff.on('pageerror',e=>errors.push(e.message));
  await staff.goto(base+'/',{waitUntil:'domcontentloaded'});
  await staff.locator('#staff-login').waitFor({timeout:10000});
  await staff.locator('input[name="username"]').fill('staff');
  await staff.locator('input[name="password"]').fill('staff123456');
  await staff.locator('button[type="submit"]').click();
  await staff.locator('.af-home').waitFor({timeout:15000});
  assert.equal(await staff.locator('.nav-link[data-nav="prepare"]').count(),1,'Prepare List must exist for staff');
  assert.equal(await staff.locator('[data-action="new-user"],[data-action="new-product"]').count(),0,'Admin controls must be absent');
  await staff.locator('#staff-home-search').fill('رول');
  await staff.locator('.staff-add-to-list').first().click();
  await staff.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').first().waitFor({timeout:15000});
  assert.equal(await staff.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').count(),1,"Employee's first item appears in list");
  await staff.locator('#staff-prepare-search').fill('علب');
  await staff.locator('.staff-add-to-list').first().click();
  await staff.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').nth(1).waitFor({timeout:15000});
  assert.equal(await staff.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').count(),2,"Employee's second item appends to same spreadsheet");
  assert.equal(await staff.locator('#staff-grid .tabulator-col[tabulator-field="purchase_price"]').count(),0,'Disabled purchase-price column must be absent');
  assert.equal(await staff.locator('#staff-grid .tabulator-col[tabulator-field="sale_price"]').count(),1,'Enabled sale-price column must be visible');
  const quantity=staff.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row .tabulator-cell[tabulator-field="quantity"]').first();
  await quantity.click();
  await staff.locator('#staff-grid input[type="number"]').waitFor({state:'visible',timeout:8000});
  await staff.locator('#staff-grid input[type="number"]').fill('4');
  await staff.locator('#staff-grid input[type="number"]').press('Enter');
  await staff.waitForFunction(()=>document.querySelector('.af-grid-editable')?.textContent?.includes('4'),null,{timeout:8000});
  await staff.screenshot({path:'screenshots/staff-prepare.png',fullPage:true});
   await assertPreparationPanels(staff,'Employee mobile');
  assert.equal(await staff.locator('#staff-print-list:enabled').count(),1,'Prepared list should be printable by staff');
  const previousCount=await staff.locator('.staff-history-entry').count();
  let listSaveRequests=0;
  const countListSaves=req=>{
    if(req.method()==='POST'&&req.url().endsWith('/api/execution-lists'))listSaveRequests++;
  };
  staff.on('request',countListSaves);
  await staff.locator('#staff-save-list').evaluate(button=>{
    button.click();
    button.click();
  });
  await staff.waitForFunction(oldCount=>document.querySelectorAll('.staff-history-entry').length===oldCount+1,previousCount,{timeout:15000});
  staff.off('request',countListSaves);
  assert.equal(listSaveRequests,1,'Rapid employee save clicks must create one execution list');
  assert.equal(await staff.locator('.staff-history-entry').count(),previousCount+1,'Saving should add exactly one execution list');
  const recentList=staff.locator('.staff-history-entry').first();
  await recentList.locator('summary').click();
  assert.equal(await recentList.locator('.staff-history-item').count(),2,'The new execution list preserves both selected items');
  assert.equal(await recentList.locator('.staff-history-item').first().locator('b').textContent(),'العدد: 4','Saved count must match edited quantity');
  assert.equal(await staff.locator('#staff-print-list:disabled').count(),1,'Draft clears after save');
  await staff.screenshot({path:'screenshots/staff-saved-execution.png',fullPage:true});
  assert((await staff.evaluate(()=>document.documentElement.scrollWidth-innerWidth))<=2,'Employee mobile layout must not overflow horizontally');
  await staff.locator('.sidebar-toggle').click();
  assert.equal(await staff.locator('[data-nav="users"],[data-nav="quotes"],[data-action="edit-product"]').count(),0,'Staff site cannot reveal management UI');

  // Admin switches to staff SPA and back with a one-use session handoff.
  await desktop.locator('.af-account-trigger').click();
  await desktop.locator('.portal-switch-btn[data-action="switch-staff"]').click();
  await desktop.waitForURL(base+'/',{timeout:15000});
  await desktop.locator('.portal-switch-btn[data-switch="admin"]').waitFor({state:'attached',timeout:15000});
  assert.equal(await desktop.locator('[data-nav="prepare"]').count(),1);
  assert.equal(await desktop.locator('[data-nav="users"]').count(),0);
  await desktop.screenshot({path:'screenshots/admin-viewing-staff.png',fullPage:true});
  await desktop.locator('.af-account-trigger').click();
  await desktop.locator('.portal-switch-btn[data-switch="admin"]').click();
  await desktop.waitForURL(base+'/admin',{timeout:15000});
  await desktop.locator('.nav-link[data-section="users"]').waitFor({timeout:15000});
  await desktop.locator('.nav-link[data-section="account"]').click();
  await desktop.locator('form[data-form="account"]').waitFor();
  assert.equal(await desktop.locator('form[data-form="account"] input[name="current_password"]').count(),1);
  await desktop.screenshot({path:'screenshots/admin-account-settings.png',fullPage:true});

  const recoveryPage=await browser.newPage({viewport:{width:390,height:844}});
  await recoveryPage.goto(base+'/admin',{waitUntil:'domcontentloaded'});
  await recoveryPage.locator('[data-action="recovery-toggle"]').click();
  await recoveryPage.locator('form[data-form="recovery"]').waitFor();
  await recoveryPage.screenshot({path:'screenshots/admin-account-recovery.png',fullPage:true});

  // Stress the browser with >100 catalogue rows without constructing all DOM
  // rows at once. The complete catalogue remains searchable and accessible.
  const catalogLogin=await fetch(base+'/api/admin/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'admin',password:'admin123456'})
  });
  assert.equal(catalogLogin.status,200,'Catalog stress test admin login');
  const catalogAuth=await catalogLogin.json();
  for(let n=0;n<105;n++){
    const inserted=await fetch(base+'/api/products',{
      method:'POST',
      headers:{'Content-Type':'application/json',
        Authorization:'Bearer '+catalogAuth.access_token,
        'X-CSRF-Token':catalogAuth.csrf},
      body:JSON.stringify({name:'اختبار حمل الايتم '+n,quantity:3})
    });
    assert.equal(inserted.status,201,'Stress catalogue item must be saved');
  }
  await desktop.reload({waitUntil:'domcontentloaded'});
  await desktop.locator('.nav-link[data-section="products"]').click();
  await desktop.locator('.af-item-table tbody tr').first().waitFor();
  assert.equal(await desktop.locator('.af-item-table tbody tr').count(),100,
    'Admin catalogue must not render more than 100 initial rows');
  await desktop.locator('[data-action="catalog-more"]').click();
  assert((await desktop.locator('.af-item-table tbody tr').count())>100,
    'Admin catalogue must reveal additional rows on demand');

  await staff.reload({waitUntil:'domcontentloaded'});
  await staff.locator('.sidebar-toggle').click();
  await staff.locator('.nav-link[data-nav="products"]').click();
  await staff.locator('.staff-product-row').first().waitFor();
  assert.equal(await staff.locator('.staff-product-row').count(),100,
    'Staff catalogue must initially show at most 100 rows');
  await staff.locator('[data-more="catalog"]').click();
  assert((await staff.locator('.staff-product-row').count())>100,
    'Staff must be able to browse all records in batches');

  // Stored product content is untrusted. Both portals must display it as
  // text, never as executable HTML or a browser event handler.
  const hostileName='تجربة XSS <img src=x onerror="window.__afrah_xss=1">';
  const hostileResponse=await fetch(base+'/api/products',{
    method:'POST',
    headers:{'Content-Type':'application/json',
      Authorization:'Bearer '+catalogAuth.access_token,
      'X-CSRF-Token':catalogAuth.csrf},
    body:JSON.stringify({name:hostileName,description:'<svg onload="window.__afrah_xss=1"></svg>',quantity:1})
  });
  assert.equal(hostileResponse.status,201,'Hostile input may be stored as literal text');
  await desktop.reload({waitUntil:'domcontentloaded'});
  await desktop.locator('.nav-link[data-section="products"]').click();
  await desktop.locator('#products-search').fill('تجربة XSS');
  await desktop.waitForTimeout(250);
  assert.equal(await desktop.locator('.af-item-table tbody tr').count(),1);
  assert.equal(await desktop.locator('.af-item-table tbody tr img[src="x"]').count(),0,
    'Product names must not inject executable HTML on admin page');
  assert.equal(await desktop.evaluate(()=>Boolean(window.__afrah_xss)),false,
    'Stored product text must never execute script in admin portal');
  await staff.reload({waitUntil:'domcontentloaded'});
  await staff.locator('.sidebar-toggle').click();
  await staff.locator('.nav-link[data-nav="products"]').click();
  await staff.locator('#staff-products-search').fill('تجربة XSS');
  assert.equal(await staff.locator('img[src="x"]').count(),0,
    'Product names must not inject executable HTML in employee portal');
  assert.equal(await staff.evaluate(()=>Boolean(window.__afrah_xss)),false,
    'Stored product text must never execute script in employee portal');

  assert.equal(errors.length,0,'JavaScript runtime errors: '+errors.join('; '));
  console.log('PASS: separated admin/staff portals, shared Prepare List, role-safe price columns, and responsive mobile/iPad/desktop');
} finally {
  if(browser)await browser.close();
  server.kill('SIGTERM');
  await delay(250);
  rmSync(testDataDir,{force:true,recursive:true});
}
