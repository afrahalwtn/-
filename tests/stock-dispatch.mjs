import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const folder=mkdtempSync(path.join(tmpdir(),'afrah-stock-dispatch-'));
const base='http://127.0.0.1:43961/api';
let child,logs='';
async function start(){
 child=spawn(process.execPath,['--import','tsx','server.ts'],{
  env:{...process.env,SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',
   AFRAH_ADMIN_RESET_PASSWORD:'',AFRAH_ADMIN_PASSWORD:'',AFRAH_STAFF_PASSWORD:'',
   AFRAH_ENABLE_ADMIN_RECOVERY:'',AFRAH_TRUST_PROXY_HOPS:'0',
   NODE_ENV:'development',PORT:'43961',AFRAH_DATA_DIR:folder,AFRAH_SECURE_COOKIES:'false'},
  stdio:['ignore','pipe','pipe']
 });
 child.stdout.on('data',b=>logs+=b.toString());
 child.stderr.on('data',b=>logs+=b.toString());
 for(let i=0;i<80;i++){
  try{if((await fetch(base+'/health')).ok)return;}catch{}
  await delay(200);
 }
 throw Error('No server: '+logs.slice(-1000));
}
async function stop(){
 if(!child)return;
 const c=child;child=null;
 if(c.exitCode!==null||c.signalCode!==null)return;
 const ended=once(c,'exit');c.kill('SIGTERM');
 await Promise.race([ended,delay(3500)]);
 if(c.exitCode===null&&c.signalCode===null){c.kill('SIGKILL');await Promise.race([ended,delay(1000)]);}
}
async function login(){
 const r=await fetch(base+'/staff/auth/login',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'staff',password:'staff123456'})});
 assert.equal(r.status,200);
 return r.json();
}
async function loginAdmin(){
 const r=await fetch(base+'/staff/auth/login',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123456'})});
 assert.equal(r.status,200,'Owner must be able to enter employee portal');
 const auth=await r.json();
 assert.equal(auth.user.role,'admin');
 return auth;
}
async function fetchProducts(auth){
 const r=await fetch(base+'/products',{headers:{Authorization:'Bearer '+auth.access_token}});
 assert.equal(r.status,200);return r.json();
}
async function submit(auth,path,body){
 const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',
  Authorization:'Bearer '+auth.access_token,'X-CSRF-Token':auth.csrf},
  body:JSON.stringify(body)});
 return {status:r.status,body:await r.json()};
}
try{
 await start();
 let auth=await login();
 let products=await fetchProducts(auth);
 const suitable=products.filter(x=>x.quantity>=3).slice(0,2);
 assert.equal(suitable.length,2);
 const selected=suitable.map(p=>({product_id:p.id,quantity:2}));
 const request={client_request_id:crypto.randomUUID(),items:selected};
 const first=await submit(auth,'/execution-lists/dispatch',request);
 assert.equal(first.status,201,JSON.stringify(first.body));
 assert.equal(first.body.stock_deducted,true);
 assert.equal(first.body.items.length,2);
 products=await fetchProducts(auth);
 for(const before of suitable){
  assert.equal(products.find(p=>p.id===before.id).quantity,before.quantity-2);
 }
 const again=await submit(auth,'/execution-lists/dispatch',request);
 assert.equal(again.status,201);
 assert.equal(again.body.id,first.body.id);
 const repeated=await fetchProducts(auth);
 for(const before of suitable)assert.equal(repeated.find(p=>p.id===before.id).quantity,before.quantity-2);
 const changed=await submit(auth,'/execution-lists/dispatch',{...request,
  items:[{...selected[0],quantity:3},selected[1]]});
 assert.equal(changed.status,409,'Changed idempotency payload was accepted');
 const shortage=await submit(auth,'/execution-lists/dispatch',{
  client_request_id:crypto.randomUUID(),
  items:[{product_id:suitable[0].id,quantity:1},
   {product_id:suitable[1].id,quantity:suitable[1].quantity+1}]
 });
 assert.equal(shortage.status,409,'Stock overdraw was accepted');
 const afterShortage=await fetchProducts(auth);
 for(const before of suitable)assert.equal(afterShortage.find(p=>p.id===before.id).quantity,before.quantity-2,
  'Partial stock deduction occurred on insufficient list');
 const simple=await submit(auth,'/execution-lists',{
  items:[{product_id:suitable[0].id,quantity:1}],client_request_id:crypto.randomUUID()});
 assert.equal(simple.status,201);
 assert.equal(simple.body.stock_deducted,undefined);
 const afterHistorical=await fetchProducts(auth);
 assert.equal(afterHistorical.find(p=>p.id===suitable[0].id).quantity,suitable[0].quantity-2,
  'Historical non-deducting list changed inventory');
 // Administrators operating from the staff-facing portal may also dispatch.
 const manager=await loginAdmin();
 const beforeOwner=await fetchProducts(manager);
 const managerTarget=beforeOwner.find(p=>p.id===suitable[0].id);
 assert(managerTarget.quantity>=1);
 const managerRequest={client_request_id:crypto.randomUUID(),
  items:[{product_id:managerTarget.id,quantity:1}]};
 const ownerSave=await submit(manager,'/execution-lists/dispatch',managerRequest);
 assert.equal(ownerSave.status,201,JSON.stringify(ownerSave.body));
 assert.equal(ownerSave.body.stock_deducted,true);
 const afterOwner=await fetchProducts(manager);
 assert.equal(afterOwner.find(p=>p.id===managerTarget.id).quantity,managerTarget.quantity-1);
 const ownerRetry=await submit(manager,'/execution-lists/dispatch',managerRequest);
 assert.equal(ownerRetry.body.id,ownerSave.body.id);
 await stop();await start();auth=await login();
 const replay=await submit(auth,'/execution-lists/dispatch',request);
 assert.equal(replay.status,201);
 assert.equal(replay.body.id,first.body.id,'Stock was recorded twice after restart');
 const last=await fetchProducts(auth);
 for(const before of suitable)assert.equal(last.find(p=>p.id===before.id).quantity,
    before.quantity-2-(before.id===managerTarget.id?1:0));
 console.log('PASS: 2-item atomic decrement, idempotency, rollback on shortage, no-op preview, restart replay');
}finally{await stop();rmSync(folder,{recursive:true,force:true});}
