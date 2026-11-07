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
let mockFailWrites=false,proc,logs='';
let cloudLoadPages=0;
const mock=http.createServer(async (req,res)=>{
  if(req.headers.apikey!==secret || req.headers.authorization?.includes('sb_secret_')){
    res.writeHead(401);res.end('Unauthorized');return;
  }
  const u=new URL(req.url||'/', 'http://127.0.0.1:'+mockPort);
  if(u.pathname==='/rest/v1/app_records'){
    if(req.method==='GET'){
      cloudLoadPages++;
      const all=Array.from(store.values()).sort((a,b)=>a.kind.localeCompare(b.kind)||a.id-b.id);
      const offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||500);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(all.slice(offset,offset+limit)));
      return;
    }
    if(mockFailWrites){res.writeHead(503);res.end('Unavailable');return;}
    if(req.method==='POST'){
      let body='';for await (const ch of req)body+=ch;
      for(const record of JSON.parse(body))store.set(record.kind+':'+record.id,record);
      res.writeHead(201);res.end();return;
    }
    if(req.method==='DELETE'){
      const kind=(u.searchParams.get('kind')||'').replace(/^eq\./,'');
      const id=(u.searchParams.get('id')||'').replace(/^eq\./,'');
      store.delete(kind+':'+id);
      res.writeHead(204);res.end();return;
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
  assert.equal(r.status,200,'login '+username+' failed: '+await r.text().catch(()=>'')); // consumed on error only
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
  let admin=await signIn('admin','CloudTestOnly.Admin.2026');
  let staff=await signIn('staff','CloudTestOnly.Staff.2026');
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

  await stop();
  // Simulate >1000 records to exercise remote pagination (4000+ compatible).
  for(let i=2000;i<3060;i++)store.set('products:'+i,{
    kind:'products',id:i,payload:{id:i,name:'قنينة رقم '+i,
    description:'',manufacture:'',quantity:1,min_quantity:0,
    purchase_price:5,sale_price:6,image_name:null,updated_at:new Date().toISOString()}
  });
  cloudLoadPages=0;
  await start();
  assert(cloudLoadPages>=3,'Must read more than first Supabase page');
  admin=await signIn('admin','CloudTestOnly.Admin.2026');
  result=await api('/products?q='+encodeURIComponent('اكواب'),admin);
  assert.equal(result.status,200);
  const found=await result.json();
  assert(found.some(x=>x.id===item.id&&x.quantity===32),'Must survive a server reboot');
  result=await api('/products',admin);
  assert((await result.json()).length>=1061,'No records may be lost after pagination');

  mockFailWrites=true;
  result=await api('/products',admin,'POST',{name:'لن يحفظ',
    manufacture:'',quantity:5,purchase_price:1,sale_price:2});
  assert.equal(result.status,503,'Never claim success when cloud rejects a write');
  result=await api('/products',admin);
  assert.equal(result.status,503,'Fail closed once cloud is unhealthy');
  console.log('PASS Supabase: new cloud / permissions / durable products / cloud images / employee lists / pagination / restart / fail-closed');
} finally {
  await stop();mock.close();rmSync(folder,{recursive:true,force:true});
}
