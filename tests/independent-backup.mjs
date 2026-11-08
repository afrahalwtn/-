import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createBackup,consumeBackup,extractBackup} from '../scripts/backup-cloud.mjs';

const folder=mkdtempSync(path.join(tmpdir(),'afrah-backup-test-'));
const itemImage='a'.repeat(32)+'.png';
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
const version='2026-11-01T10:20:30.123Z';
const rows=[
 {kind:'products',id:1,payload:{id:1,name:'قدح ورقي 200',quantity:19},updated_at:version},
 {kind:'users',id:1,payload:{id:1,username:'يوسف',password:'scrypt$EXAMPLE-PRIVATE-HASH'},updated_at:version}
];
let changeDuringBackup=false;
const secret='sb_secret_mock_backup_key';
const mock=http.createServer(async(req,res)=>{
  if(req.headers.apikey!==secret){res.writeHead(401);res.end();return;}
  const u=new URL(req.url,'http://127.0.0.1');
  const json=(item)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(item));};
  if(u.pathname==='/rest/v1/app_records'&&req.method==='GET'){
    const offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||500);
    json(rows.slice(offset,offset+limit));return;
  }
  if(u.pathname==='/storage/v1/object/list/item-images'&&req.method==='POST'){
    json([{name:itemImage,updated_at:'2026-11-01T10:20:30.000Z',metadata:{size:bytes.length}}]);return;
  }
  if(u.pathname==='/storage/v1/object/item-images/'+itemImage&&req.method==='GET'){
    if(changeDuringBackup)rows[0].updated_at=new Date().toISOString();
    res.writeHead(200,{'content-type':'image/png'});res.end(bytes);return;
  }
  res.writeHead(404);res.end();
});
try{
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  process.env.SUPABASE_URL='http://127.0.0.1:'+mock.address().port;
  process.env.SUPABASE_SECRET_KEY=secret;
  process.env.AFRAH_BACKUP_KEY=randomBytes(32).toString('hex');
  const backup=path.join(folder,'secure.afrah.enc');
  const created=await createBackup(backup);
  assert.equal(created.records,2);
  assert.equal(created.images,1);
  const verified=await consumeBackup(backup);
  assert.deepEqual(verified,{records:2,images:1});
  const contents=await fs.readFile(backup);
  assert(!contents.includes(Buffer.from('scrypt$EXAMPLE-PRIVATE-HASH')),'No credentials in plaintext');
  assert(!contents.includes(Buffer.from('قدح ورقي')),'No catalogue in plaintext');
  const destination=path.join(folder,'extracted');
  const extracted=await extractBackup(backup,destination);
  assert.deepEqual(extracted,{records:2,images:1});
  const restoredRows=(await fs.readFile(path.join(destination,'app_records.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(restoredRows,rows);
  assert.deepEqual(await fs.readFile(path.join(destination,'images',itemImage)),bytes);
  const corrupted=path.join(folder,'corrupted.afrah.enc');
  const tampered=Buffer.from(contents);tampered[tampered.length-18]^=0xff;
  await fs.writeFile(corrupted,tampered);
  await assert.rejects(consumeBackup(corrupted),'Encrypted backup must reject tampering');
  const incomplete=path.join(folder,'changed.afrah.enc');
  changeDuringBackup=true;
  await assert.rejects(createBackup(incomplete),/Data changed while backing up/);
  await assert.rejects(fs.stat(incomplete),{code:'ENOENT'},'Incomplete snapshots must never remain');
  console.log('PASS: independent AES-GCM backup, full record/image restore, tamper detection, and consistency guard');
}finally{
  await new Promise(resolve=>mock.close(resolve));
  await fs.rm(folder,{recursive:true,force:true});
}
