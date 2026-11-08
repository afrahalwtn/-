#!/usr/bin/env node
// Encrypted, off-Supabase backups; never imports into a live database.
// Node 22+ built-ins only. Keep all backups and keys OUTSIDE the repository.
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createGzip,createGunzip} from 'node:zlib';
import {Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAGIC=Buffer.from('AFRAH-BACKUP-V1\n');
const NONCE_SIZE=12,TAG_SIZE=16;
const IMAGE=/^[a-f0-9]{32}\.(?:png|jpg|webp)$/i;
const MAX_LINE=6*1024*1024;

function backupKey(){
  const raw=process.env.AFRAH_BACKUP_KEY||'';
  if(!/^[a-f0-9]{64}$/i.test(raw))throw Error('AFRAH_BACKUP_KEY must be 64 hex characters (32 random bytes)');
  return Buffer.from(raw,'hex');
}
function connection(){
  const base=String(process.env.SUPABASE_URL||'').trim().replace(/\/+$/,'');
  const token=String(process.env.SUPABASE_SECRET_KEY||'').trim();
  if(!base||!token)throw Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  const u=new URL(base);
  if(u.protocol!=='https:' && !['127.0.0.1','localhost'].includes(u.hostname))throw Error('Supabase requires HTTPS');
  if(!/^(sb_secret_|eyJ)/.test(token))throw Error('Invalid server-only Supabase key');
  return {base,token};
}
async function api(origin,endpoint,options={}){
  const headers={apikey:origin.token,Accept:'application/json',...(origin.token.startsWith('eyJ')?{Authorization:'Bearer '+origin.token}:{}),...(options.headers||{})};
  for(let attempt=0;attempt<3;attempt++){
    try{
      const response=await fetch(origin.base+endpoint,{...options,headers,signal:AbortSignal.timeout(30000)});
      if(response.ok)return response;
      if(![429,500,502,503,504].includes(response.status)||attempt===2)
        throw Error('Backup source HTTP '+response.status+' '+endpoint.split('?')[0]);
    }catch(e){
      if(attempt===2 || !(e instanceof TypeError || ['TimeoutError','AbortError'].includes(e?.name)))throw e;
    }
    await new Promise(resolve=>setTimeout(resolve,300*(attempt+1)));
  }
  throw Error('Backup source unavailable');
}
async function records(origin){
  const all=[];
  for(let offset=0;;offset+=500){
    const response=await api(origin,'/rest/v1/app_records?select=kind,id,payload,updated_at&order=kind.asc,id.asc&limit=500&offset='+offset);
    const page=await response.json();
    if(!Array.isArray(page))throw Error('Invalid database page');
    for(const row of page){
      if(!row||typeof row.kind!=='string'||!Number.isSafeInteger(row.id)||
        row.id<1||!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)||
        typeof row.updated_at!=='string')throw Error('Invalid backup record');
      all.push(row);
    }
    if(page.length<500)break;
    if(all.length>250000)throw Error('Record count exceeds backup safety limit');
  }
  return all;
}
async function imageList(origin){
  const all=[];
  for(let offset=0;;offset+=100){
    const response=await api(origin,'/storage/v1/object/list/item-images',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prefix:'',limit:100,offset,sortBy:{column:'name',order:'asc'}})
    });
    const page=await response.json();
    if(!Array.isArray(page))throw Error('Invalid image list response');
    for(const entry of page){
      if(!entry||typeof entry.name!=='string'||!IMAGE.test(entry.name))
        throw Error('Unexpected image path in private bucket');
      all.push({name:entry.name,updated_at:entry.updated_at||null,size:entry.metadata?.size??null});
    }
    if(page.length<100)break;
    if(all.length>250000)throw Error('Image count exceeds backup safety limit');
  }
  if(new Set(all.map(x=>x.name)).size!==all.length)throw Error('Duplicate image listing');
  return all;
}
const line=(value)=>Buffer.from(JSON.stringify(value)+'\n');
async function createBackup(filename){
  const key=backupKey(),origin=connection();
  const original=await records(origin),originalImages=await imageList(origin);
  const nonce=randomBytes(NONCE_SIZE),cipher=createCipheriv('aes-256-gcm',key,nonce);
  await fs.mkdir(path.dirname(path.resolve(filename)),{recursive:true});
  const handle=await fs.open(filename,'wx',0o600);
  try{await handle.write(Buffer.concat([MAGIC,nonce]));}finally{await handle.close();}
  let itemCount=0,imageCount=0;
  const digest=createHash('sha256');
  async function* source(){
    function next(value){const b=line(value);digest.update(b);return b;}
    yield next({type:'header',format:1,created_at:new Date().toISOString(),bucket:'item-images'});
    for(const row of original){itemCount++;yield next({type:'record',row});}
    for(const image of originalImages){
      const response=await api(origin,'/storage/v1/object/item-images/'+encodeURIComponent(image.name));
      const data=Buffer.from(await response.arrayBuffer());
      if(data.length>3*1024*1024)throw Error('Image exceeds maximum expected size');
      imageCount++;
      yield next({type:'image',name:image.name,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length,base64:data.toString('base64')});
    }
    // Reject a non-atomic snapshot rather than silently preserving mixed versions.
    const latest=await records(origin),latestImages=await imageList(origin);
    if(JSON.stringify(latest)!==JSON.stringify(original)||
      JSON.stringify(latestImages)!==JSON.stringify(originalImages))
      throw Error('Data changed while backing up; retry at a quieter time');
    yield line({type:'footer',records:itemCount,images:imageCount,sha256:digest.digest('hex')});
  }
  try{
    await pipeline(Readable.from(source()),createGzip({level:6}),cipher,createWriteStream(filename,{flags:'a',mode:0o600}));
    await fs.appendFile(filename,cipher.getAuthTag());
  }catch(error){
    await fs.rm(filename,{force:true}).catch(()=>{});
    throw error;
  }
  return {records:itemCount,images:imageCount,filename};
}
async function consumeBackup(filename,onRecord=async()=>{},onImage=async()=>{}){
  const key=backupKey(),stat=await fs.stat(filename);
  if(stat.size<MAGIC.length+NONCE_SIZE+TAG_SIZE+1)throw Error('Backup is incomplete');
  const fd=await fs.open(filename,'r');
  let start,end;
  try{
    start=Buffer.alloc(MAGIC.length+NONCE_SIZE);
    end=Buffer.alloc(TAG_SIZE);
    await fd.read(start,0,start.length,0);
    await fd.read(end,0,end.length,stat.size-TAG_SIZE);
  }finally{await fd.close();}
  if(!start.subarray(0,MAGIC.length).equals(MAGIC))throw Error('Unknown backup format');
  const decipher=createDecipheriv('aes-256-gcm',key,start.subarray(MAGIC.length));
  decipher.setAuthTag(end);
  const digest=createHash('sha256');
  let rem=Buffer.alloc(0),header=false,finished=false,recCount=0,imgCount=0;
  async function parse(raw){
    if(!raw.length||finished)throw Error('Malformed backup content');
    const item=JSON.parse(raw.toString('utf8'));
    if(item.type==='footer'){
      if(!header||recCount!==item.records||imgCount!==item.images||
        digest.digest('hex')!==item.sha256)throw Error('Backup checksum mismatch');
      finished=true;return;
    }
    digest.update(raw);digest.update('\n');
    if(item.type==='header'){
      if(header||item.format!==1||item.bucket!=='item-images')throw Error('Invalid backup header');
      header=true;return;
    }
    if(!header)throw Error('Missing backup header');
    if(item.type==='record'){
      const row=item.row;
      if(!row||!Number.isSafeInteger(row.id)||typeof row.kind!=='string'||
        typeof row.updated_at!=='string'||!row.payload||typeof row.payload!=='object')
        throw Error('Invalid record in archive');
      recCount++;await onRecord(row);return;
    }
    if(item.type==='image'){
      if(!IMAGE.test(item.name)||typeof item.base64!=='string'||item.base64.length>4*1024*1024+8)
        throw Error('Invalid image in archive');
      const content=Buffer.from(item.base64,'base64');
      if(content.length!==item.bytes||createHash('sha256').update(content).digest('hex')!==item.sha256)
        throw Error('Image checksum mismatch');
      imgCount++;await onImage(item.name,content);return;
    }
    throw Error('Unknown record type in archive');
  }
  const sink=new Writable({
    write(chunk,_encoding,callback){
      (async()=>{
        rem=Buffer.concat([rem,chunk]);
        if(rem.length>MAX_LINE)throw Error('Archive entry exceeds limit');
        let pos;
        while((pos=rem.indexOf(10))!==-1){
          const raw=rem.subarray(0,pos);
          rem=Buffer.from(rem.subarray(pos+1));
          await parse(raw);
        }
      })().then(()=>callback(),callback);
    },
    final(callback){callback(rem.length||!finished?Error('Incomplete backup archive'):undefined);}
  });
  await pipeline(createReadStream(filename,{start:start.length,end:stat.size-TAG_SIZE-1}),
    decipher,createGunzip(),sink);
  return {records:recCount,images:imgCount};
}
async function extractBackup(filename,destination){
  // Verify GCM authentication and every checksum BEFORE writing a single file.
  await consumeBackup(filename);
  await fs.mkdir(destination,{recursive:false});
  await fs.mkdir(path.join(destination,'images'));
  const db=await fs.open(path.join(destination,'app_records.ndjson'),'wx',0o600);
  try{
    const counts=await consumeBackup(filename,
      async(row)=>{await db.write(line(row));},
      async(name,data)=>{await fs.writeFile(path.join(destination,'images',name),data,{flag:'wx',mode:0o600});});
    await db.close();
    return counts;
  }catch(error){
    await db.close().catch(()=>{});
    await fs.rm(destination,{recursive:true,force:true});
    throw error;
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  const [action,file,output]=process.argv.slice(2);
  try{
    const result=action==='create' && file?await createBackup(file):
      action==='verify' && file?await consumeBackup(file):
      action==='extract' && file && output?await extractBackup(file,output):null;
    if(!result)throw Error('Usage: backup-cloud.mjs create <file> | verify <file> | extract <file> <new-directory>');
    console.log('OK '+action+': '+result.records+' records and '+result.images+' private images');
  }catch(error){console.error('Backup '+action+' failed:',error?.message||'Unknown error');process.exitCode=1;}
}
export {createBackup,consumeBackup,extractBackup};
