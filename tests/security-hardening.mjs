import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
const folder=mkdtempSync(path.join(tmpdir(),'afrah-sec-test-'));
const port=45671,root='http://127.0.0.1:'+port+'/api';
const child=spawn(process.execPath,['--import','tsx','server.ts'],{
 env:{...process.env,PORT:String(port),AFRAH_DATA_DIR:folder,
 SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',AFRAH_SECURE_COOKIES:'false'},
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
 const file=new FormData();
 file.set('file',new Blob(['not a real image'],{type:'image/png'}),'f.png');
 r=await fetch(root+'/products/1/image',{method:'POST',
  headers:{Authorization:'Bearer '+admin.access_token,'X-CSRF-Token':admin.csrf},
  body:file});
 assert.equal(r.status,422,'Spoofed image bytes must be rejected');
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
