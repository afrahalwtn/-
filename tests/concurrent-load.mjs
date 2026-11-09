// Deterministic isolated simultaneous traffic: never points at a live company database.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const directory=mkdtempSync(path.join(tmpdir(),'afrah-concurrency-'));
const port=45881,root='http://127.0.0.1:'+port+'/api';
const child=spawn(process.execPath,['--import','tsx','server.ts'],{
  env:{...process.env,PORT:String(port),AFRAH_DATA_DIR:directory,
    SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',AFRAH_ADMIN_RESET_PASSWORD:'',
    AFRAH_ADMIN_PASSWORD:'',AFRAH_STAFF_PASSWORD:'',AFRAH_ENABLE_ADMIN_RECOVERY:'',
    AFRAH_TRUST_PROXY_HOPS:'0',NODE_ENV:'test',AFRAH_SECURE_COOKIES:'false'},
  stdio:['ignore','pipe','pipe'],
});
let logs='';
child.stderr.on('data',chunk=>{logs+=chunk.toString().slice(0,1000);});
const call=(endpoint,options={})=>fetch(root+endpoint,{
  signal:AbortSignal.timeout(15000),...options
});
try{
  let ready=false;
  for(let n=0;n<70;n++){
    try{if((await call('/health')).ok){ready=true;break;}}catch{}
    await sleep(200);
  }
  assert(ready,'Isolated server unavailable: '+logs.slice(-600));
  const authResponse=await call('/admin/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'admin',password:'admin123456'})
  });
  assert.equal(authResponse.status,200);
  const admin=await authResponse.json();
  const authHeaders={
    'Content-Type':'application/json',
    Authorization:'Bearer '+admin.access_token,
    'X-CSRF-Token':admin.csrf
  };
  const create=(n)=>call('/products',{method:'POST',headers:authHeaders,
    body:JSON.stringify({name:'اختبار طلبات متزامنة '+n,quantity:10,
      purchase_price:1450,sale_price:2500})});
  const writes=await Promise.all(Array.from({length:50},(_,i)=>create(i)));
  assert(writes.every(r=>r.status===201),
    'All concurrent authorized local writes must commit: '+writes.map(r=>r.status).join(','));
  const items=await Promise.all(writes.map(r=>r.json()));
  assert.equal(new Set(items.map(x=>x.id)).size,50,'Concurrent inserts must never reuse IDs');

  const accountResponse=await call('/users',{
    method:'POST',headers:authHeaders,
    body:JSON.stringify({username:'loadstaff',full_name:'موظف اختبار الضغط',
      password:'LoadTestPassword123!',can_view_purchase:false,can_view_sale:true})
  });
  assert.equal(accountResponse.status,201);
  const login=await call('/staff/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'loadstaff',password:'LoadTestPassword123!'})
  });
  assert.equal(login.status,200);
  const staff=await login.json();
  const staffHeaders={Authorization:'Bearer '+staff.access_token};
  const start=performance.now();
  const requests=await Promise.all(Array.from({length:70},(_,i)=>
    call(i%3===0?'/alerts':'/products',{headers:staffHeaders})
  ));
  const elapsed=performance.now()-start;
  assert(requests.every(r=>r.status===200),
    'Concurrent staff reads must succeed: '+requests.map(r=>r.status).join(','));
  const catalogue=await requests.find(r=>r.url.endsWith('/products')).json();
  assert(catalogue.length>=50,'Staff catalogue must remain consistent under load');
  assert(catalogue.every(p=>!Object.hasOwn(p,'purchase_price')),
    'No hidden purchasing prices may leak during concurrent requests');
  const blocked=await call('/products',{method:'POST',
    headers:{...authHeaders,Authorization:'Bearer '+staff.access_token,
      'X-CSRF-Token':staff.csrf},
    body:JSON.stringify({name:'رفض الموظف'})});
  assert.equal(blocked.status,403,'Simultaneous load cannot bypass admin permissions');
  assert(elapsed<15000,'Concurrent reads exceeded bounded test request time');
  console.log('PASS: 50 concurrent unique inserts, 70 simultaneous reads, role-based pricing and staff write denial. Elapsed ms: '+Math.round(elapsed));
}finally{
  child.kill('SIGTERM');
  await sleep(300);
  rmSync(directory,{recursive:true,force:true});
}
