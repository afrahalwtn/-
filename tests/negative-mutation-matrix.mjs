// Security and resilience input matrix against a disposable local SQLite copy.
// No production Supabase credentials or business data are accessed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
const dir=mkdtempSync(path.join(tmpdir(),'afrah-negative-matrix-'));
const base='http://127.0.0.1:45972/api';
const child=spawn(process.execPath,['--import','tsx','server.ts'],{
 env:{...process.env,PORT:'45972',AFRAH_DATA_DIR:dir,
 SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',AFRAH_ADMIN_RESET_PASSWORD:'',
 AFRAH_ADMIN_PASSWORD:'',AFRAH_STAFF_PASSWORD:'',AFRAH_ENABLE_ADMIN_RECOVERY:'',
 AFRAH_TRUST_PROXY_HOPS:'0',NODE_ENV:'test',AFRAH_SECURE_COOKIES:'false'},
 stdio:['ignore','pipe','pipe'],
});
let errorLog='';
child.stderr.on('data',chunk=>{errorLog+=chunk.toString().slice(0,1200);});
let tested=0;
try{
 let online=false;
 for(let n=0;n<70;n++){
  try{if((await fetch(base+'/health')).ok){online=true;break;}}catch{}
  await pause(160);
 }
 assert(online,'Test app offline: '+errorLog.slice(-1000));
 const login=await fetch(base+'/admin/auth/login',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'admin',password:'admin123456'})
 });
 assert.equal(login.status,200);
 const admin=await login.json();
 const headers={Authorization:'Bearer '+admin.access_token,
  'X-CSRF-Token':admin.csrf,'Content-Type':'application/json'};
 const send=(path,method,data,extra={})=>fetch(base+path,{
  method,headers:{...headers,...extra},
  body:JSON.stringify(data),signal:AbortSignal.timeout(12000)
 });
 const baselineResponse=await fetch(base+'/products',{headers});
 const baseline=await baselineResponse.json();
 // A malformed field must not silently turn negative/NaN/arrays into stock.
 const numbers=[null,false,true,[],{},'','-1','5.25',-10,1e17,'Infinity','1e100','NaN',-0.7,'٥٫٥',2.1];
 for(const value of numbers){
  const response=await send('/products','POST',{name:'فحص غير صالح',quantity:value});
  assert.equal(response.status,422,'Invalid quantity '+JSON.stringify(value));
  tested++;
  const edit=await send('/products/1/stock','PATCH',{quantity:value});
  assert.equal(edit.status,422,'Invalid stock '+JSON.stringify(value));
  tested++;
 }
 const invalidPrices=[null,false,true,[],{},'','-50',-0.1,1e16,'NaN',7.123456,'Infinity'];
 for(const value of invalidPrices){
  const response=await send('/products','POST',{name:'سعر اختبار غير صالح',sale_price:value});
  assert.equal(response.status,422,'Invalid sale price '+JSON.stringify(value));
  tested++;
 }
 const badFields=[
  {item_type:[]},{sku:{}},{length_cm:'Infinity'},
  {weight_g:-1},{purchase_price_usd:'not a price'},
  {custom_fields:{}},{custom_fields:[{label:'',value:'x'}]},
  {custom_fields:[{label:'A',value:'x'},{label:'a',value:'y'}]},
  {custom_fields:[{label:'big',value:'v'.repeat(401)}]},
  {description:123},{manufacture:[]},
 ];
 for(const entry of badFields){
  const response=await send('/products','POST',{name:'مواصفات غير صالحة',...entry});
  assert.equal(response.status,422,'Invalid optional field '+JSON.stringify(Object.keys(entry)));
  tested++;
 }
 const badStaff=[
  {username:'ab',full_name:'User',password:'ValidPassword123'},
  {username:'testA',full_name:'',password:'ValidPassword123'},
  {username:'testB',full_name:'A'.repeat(121),password:'ValidPassword123'},
  {username:'testC',full_name:'User',password:'weak'},
  {username:'testD',full_name:'User',password:'ValidPassword123',can_view_sale:'false'},
  {username:'testE',full_name:'User',password:'ValidPassword123',can_view_purchase:1},
 ];
 for(const entry of badStaff){
  const response=await send('/users','POST',entry);
  assert.equal(response.status,422,'Invalid employee request '+entry.username);
  tested++;
 }
 const afterResponse=await fetch(base+'/products',{headers});
 const after=await afterResponse.json();
 assert.deepEqual(after.map(x=>({id:x.id,quantity:x.quantity})),
  baseline.map(x=>({id:x.id,quantity:x.quantity})),
  'Rejected mutations must leave catalogue and stock unchanged');
 // A missing/altered CSRF token cannot create or edit any item.
 for(const authorization of [undefined,'invalid','0'.repeat(64)]){
  const h={Authorization:'Bearer '+admin.access_token,
   'Content-Type':'application/json'};
  if(authorization!==undefined)h['X-CSRF-Token']=authorization;
  const r=await fetch(base+'/products',{method:'POST',headers:h,
   body:JSON.stringify({name:'CSRF blocked'})});
  assert.equal(r.status,403,'Bad CSRF proof must be rejected');
  tested++;
 }
 const unknown=await fetch(base+'/images/%2e%2e%2f%2e%2e%2fetc%2fpasswd',{headers});
 assert.notEqual(unknown.status,200,'Malformed media path may not be served');
 console.log('PASS: '+tested+' malformed mutations/CSRF cases; no partial catalogue or stock changes');
}finally{
 child.kill('SIGTERM');
 await pause(300);
 rmSync(dir,{force:true,recursive:true});
}
