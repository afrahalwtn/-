import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const folder=mkdtempSync(path.join(tmpdir(),'afrah-execution-replay-'));
const url='http://127.0.0.1:43941/api';
let child,logs='';
async function start(){
 child=spawn(process.execPath,['--import','tsx','server.ts'],{
  env:{...process.env,SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',
   AFRAH_ADMIN_RESET_PASSWORD:'',AFRAH_ADMIN_PASSWORD:'',AFRAH_STAFF_PASSWORD:'',
   AFRAH_ENABLE_ADMIN_RECOVERY:'',AFRAH_TRUST_PROXY_HOPS:'0',
   NODE_ENV:'development',PORT:'43941',AFRAH_DATA_DIR:folder,AFRAH_SECURE_COOKIES:'false'},
  stdio:['ignore','pipe','pipe']
 });
 child.stdout.on('data',b=>logs+=b.toString());
 child.stderr.on('data',b=>logs+=b.toString());
 for(let i=0;i<65;i++){
  try{if((await fetch(url+'/health')).ok)return;}catch{}
  await delay(200);
 }
 throw Error('Server start failed: '+logs.slice(-1500));
}
async function stop(){
 if(!child)return;
 const p=child;child=null;
 if(p.exitCode!==null||p.signalCode!==null)return;
 const ended=once(p,'exit');
 p.kill('SIGTERM');
 await Promise.race([ended,delay(3500)]);
 if(p.exitCode===null&&p.signalCode===null){
  p.kill('SIGKILL');
  await Promise.race([ended,delay(1000)]);
 }
}
async function session(){
 const response=await fetch(url+'/staff/auth/login',{method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'staff',password:'staff123456'})});
 assert.equal(response.status,200,'Employee login failed');
 const data=await response.json();
 assert.equal(data.user.role,'staff');
 return data;
}
async function post(session,body){
 const response=await fetch(url+'/execution-lists',{method:'POST',
  headers:{'Content-Type':'application/json',
   Authorization:'Bearer '+session.access_token,'X-CSRF-Token':session.csrf},
  body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
try{
 await start();
 let auth=await session();
 const catalogue=await fetch(url+'/products',{headers:{Authorization:'Bearer '+auth.access_token}});
 assert.equal(catalogue.status,200);
 const products=await catalogue.json();
 assert(products.length>0);
 const requestId=crypto.randomUUID();
 const list={client_request_id:requestId,items:[{product_id:products[0].id,quantity:3}]};
 const first=await post(auth,list);
 assert.equal(first.status,201,JSON.stringify(first.body));
 await stop();
 await start();
 auth=await session();
 const replay=await post(auth,list);
 assert.equal(replay.status,201,JSON.stringify(replay.body));
 assert.equal(replay.body.id,first.body.id,'Restarted server duplicated the offline list');
 const altered=await post(auth,{...list,items:[{product_id:products[0].id,quantity:5}]});
 assert.equal(altered.status,409,'A changed list must not be accepted under an old request ID');
 const history=await fetch(url+'/execution-lists',{
  headers:{Authorization:'Bearer '+auth.access_token}});
 assert.equal(history.status,200);
 const rows=await history.json();
 assert.equal(rows.length,1,'Idempotent retries created extra records');
 assert.equal(rows[0].items[0].quantity,3,'The confirmed work list was modified');
 console.log('PASS: offline request de-duplication survives process restart and rejects changed payload');
}finally{
 await stop();
 rmSync(folder,{recursive:true,force:true});
}
