import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
const folder=mkdtempSync(path.join(tmpdir(),'afrah-sec-test-'));
const port=45671,root='http://127.0.0.1:'+port+'/api';
const child=spawn(process.execPath,['--import','tsx','server.ts'],{
 env:{...process.env,PORT:String(port),AFRAH_DATA_DIR:folder,
 SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',AFRAH_ADMIN_RESET_PASSWORD:'',AFRAH_ADMIN_PASSWORD:'',AFRAH_STAFF_PASSWORD:'',AFRAH_ENABLE_ADMIN_RECOVERY:'',AFRAH_TRUST_PROXY_HOPS:'0',NODE_ENV:'development',AFRAH_SECURE_COOKIES:'false'},
 stdio:['ignore','pipe','pipe']
});
let log='';child.stderr.on('data',x=>log+=x.toString());
try {
 let ready=false;
 for(let i=0;i<80;i++){
  try{if((await fetch(root+'/health')).ok){ready=true;break;}}catch{}
  await pause(200);
 }
 assert(ready,'Test server unavailable: '+log.slice(-500));
 const health=await fetch(root+'/health');
 assert.equal(health.headers.get('x-content-type-options'),'nosniff');
 assert(health.headers.has('ratelimit'),'API must declare its rate limit');
 const login=await fetch(root+'/admin/auth/login',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'admin',password:'admin123456'})
 });
 assert.equal(login.status,200);
 const admin=await login.json();
 let r=await fetch(root+'/auth/login',{method:'POST',
  headers:{'Content-Type':'application/json'},body:'{'});
 assert.equal(r.status,400);
 assert.equal((await r.json()).detail,'صيغة الطلب غير صحيحة');
 r=await fetch(root+'/auth/login',{method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'a'.repeat(300000),password:'bad'})});
 assert.equal(r.status,413,'Oversized JSON must be rejected early');
 // Malformed/oversized credentials are rejected without expensive password hashing.
 r=await fetch(root+'/auth/login',{method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'admin',password:'x'.repeat(25000)})});
 assert.equal(r.status,401,'Very long login passwords must be rejected cheaply');
 r=await fetch(root+'/auth/login',{method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:{nested:'admin'},password:'x'})});
 assert.equal(r.status,401,'Object usernames must not be accepted');

 // Business-input regressions: never coerce invalid numbers to zero or one.
 const itemCall=(route,method,data)=>fetch(root+route,{
  method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+admin.access_token,
   'X-CSRF-Token':admin.csrf},
  body:JSON.stringify(data),
 });
 for(const payload of [
  {name:'مخزون سلبي',quantity:-10,sale_price:100},
  {name:'عدد كسري',quantity:1.5,sale_price:100},
  {name:'سعر سلبي',quantity:1,sale_price:-100},
  {name:'سعر غير محدود',quantity:1,sale_price:1e20},
  {name:'سعر كسري طويل',quantity:1,sale_price:10.1234},
 ]) {
  r=await itemCall('/products','POST',payload);
  assert.equal(r.status,422,'Invalid catalogue data must be rejected');
 }
 r=await itemCall('/products','POST',{name:'وصف طويل',description:'و'.repeat(4500)});
 assert.equal(r.status,422,'Oversized product description should fail before storage');
 r=await itemCall('/users','POST',{username:'newstaff',full_name:'X'.repeat(130),password:'strong-password-123'});
 assert.equal(r.status,422,'Oversized employee display name should be rejected');
 r=await itemCall('/products','POST',{name:'أيتم اختبار',quantity:12,
  min_quantity:3,purchase_price:800,sale_price:1500});
 assert.equal(r.status,201,'Valid item must still be accepted');
 const item=await r.json();
 r=await itemCall('/products/'+item.id+'/stock','PATCH',{quantity:-1});
 assert.equal(r.status,422,'Stock cannot go negative');
 r=await itemCall('/products/'+item.id+'/stock','PATCH',{quantity:1.25});
 assert.equal(r.status,422,'Stock must be a whole count');
 r=await itemCall('/products/'+item.id,'PUT',{sale_price:-5});
 assert.equal(r.status,422,'Edits cannot silently clamp negative prices');
 for(const entries of [
  [{product_id:item.id,quantity:0}],
  [{product_id:item.id,quantity:-2}],
  [{product_id:item.id,quantity:1.5}],
  [{product_id:item.id,quantity:1e20}],
  [{product_id:item.id,quantity:2},{product_id:item.id,quantity:1}],
 ]) {
  r=await itemCall('/quotes','POST',{items:entries});
  assert.equal(r.status,422,'Invalid quote must not be committed');
 }
 r=await itemCall('/quotes','POST',{items:[{product_id:item.id,quantity:2}]});
 assert.equal(r.status,201,'Valid quotes still work');
 assert.equal((await r.json()).total,3000);
 const file=new FormData();
 file.set('file',new Blob(['not a real image'],{type:'image/png'}),'f.png');
 r=await fetch(root+'/products/1/image',{method:'POST',
  headers:{Authorization:'Bearer '+admin.access_token,'X-CSRF-Token':admin.csrf},
  body:file});
 assert.equal(r.status,422,'Spoofed image bytes must be rejected');
 // Multer saves a file before checking whether the target item exists.
 // A missing item must not leave orphan files in the local upload directory.
 const beforeMissingUpload=readdirSync(path.join(folder,'images')).length;
 const validPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
 const orphanForm=new FormData();
 orphanForm.set('file',new Blob([validPng],{type:'image/png'}),'orphan.png');
 r=await fetch(root+'/products/999999/image',{method:'POST',
  headers:{Authorization:'Bearer '+admin.access_token,'X-CSRF-Token':admin.csrf},body:orphanForm});
 assert.equal(r.status,404,'Missing item must reject image upload');
 assert.equal(readdirSync(path.join(folder,'images')).length,beforeMissingUpload,
  'Rejected upload must not leak temporary files');
 for(let i=0;i<28;i++){
  r=await fetch(root+'/auth/login',{method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({username:'admin',password:'not-the-password'})});
 }
 assert.equal(r.status,429,'Login abuse must be rate limited');
 console.log('PASS: headers, limits, safe parser error, MIME verification, login rate limiting');
} finally{
 child.kill('SIGTERM');
 await pause(300);
 rmSync(folder,{force:true,recursive:true});
}
