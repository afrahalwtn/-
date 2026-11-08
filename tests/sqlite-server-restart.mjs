import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const folder=mkdtempSync(path.join(tmpdir(),'afrah-reboot-'));
let serverLogs='';
const address='http://127.0.0.1:43881/api';
let processHandle;
const open=async()=>{
 processHandle=spawn(process.execPath,['--import','tsx','server.ts'],{
  env:{...process.env,SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',AFRAH_ADMIN_RESET_PASSWORD:'',AFRAH_ADMIN_PASSWORD:'',AFRAH_STAFF_PASSWORD:'',AFRAH_ENABLE_ADMIN_RECOVERY:'',AFRAH_TRUST_PROXY_HOPS:'0',NODE_ENV:'development',PORT:'43881',AFRAH_DATA_DIR:folder,AFRAH_SECURE_COOKIES:'false'},
  stdio:['ignore','pipe','pipe']
 });
 processHandle.stdout.on('data',part=>serverLogs+=part.toString());
 processHandle.stderr.on('data',part=>serverLogs+=part.toString());
 for(let n=0;n<60;n++){
  try{if((await fetch(address+'/health')).ok)return;}catch{}
  await delay(250);
 }
 throw Error('Local backend not ready. Exit='+processHandle?.exitCode+'; Logs='+serverLogs.slice(-4000));
};
const close=async()=>{
 const p=processHandle;
 if(!p)return;
 processHandle=null;
 if(p.exitCode!==null||p.signalCode!==null)return;
 const exited=once(p,'exit');
 p.kill('SIGTERM');
 await Promise.race([exited,delay(4000)]);
 if(p.exitCode===null&&p.signalCode===null){
  p.kill('SIGKILL');
  await Promise.race([exited,delay(1000)]);
 }
};
const login=async()=>{
 const response=await fetch(address+'/auth/login',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'admin',password:'admin123456'})
 });
 assert.equal(response.status,200);
 return response.json();
};
try{
 await open();
 const session=await login();
 const response=await fetch(address+'/products',{
  method:'POST',
  headers:{Authorization:'Bearer '+session.access_token,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},
  body:JSON.stringify({name:'أقداح ورقية تجريبية',description:'علبة',manufacture:'عراقي',quantity:34,min_quantity:8,purchase_price:500,sale_price:700})
 });
 assert.equal(response.status,201);
 const created=await response.json();
 await close();
 await open();
 const renewed=await login();
 const found=await fetch(address+'/products?q='+encodeURIComponent('اقداح ورقيه'),{
  headers:{Authorization:'Bearer '+renewed.access_token}
 });
 assert.equal(found.status,200);
 const products=await found.json();
 assert(products.some(p=>p.id===created.id&&p.quantity===34&&p.sale_price===700),'Product and stock must survive a real server restart');
 console.log('PASS real server restart: SQLite product, stock, and Arabic search remain available');
}finally{
 if(processHandle)await close();
 rmSync(folder,{recursive:true,force:true});
}
