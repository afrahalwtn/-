import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';

const executablePath=[
 process.env.CHROME_BIN,'/usr/bin/google-chrome',
 '/usr/bin/google-chrome-stable','/usr/bin/chromium'
].find(value=>value&&existsSync(value));
if(!executablePath){
 if(process.env.GITHUB_ACTIONS==='true')throw Error('Chromium required in CI');
 console.log('SKIP: Chromium not installed');
 process.exit(0);
}
const dir=mkdtempSync(path.join(tmpdir(),'afrah-offline-'));
const port=43231,origin='http://127.0.0.1:'+port;
const server=spawn(process.execPath,['--import','tsx','server.ts'],{
 env:{...process.env,SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',
 AFRAH_ADMIN_RESET_PASSWORD:'',AFRAH_ADMIN_PASSWORD:'',AFRAH_STAFF_PASSWORD:'',
 AFRAH_ENABLE_ADMIN_RECOVERY:'',AFRAH_TRUST_PROXY_HOPS:'0',
 NODE_ENV:'development',AFRAH_DATA_DIR:dir,PORT:String(port),AFRAH_SECURE_COOKIES:'false'},
 stdio:['ignore','pipe','pipe']
});
let logs='',browser;
server.stdout.on('data',d=>logs+=d.toString());
server.stderr.on('data',d=>logs+=d.toString());
try{
 let ready=false;
 for(let i=0;i<60;i++){
  try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}
  await delay(250);
 }
 assert(ready,'Local server did not start: '+logs);
 browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
 const adminContext=await browser.newContext({serviceWorkers:'allow'});
 const admin=await adminContext.newPage();
 const errors=[];
 admin.on('pageerror',error=>errors.push('admin: '+error.message));
 await admin.goto(origin+'/admin',{waitUntil:'load'});
 await admin.locator('[data-form=login] [name=username]').fill('admin');
 await admin.locator('[data-form=login] [name=password]').fill('admin123456');
 await admin.locator('[data-form=login] button[type=submit]').click();
 await admin.locator('.af-home').waitFor({timeout:15000});
 await admin.locator('.nav-link[data-section=account]').click();
 const toggle=admin.locator('[data-action=offline-toggle]');
 await toggle.waitFor();
 assert((await toggle.textContent()).includes('تشغيل الأوفلاين'),'Global policy defaults OFF');
 assert.equal(await admin.locator('[name=passphrase]').count(),0,'Admin must not enter an offline password');
 await toggle.click();
 await admin.waitForFunction(()=>document.querySelector('[data-action=offline-toggle]')?.textContent?.includes('إيقاف الأوفلاين'),null,{timeout:15000});
 const status=await admin.evaluate(async()=>await(await fetch('/api/offline-mode')).json());
 assert.equal(status.enabled,true,'Admin switch must persist enabled policy');

  // Administrator can move between both cached portals when the site has no internet.
  await admin.waitForFunction(()=>Boolean(navigator.serviceWorker.controller),null,{timeout:15000});
  await adminContext.setOffline(true);
  await admin.reload({waitUntil:'domcontentloaded'});
  await admin.locator('.af-offline-banner').waitFor({timeout:15000});
  await admin.locator('.af-account-trigger').click();
  await admin.locator('[data-action="switch-staff"]').click();
  await admin.locator('#staff-workspace .af-home').waitFor({timeout:15000});
  assert.equal(await admin.locator('.af-offline-banner').count(),1,
    'Staff portal must stay offline after switching without internet');
  await admin.locator('.af-account-trigger').click();
  await admin.locator('[data-switch="admin"]').click();
  await admin.locator('#workspace .af-home').waitFor({timeout:15000});
  assert.equal(await admin.locator('.af-offline-banner').count(),1,
    'Return to administration must work without cloud handoff');
  await adminContext.setOffline(false);
  await admin.reload({waitUntil:'domcontentloaded'});
  await admin.locator('.af-home').waitFor({timeout:15000});


 const context=await browser.newContext({viewport:{width:1200,height:900},serviceWorkers:'allow'});
 const page=await context.newPage();
 page.on('pageerror',error=>errors.push('staff: '+error.message));
 await page.goto(origin+'/',{waitUntil:'load'});
 await page.locator('#staff-login input[name=username]').fill('staff');
 await page.locator('#staff-login input[name=password]').fill('staff123456');
 await page.locator('#staff-login button[type=submit]').click();
 await page.locator('.af-home').waitFor({timeout:15000});
 await page.locator('.af-offline-readiness').waitFor({timeout:10000});
 assert((await page.locator('.af-offline-readiness').textContent()).includes('جاهز للعمل بدون إنترنت'));

 assert.equal(await page.locator('[name=passphrase],#staff-offline-enable,#staff-offline-unlock').count(),0,
  'Staff must never see offline unlock or setup controls');
 // Even a signed-in staff user with a real CSRF token cannot change the switch.
 const forbidden=await page.evaluate(async()=>{
  const session=await(await fetch('/api/me',{credentials:'include'})).json();
  const response=await fetch('/api/offline-mode',{
   method:'POST',credentials:'include',
   headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},
   body:JSON.stringify({enabled:false})
  });
  return response.status;
 });
 assert.equal(forbidden,403,'Only management may flip offline availability');
 await page.evaluate(async()=>navigator.serviceWorker.ready);
 assert(await page.evaluate(()=>Boolean(navigator.serviceWorker.controller)));
 // Verify the company-wide setting created this device's snapshot before disconnecting.
 await page.waitForFunction(async()=>{
  try{
   const {makeOfflineVault}=await import('/web/offline-vault.js');
   return await makeOfflineVault('staff').hasSnapshot();
  }catch{return false;}
 },null,{timeout:15000});
 await page.locator('[data-nav=prepare]').click();
 await page.locator('#staff-prepare-search').fill('رول');
 await page.locator('.staff-add-to-list').first().click();
 await page.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').first().waitFor();
 // local snapshot save is async after first login; pause only for deterministic test.
 await page.waitForTimeout(350);
 const cache=await page.evaluate(async()=>{
  const names=await caches.keys();
  const entries=(await Promise.all(names.map(x=>caches.open(x).then(c=>c.keys())))).flat();
  return {names,urls:entries.map(x=>new URL(x.url).pathname)};
 });
 assert(cache.names.some(x=>x.startsWith('afrah-static-')));
 assert(!cache.urls.some(url=>url.startsWith('/api/')),'Protected API cached by PWA');
 await context.setOffline(true);
 await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('.af-offline-banner').waitFor({timeout:15000});
 assert.equal(await page.locator('[name=passphrase]').count(),0,'Offline user must not see a code request');
 await page.locator('[data-nav=prepare]').click();
 await page.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').first().waitFor();
 let offlineWrites=0;
 page.on('request',req=>{if(req.method()==='POST'&&req.url().endsWith('/api/execution-lists'))offlineWrites++;});
 // The first offline save must become a separate encrypted list, not one draft.
 await page.locator('#staff-save-list').click();
 await page.waitForFunction(()=>document.querySelectorAll('.af-offline-outbox .staff-history-entry').length===1);
 assert.equal(await page.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').count(),0);
 // Create a SECOND list without internet.
 await page.locator('#staff-prepare-search').fill('علب');
 await page.locator('.staff-add-to-list').first().click();
 await page.locator('#staff-grid .tabulator-tableholder .tabulator-table .tabulator-row').first().waitFor();
 await page.locator('#staff-save-list').click();
 await page.waitForFunction(()=>document.querySelectorAll('.af-offline-outbox .staff-history-entry').length===2);
 assert.equal(offlineWrites,0,'Offline saves must never contact server');
 await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('.af-offline-banner').waitFor({timeout:12000});
 await page.locator('[data-nav=prepare]').click();
 assert.equal(await page.locator('.af-offline-outbox .staff-history-entry').count(),2,'Offline lists lost after restart');
 // The automatic reconnect checks authentication, sends each durable local list,
 // then removes it from the device only after a server-confirmed response.
 await context.setOffline(false);
 await page.locator('.af-offline-banner').waitFor({state:'detached',timeout:16000});
 await page.waitForFunction(()=>document.querySelectorAll('.af-offline-outbox .staff-history-entry').length===0
   &&document.querySelectorAll('.staff-execution-history .staff-history-entry').length>=2,
   null,{timeout:25000});
 const transferred=await page.evaluate(async()=>{
  const response=await fetch('/api/execution-lists',{credentials:'include',cache:'no-store'});
  if(!response.ok)throw Error('Failed to verify uploaded lists');
  return response.json();
 });
 assert.equal(transferred.length,2,'Exactly two distinct offline lists should reach the server');
 // Server must be idempotent if a prior upload succeeded but the response was lost.
 const replay=await page.evaluate(async()=>{
  const session=await(await fetch('/api/me',{credentials:'include'})).json();
  const products=await(await fetch('/api/products',{credentials:'include'})).json();
  const body=JSON.stringify({items:[{product_id:products[0].id,quantity:2}],
    client_request_id:crypto.randomUUID()});
  const upload=()=>fetch('/api/execution-lists',{method:'POST',credentials:'include',
    headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body});
  const first=await upload(),a=await first.json();
  const second=await upload(),b=await second.json();
  return {first:first.status,second:second.status,ids:[a.id,b.id]};
 });
 assert.equal(replay.first,201);
 assert.equal(replay.second,201);
 assert.equal(replay.ids[0],replay.ids[1],'Offline upload replay duplicated a list');
 // Turning OFF is central; devices clear encrypted snapshots when online again.
 await toggle.click();
 await admin.waitForFunction(()=>document.querySelector('[data-action=offline-toggle]')?.textContent?.includes('تشغيل الأوفلاين'),null,{timeout:15000});
 await page.reload({waitUntil:'load'});
 await page.locator('.af-home').waitFor({timeout:15000});
 assert.equal(await page.locator('.af-offline-banner').count(),0);
 await context.setOffline(true);
 await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('#staff-login').waitFor({timeout:15000});
 assert.equal(await page.locator('.af-offline-banner').count(),0,'Disabled switch must not open cached user data on this refreshed device');

 assert.equal(errors.length,0,'Browser errors: '+errors.join('; '));
 await context.close();await adminContext.close();
 console.log('PASS: admin toggle, no codes, 2 persisted offline lists, reconnect auto-sync, idempotent retries, admin disable');
}finally{
 await browser?.close();
 server.kill('SIGTERM');
 await delay(150);
 rmSync(dir,{recursive:true,force:true});
}
