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
 const context=await browser.newContext({viewport:{width:1200,height:900},serviceWorkers:'allow'});
 const page=await context.newPage();
 const errors=[];
 page.on('pageerror',err=>errors.push(err.message));
 await page.goto(origin+'/',{waitUntil:'load'});
 await page.locator('#staff-login input[name=username]').fill('staff');
 await page.locator('#staff-login input[name=password]').fill('staff123456');
 await page.locator('#staff-login button[type=submit]').click();
 await page.locator('.af-home').waitFor({timeout:15000});
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
 const controlled=await page.evaluate(()=>Boolean(navigator.serviceWorker.controller));
 assert(controlled,'Offline shell must control tab before enabling local vault');
 await page.locator('[data-nav="account"]').click();
 await page.locator('#staff-offline-enable').waitFor();
 await page.locator('#staff-offline-enable [name=passphrase]').fill('Test phrase only 987654');
 await page.locator('#staff-offline-enable button[type=submit]').click();
 await page.locator('#staff-toast').getByText('جهزنا نسخة', {exact:false}).waitFor({timeout:10000});
 await page.locator('[data-nav="prepare"]').click();
 await page.locator('#staff-prepare-search').fill('رول');
 await page.locator('.staff-add-to-list').first().click();
 await page.locator('#staff-grid .tabulator-row').first().waitFor();
 await page.waitForTimeout(250);
 const cached=await page.evaluate(async()=>{
  const names=await caches.keys();
  const entries=(await Promise.all(names.map(n=>caches.open(n).then(c=>c.keys())))).flat();
  return {names,urls:entries.map(e=>new URL(e.url).pathname)};
 });
 assert(cached.names.some(x=>x.startsWith('afrah-static-')),'PWA static cache missing');
 assert(!cached.urls.some(url=>url.startsWith('/api/')),'Protected API cached in service worker');
 await context.setOffline(true);
 await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('#staff-offline-unlock').waitFor({timeout:12000});
 await page.locator('#staff-offline-unlock [name=passphrase]').fill('Test phrase only 987654');
 await page.locator('#staff-offline-unlock button').click();
 await page.locator('.af-offline-banner').waitFor({timeout:12000});
 await page.locator('[data-nav="prepare"]').click();
 await page.locator('#staff-grid .tabulator-row').first().waitFor({timeout:12000});
 let savedRequests=0;
 page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/execution-lists'))savedRequests++;});
 await page.locator('#staff-save-list').click();
 await page.locator('#staff-toast').getByText('لم تُرسل للخادم',{exact:false}).waitFor({timeout:7000});
 assert.equal(savedRequests,0,'Offline draft must not send mutation requests');
 assert.equal(await page.locator('#staff-grid .tabulator-row').count(),1,'Offline draft was lost');
 await context.setOffline(false);
 await page.locator('#staff-reconnect').click();
 await page.locator('.af-offline-banner').waitFor({state:'detached',timeout:15000});
 assert.equal(await page.locator('#staff-grid .tabulator-row').count(),1,'Draft lost on reconnect');
 await page.locator('#staff-save-list').click();
 await page.locator('.staff-history-entry').first().waitFor({timeout:15000});
 assert.equal(errors.length,0,'Client errors: '+errors.join('; '));
 await context.close();
 console.log('PASS: PWA, encrypted snapshot, offline reload and draft, explicit reconnect, no cached API');
}finally{
 await browser?.close();
 server.kill('SIGTERM');
 await delay(150);
 rmSync(dir,{recursive:true,force:true});
}
