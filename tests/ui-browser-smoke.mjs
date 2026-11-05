import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const executablePath=[
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].find(x=>x && existsSync(x));
assert(executablePath,'Chromium/Chrome was not found on the CI runner');
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

  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.locator('form[data-form="login"]').waitFor();
  const loginBg=await page.locator('.auth-preview').evaluate(el=>getComputedStyle(el).backgroundColor);
  assert(['rgba(0, 0, 0, 0)','transparent'].includes(loginBg),'Logo has an added background card: '+loginBg);
  await page.locator('input[name="username"]').fill('admin');
  await page.locator('input[name="password"]').fill('admin123456');
  await page.locator('button[type="submit"]').click();
  await page.locator('.af-home').waitFor({timeout:15000});
  assert.equal(await page.locator('.af-welcome').count(),1);
  assert.equal(await page.locator('.af-home-search').count(),1);
  assert.equal(await page.locator('.af-home-alerts').count(),1);
  assert.equal(await page.locator('.koa-stats').count(),0,'Home must not include dashboard stat cards');
  assert.equal(await page.locator('.nav-link[data-section="quotes"]').count(),1);

  await page.locator('#home-search').fill('رول');
  await page.locator('.search-product').first().waitFor();
  await page.locator('.quote-add-result').first().click();
  await page.locator('#quote-search').waitFor();
  assert.equal(await page.locator('.af-receipt-item').count(),1,'First material should be on receipt');

  await page.locator('#quote-search').fill('علب');
  await page.locator('.quote-add-result').first().waitFor();
  await page.locator('.quote-add-result').first().click();
  assert.equal(await page.locator('.af-receipt-item').count(),2,'Second search should append rather than replace the first');
  await page.locator('[data-action="quote-increase"]').first().click();
  assert.equal(await page.locator('.af-qty-input').first().inputValue(),'2','Quantity adjustment must update receipt');
  assert.equal(await page.locator('.af-receipt-product').count(),2);
  assert(await page.locator('.af-receipt-product p').first().textContent(),'Receipt must display description');
  assert(await page.locator('.af-receipt-price').first().textContent(),'Receipt must display item price');
  await page.locator('[data-action="quote-create"]').click();
  await page.locator('.quote-preview').waitFor({timeout:15000});
  assert.equal(await page.locator('.quote-preview tbody tr').count(),2,'Saved quotation must contain both items');

  // Navigation should not overflow the mobile screen.
  const mobileWidth=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
  assert(mobileWidth.scroll<=mobileWidth.width+2,'Mobile layout overflows: '+JSON.stringify(mobileWidth));

  const desktop=await browser.newPage({viewport:{width:1366,height:768}});
  desktop.on('pageerror',e=>errors.push(e.message));
  await desktop.goto(base+'/',{waitUntil:'domcontentloaded'});
  await desktop.locator('form[data-form="login"]').waitFor();
  await desktop.locator('input[name="username"]').fill('admin');
  await desktop.locator('input[name="password"]').fill('admin123456');
  await desktop.locator('button[type="submit"]').click();
  await desktop.locator('.af-home').waitFor({timeout:15000});
  const deskWidth=await desktop.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
  assert(deskWidth.scroll<=deskWidth.width+2,'Desktop layout overflows: '+JSON.stringify(deskWidth));
  assert.equal(errors.length,0,'JavaScript runtime errors: '+errors.join('; '));
  console.log('PASS: mobile/desktop login, home-only layout, multi-search receipt, quantities, quote save, no overflow or JS errors');
} finally {
  if(browser)await browser.close();
  server.kill('SIGTERM');
}
