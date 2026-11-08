import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const store = new Map();
const imageStore = new Map();
const secret='sb_secret_mock_000000000000000';
const mockPort=44882,appPort=44883;
const root='http://127.0.0.1:'+appPort+'/api';
const folder=mkdtempSync(path.join(tmpdir(),'afrah-cloud-test-'));
let mockFailWrites=false,mockTransientFailures=0,proc,logs='';
let cloudLoadPages=0;
let recoverySecret='';
const mock=http.createServer(async (req,res)=>{
  if(req.headers.apikey!==secret || req.headers.authorization?.includes('sb_secret_')){
    res.writeHead(401);res.end('Unauthorized');return;
  }
  const u=new URL(req.url||'/', 'http://127.0.0.1:'+mockPort);
  if(u.pathname==='/rest/v1/app_records'){
    if(req.method==='GET'){
      cloudLoadPages++;
      let all=Array.from(store.values()).sort((a,b)=>a.kind.localeCompare(b.kind)||a.id-b.id);
      const kind=(u.searchParams.get('kind')||'').replace(/^eq\./,'');
      const id=(u.searchParams.get('id')||'').replace(/^eq\./,'');
      const sessionHash=(u.searchParams.get('payload->>token_hash')||'').replace(/^eq\./,'');
      if(kind)all=all.filter(row=>row.kind===kind);
      if(id)all=all.filter(row=>row.id===Number(id));
      if(sessionHash)all=all.filter(row=>row.payload?.token_hash===sessionHash);
      const offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||500);
      const select=u.searchParams.get('select');
      const filtered=all.slice(offset,offset+limit).map(row=>
        select==='payload'?{payload:row.payload}:row);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(filtered));
      return;
    }
    if(mockFailWrites||mockTransientFailures>0){
      if(mockTransientFailures>0)mockTransientFailures--;
      res.writeHead(503);res.end('Unavailable');return;
    }
    if(req.method==='POST'){
      let body='';for await(const ch of req)body+=ch;
      const items=JSON.parse(body);
      if(items.some(row=>store.has(row.kind+':'+row.id))){
        res.writeHead(409);res.end('Duplicate key');return;
      }
      const stamped=items.map(row=>({...row,updated_at:new Date().toISOString()}));
      for(const row of stamped)store.set(row.kind+':'+row.id,row);
      res.writeHead(201,{'content-type':'application/json'});
      res.end(JSON.stringify(stamped));return;
    }
    if(req.method==='PATCH'||req.method==='DELETE'){
      const kind=(u.searchParams.get('kind')||'').replace(/^eq\./,'');
      const id=Number((u.searchParams.get('id')||'').replace(/^eq\./,''));
      const sessionHash=(u.searchParams.get('payload->>token_hash')||'').replace(/^eq\./,'');
      if(req.method==='DELETE' && sessionHash){
        for(const [recordKey,row] of store){
          if(row.kind==='sessions'&&row.payload?.token_hash===sessionHash)store.delete(recordKey);
        }
        res.writeHead(204);res.end();return;
      }
      const version=(u.searchParams.get('updated_at')||'').replace(/^eq\./,'');
      const key=kind+':'+id,record=store.get(key);
      if(!record||record.updated_at!==version){
        res.writeHead(200,{'content-type':'application/json'});res.end('[]');return;
      }
      if(req.method==='PATCH'){
        let body='';for await(const ch of req)body+=ch;
        const updates=JSON.parse(body);
        const next={...record,...updates,kind,id};
        store.set(key,next);
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify([next]));return;
      }
      store.delete(key);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify([record]));return;
    }
  }
  if(u.pathname.startsWith('/storage/v1/object/item-images/')){
    const filename=decodeURIComponent(u.pathname.split('/').at(-1));
    if(req.method==='POST'){
      let data=[];for await(const chunk of req)data.push(chunk);
      imageStore.set(filename,Buffer.concat(data));
      res.writeHead(200);res.end('{}');return;
    }
    if(req.method==='GET'){
      const image=imageStore.get(filename);
      if(!image){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'content-type':'image/png'});res.end(image);return;
    }
  }
  res.writeHead(404);res.end('not-found');
});
const start=async()=>{
  proc=spawn(process.execPath,['--import','tsx','server.ts'],{
    env:{...process.env,PORT:String(appPort),AFRAH_DATA_DIR:folder,
      SUPABASE_URL:'http://127.0.0.1:'+mockPort,
      SUPABASE_SECRET_KEY:secret,
      AFRAH_ADMIN_PASSWORD:'CloudTestOnly.Admin.2026',
      AFRAH_STAFF_PASSWORD:'CloudTestOnly.Staff.2026',
      AFRAH_ADMIN_RESET_PASSWORD:recoverySecret,
      AFRAH_SECURE_COOKIES:'false',
      NODE_ENV:'test'},
    stdio:['ignore','pipe','pipe']
  });
  proc.stdout.on('data',x=>logs+=x.toString());
  proc.stderr.on('data',x=>logs+=x.toString());
  for(let i=0;i<90;i++){
    if(proc.exitCode!==null)break;
    try{const r=await fetch(root+'/health');if(r.ok)return;}catch{}
    await delay(180);
  }
  throw Error('Cloud backend failed startup: '+logs.slice(-6000));
};
const stop=async()=>{
  const p=proc;if(!p)return;proc=null;
  if(p.exitCode!==null||p.signalCode!==null)return;
  const ended=once(p,'exit');p.kill('SIGTERM');
  await Promise.race([ended,delay(4000)]);
  if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');
};
const signIn=async(username,password)=>{
  const r=await fetch(root+'/auth/login',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username,password})});
  if(r.status!==200)throw Error('login '+username+' failed: HTTP '+r.status+' / '+await r.text());
  assert.match(r.headers.get('set-cookie')||'',/Max-Age=31536000/,'Remember cookie must last up to one year');
  return r.json();
};
const api=async(route,session,method='GET',data)=>{
  const headers={Authorization:'Bearer '+session.access_token};
  if(method!=='GET'){headers['X-CSRF-Token']=session.csrf;headers['Content-Type']='application/json';}
  return fetch(root+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
};
try{
  await new Promise(resolve=>mock.listen(mockPort,'127.0.0.1',resolve));
  await start();
  let admin=await signIn('يوسف','CloudTestOnly.Admin.2026');
  assert([...store.values()].some(row=>row.kind==='sessions'&&
    row.payload.expires_at===Number.MAX_SAFE_INTEGER),
    'Cloud session must not have an automatic server expiry');
  // On a fresh cloud account no demo employee has a working login.
  let check=await fetch(root+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'staff',password:'CloudTestOnly.Staff.2026'})});
  assert.equal(check.status,401,'Never seed a demo staff account automatically');
  let employee=await api('/users',admin,'POST',{
    username:'علي',full_name:'موظف الاختبار',password:'CloudTestOnly.Staff.2026',
    can_view_purchase:false,can_view_sale:true});
  assert.equal(employee.status,201,'Admin must be able to create new employee');
  const staffAccount=await employee.json();
  let staff=await signIn('علي','CloudTestOnly.Staff.2026');
  let result=await api('/products',admin);assert.equal(result.status,200);
  assert.equal((await result.json()).length,0,'Fresh cloud project must not import demo products');
  result=await api('/products',admin,'POST',{name:'أكواب ورقية',description:'صناعة محلية',
    manufacture:'عراقي',quantity:27,min_quantity:10,purchase_price:1500,sale_price:1900});
  assert.equal(result.status,201);
  const item=await result.json();
  assert(store.has('products:'+item.id),'Item must be confirmed persisted before HTTP 201');
  result=await api('/products',staff);
  assert.equal(result.status,200);
  let visible=(await result.json()).find(p=>p.id===item.id);
  assert(visible && !('purchase_price' in visible) && visible.sale_price===1900,
    'Employee must not obtain hidden purchase price');
  result=await api('/products/'+item.id+'/stock',staff,'PATCH',{quantity:99});
  assert.equal(result.status,403,'Staff must not alter stock');
  result=await api('/products/'+item.id+'/stock',admin,'PATCH',{quantity:32});
  assert.equal(result.status,200);
  assert.equal(store.get('products:'+item.id).payload.quantity,32,'Cloud stock must be current');
  result=await api('/execution-lists',staff,'POST',{items:[{product_id:item.id,quantity:2}]});
  assert.equal(result.status,201);
  const receipt=await result.json();
  assert(store.has('execution_lists:'+receipt.id),'Employee list must be stored in cloud');

  // Image content is kept in private Supabase Storage, not on temporary disk.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
  const form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'tiny.png');
  const uploaded=await fetch(root+'/products/'+item.id+'/image',{method:'POST',
    headers:{Authorization:'Bearer '+admin.access_token,'X-CSRF-Token':admin.csrf},body:form});
  assert.equal(uploaded.status,200,'Cloud image upload: '+(await uploaded.clone().text()).slice(0,200));
  const {image_url}=await uploaded.json();
  const filename=image_url.split('/').at(-1);
  assert(imageStore.has(filename),'Image must be stored in private bucket');
  const retrieved=await fetch('http://127.0.0.1:'+appPort+image_url,{
    headers:{Authorization:'Bearer '+staff.access_token}});
  assert.equal(retrieved.status,200);
  assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()),png);

  const sessionBeforeRestart=admin.access_token;
  const staffBeforeRevoke=staff.access_token;
  // The owner can revoke a remembered employee login from all devices.
  let revoke=await api('/users/'+staffAccount.id+'/revoke-sessions',admin,'POST',{});
  assert.equal(revoke.status,200,'Only management can revoke a staff session');
  let blocked=await api('/products',staff);
  assert.equal(blocked.status,401,'A revoked employee token must immediately stop working');
  await stop();
  // Simulate >1000 records to exercise remote pagination (4000+ compatible).
  for(let i=2000;i<3060;i++)store.set('products:'+i,{
    kind:'products',id:i,updated_at:new Date().toISOString(),payload:{id:i,name:'قنينة رقم '+i,
    description:'',manufacture:'',quantity:1,min_quantity:0,
    purchase_price:5,sale_price:6,image_name:null,updated_at:new Date().toISOString()}
  });
  cloudLoadPages=0;
  await start();
  assert(cloudLoadPages>=3,'Must read more than first Supabase page');
  let restored=await fetch(root+'/me',{headers:{Authorization:'Bearer '+sessionBeforeRestart}});
  assert.equal(restored.status,200,'Cloud login must persist across server restart');
  assert.equal((await restored.json()).user.username,'يوسف','Arabic admin username must survive restart');
  let revokedAfterRestart=await fetch(root+'/me',{headers:{Authorization:'Bearer '+staffBeforeRevoke}});
  assert.equal(revokedAfterRestart.status,401,'Admin revocation must persist after restart');
  admin=await signIn('يوسف','CloudTestOnly.Admin.2026');
  result=await api('/products?q='+encodeURIComponent('اكواب'),admin);
  assert.equal(result.status,200);
  const found=await result.json();
  assert(found.some(x=>x.id===item.id&&x.quantity===32),'Must survive a server reboot');
  result=await api('/products',admin);
  assert((await result.json()).length>=1061,'No records may be lost after pagination');

  // Owner recovers an existing account without deleting catalogue items.
  const previousToken=admin.access_token;
  await stop();
  recoverySecret='NewCloudOwnerPassword2026!';
  await start();
  const invalidated=await fetch(root+'/me',{headers:{Authorization:'Bearer '+previousToken}});
  assert.equal(invalidated.status,401,'Recovery invalidates the previous session');
  admin=await signIn('يوسف',recoverySecret);
  assert(store.has('metadata:107'),'Recovery operation must be one-time');
  assert(store.has('products:'+item.id),'Recovery keeps inventory intact');
  await stop();
  await start();
  admin=await signIn('يوسف',recoverySecret);
  mockTransientFailures=1;
  result=await api('/products',admin,'POST',{name:'اختبار انقطاع مؤقت',
    manufacture:'',quantity:2,purchase_price:1,sale_price:3});
  assert.equal(result.status,201,'One transient 503 should be retried safely');
  const retryItem=await result.json();
  assert(store.has('products:'+retryItem.id),'Retried item must actually be persisted');
  mockFailWrites=true;
  result=await api('/products',admin,'POST',{name:'لن يحفظ',
    manufacture:'',quantity:5,purchase_price:1,sale_price:2});
  assert.equal(result.status,503,'Never claim success when cloud rejects a write');
  result=await api('/products',admin);
  assert.equal(result.status,503,'Fail closed once cloud is unhealthy');
  mockFailWrites=false;
  await stop();
  await start();
  admin=await signIn('يوسف',recoverySecret);
  // Simulate another app server changing the same item after this instance
  // read it. The old server must NOT overwrite newer committed stock.
  const external=store.get('products:'+item.id);
  assert(external && external.updated_at);
  store.set('products:'+item.id,{...external,
    payload:{...external.payload,quantity:77},
    updated_at:new Date(Date.parse(external.updated_at)+5000).toISOString()});
  result=await api('/products/'+item.id+'/stock',admin,'PATCH',{quantity:41});
  assert.equal(result.status,409,'Concurrent stale stock update must be refused');
  assert.equal(store.get('products:'+item.id).payload.quantity,77,
    'Latest remote stock must never be overwritten by a stale server');
  const unhealthy=await fetch(root+'/health');
  assert.equal(unhealthy.status,503,'Conflicted app server should fail readiness for a fresh restart');
  console.log('PASS Supabase: new cloud / permissions / durable products / cloud images / employee lists / pagination / restart / fail-closed');
} finally {
  await stop();mock.close();rmSync(folder,{recursive:true,force:true});
}
