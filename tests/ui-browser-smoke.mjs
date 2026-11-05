import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const executablePath=[
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].find(x=>x && existsSync(x));
assert(executablePath,'Chromium/Chrome was not found on the CI runner');
mkdirSync('screenshots',{recursive:true});
const port=43189,base='http://127.0.0.1:'+port;
const server=spawn(process.execPath,['--import','tsx','server.ts'],{
  env:{...process.env,PORT:String(port),AFRAH_SECURE_COOKIES:'false'},
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
  assert.equal(await page.locator('.header-centered-logo img').count(),1,'The official logo belongs in the header');
  assert.equal(await page.locator('.af-home-search').count(),1);
  assert.equal(await page.locator('.af-home-alerts').count(),1);
  assert.equal(await page.locator('.koa-stats').count(),0,'Home must not contain dashboard stat cards');
  const headerCenter=await page.locator('.header-centered-logo').boundingBox();
  assert(headerCenter && Math.abs(headerCenter.x+headerCenter.width/2-195)<3,'Logo must be at precise mobile header center');
  await page.screenshot({path:'screenshots/mobile-home.png',fullPage:true});

  // Upload a genuine image, check it appears securely when the product is searched.
  await page.locator('.sidebar-toggle').click();
  await page.locator('.nav-link[data-section="products"]').click();
  await page.locator('[data-action="edit-product"][data-id="1"]').click();
  await page.locator('.af-dialog').waitFor({state:'visible'});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUqDjBwMDAxMDAwMDAAAAQagFs+4JkhgAAAABJRU5ErkJggg==','base64');
  await page.locator('.af-dialog input[name="image"]').setInputFiles({name:'test-product.png',mimeType:'image/png',buffer:png});
  await page.locator('.af-dialog button[type="submit"]').click();
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

  await page.locator('[data-action="quote-create"]').click();
  await page.locator('.quote-preview').waitFor({timeout:15000});
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
  const desktopCenter=await desktop.locator('.header-centered-logo').boundingBox();
  const desktopHeader=await desktop.locator('.topbar').boundingBox();
  assert(desktopCenter && desktopHeader && Math.abs(desktopCenter.x+desktopCenter.width/2-(desktopHeader.x+desktopHeader.width/2))<4,'Header logo must be centered relative to main area');
  await desktop.locator('.nav-link[data-section="prepare"]').click();
  await desktop.locator('#prepare-grid').waitFor({timeout:8000});
  await desktop.screenshot({path:'screenshots/desktop-prepare.png',fullPage:true});

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
  await ipad.screenshot({path:'screenshots/ipad-home.png',fullPage:true});
  await ipad.locator('.sidebar-toggle').click();
  await ipad.locator('.nav-link[data-section="prepare"]').click();
  await ipad.locator('#prepare-grid').waitFor({timeout:8000});
  await ipad.screenshot({path:'screenshots/ipad-prepare.png',fullPage:true});

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
  assert.equal(await staff.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').count(),1,'Employee's first item appears in list');
  await staff.locator('#staff-prepare-search').fill('علب');
  await staff.locator('.staff-add-to-list').first().click();
  await staff.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').nth(1).waitFor({timeout:15000});
  assert.equal(await staff.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').count(),2,'Employee's second item appends to same spreadsheet');
  assert.equal(await staff.locator('#staff-grid .tabulator-col[tabulator-field="purchase_price"]').count(),0,'Disabled purchase-price column must be absent');
  assert.equal(await staff.locator('#staff-grid .tabulator-col[tabulator-field="sale_price"]').count(),1,'Enabled sale-price column must be visible');
  const quantity=staff.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row .tabulator-cell[tabulator-field="quantity"]').first();
  await quantity.click();
  await staff.locator('#staff-grid input[type="number"]').waitFor({state:'visible',timeout:8000});
  await staff.locator('#staff-grid input[type="number"]').fill('4');
  await staff.locator('#staff-grid input[type="number"]').press('Enter');
  await staff.waitForFunction(()=>document.querySelector('.af-grid-editable')?.textContent?.includes('4'),null,{timeout:8000});
  await staff.screenshot({path:'screenshots/staff-prepare.png',fullPage:true});
  assert.equal(await staff.locator('#staff-print-list:enabled').count(),1,'Prepared list should be printable by staff');
  assert((await staff.evaluate(()=>document.documentElement.scrollWidth-innerWidth))<=2,'Employee mobile layout must not overflow horizontally');
  await staff.locator('.sidebar-toggle').click();
  assert.equal(await staff.locator('[data-nav="users"],[data-nav="quotes"],[data-action="edit-product"]').count(),0,'Staff site cannot reveal management UI');

  assert.equal(errors.length,0,'JavaScript runtime errors: '+errors.join('; '));
  console.log('PASS: separated admin/staff portals, shared Prepare List, role-safe price columns, and responsive mobile/iPad/desktop');
} finally {
  if(browser)await browser.close();
  server.kill('SIGTERM');
}
