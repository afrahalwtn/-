/**
 * Afrah Al Watan: private SERVER-ONLY transport to Supabase.
 * This module is intentionally never served from /web, never bundled in the UI.
 * The secret key is read only from the backend process environment.
 */
import fs from 'node:fs/promises';

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_SECRET_KEY || '').trim();
if (Boolean(url) !== Boolean(key)) {
  throw new Error('Configure both SUPABASE_URL and SUPABASE_SECRET_KEY or neither');
}
export const cloudEnabled = Boolean(url && key);
if (cloudEnabled) {
  const target = new URL(url);
  if (target.protocol !== 'https:' && !(target.hostname === 'localhost' || target.hostname === '127.0.0.1')) {
    throw new Error('Supabase backend must use HTTPS');
  }
  if (!/^(sb_secret_|eyJ)/.test(key)) throw new Error('Invalid Supabase secret key format');
}

const headers = (): Record<string,string> => {
  const h: Record<string,string> = { apikey: key, Accept: 'application/json' };
  // Legacy service_role JWTs use bearer auth; modern sb_secret keys go
  // in the apikey header only (they are NOT JWTs).
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key;
  return h;
};
async function request(endpoint: string, init: RequestInit = {}): Promise<Response> {
  if (!cloudEnabled) throw new Error('Supabase is not configured');
  const response = await fetch(url + endpoint, {
    ...init,
    signal: AbortSignal.timeout(20000),
    headers: { ...headers(), ...(init.headers || {}) }
  });
  if (!response.ok) {
    // Do not log credentials or response bodies that could contain sensitive data.
    throw new Error('Supabase request failed: HTTP ' + response.status + ' (' + endpoint.split('?')[0] + ')');
  }
  return response;
}

export interface CloudRecord {
  kind: string;
  id: number;
  payload: Record<string,unknown>;
  updated_at: string;
}

/** Scan all kinds with an ordered composite cursor instead of OFFSET.
 * A concurrent DELETE before page N must never shift and hide the next row.
 * The cursor predicate matches the (kind ASC, id ASC) composite index.
 */
export async function loadCloudRecords(): Promise<CloudRecord[]> {
  if (!cloudEnabled) return [];
  const result:CloudRecord[]=[];
  let lastKind='',lastId=0;
  const pageSize=500;
  for(;;){
    const filter=lastKind
      ? '&or='+encodeURIComponent('(kind.gt.'+lastKind+
          ',and(kind.eq.'+lastKind+',id.gt.'+lastId+'))')
      : '';
    const response=await request('/rest/v1/app_records?select=kind,id,payload,updated_at&order=kind.asc,id.asc&limit='+pageSize+filter);
    const page=await response.json();
    if(!Array.isArray(page)||page.length>pageSize)
      throw Error('Invalid Supabase record page');
    for(const row of page){
      if(!row || typeof row.kind!=='string'||
         !/^[a-z][a-z0-9_]{0,63}$/.test(row.kind)||
         !Number.isSafeInteger(row.id)||row.id<1||
         (lastKind!==''&&(row.kind<lastKind||(row.kind===lastKind&&row.id<=lastId)))||
         !row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)||
         typeof row.updated_at!=='string'||!Number.isFinite(Date.parse(row.updated_at)))
        throw Error('Invalid or out-of-order Supabase record');
      lastKind=row.kind;lastId=row.id;
      result.push(row);
    }
    if(result.length>250000)throw Error('Supabase record count exceeds safety limit');
    if(page.length<pageSize)break;
  }
  return result;
}

// Existing rows use atomic compare-and-swap against PostgreSQL updated_at.
// A stale app server can never overwrite a later write from another instance.
// New rows use INSERT without upsert, so colliding IDs cannot overwrite records.
function changedVersion(rows:unknown,kind:string,id:number):string {
  if(!Array.isArray(rows)||rows.length!==1||rows[0]?.kind!==kind||
     Number(rows[0]?.id)!==id||typeof rows[0]?.updated_at!=='string')
    throw new Error('Supabase record conflict: '+kind+' #'+id+' changed on another server');
  return rows[0].updated_at;
}
// Fetch exactly one record to reconcile an idempotent offline submission.
export async function readCloudRecord(kind:string,id:number):Promise<CloudRecord|null>{
  if(!cloudEnabled)return null;
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(kind)||!Number.isSafeInteger(id)||id<1)
    throw Error('Invalid cloud lookup');
  const response=await request('/rest/v1/app_records?kind=eq.'+
    encodeURIComponent(kind)+'&id=eq.'+id+
    '&select=kind,id,payload,updated_at&limit=1');
  const rows=await response.json();
  if(!Array.isArray(rows)||rows.length>1)throw Error('Invalid cloud record lookup');
  const row=rows[0];
  if(!row)return null;
  if(row.kind!==kind||Number(row.id)!==id||!row.payload||typeof row.payload!=='object')
    throw Error('Invalid cloud record response');
  return row as CloudRecord;
}
export async function saveCloudRecord(
  kind:string,id:number,payload:Record<string,unknown>,previous:string|null
):Promise<string>{
  const headers={'Content-Type':'application/json',Prefer:'return=representation'};
  if(previous===null){
    const response=await request('/rest/v1/app_records?select=kind,id,updated_at',{
      method:'POST',headers,body:JSON.stringify([{kind,id,payload}])
    });
    return changedVersion(await response.json(),kind,id);
  }
  // PostgreSQL preserves microseconds in the predicate; compare with the exact
  // version returned by Supabase, never a rounded JavaScript timestamp.
  const future=new Date(Math.max(Date.now(),Date.parse(previous)+1)).toISOString();
  const url='/rest/v1/app_records?kind=eq.'+encodeURIComponent(kind)+
    '&id=eq.'+id+'&updated_at=eq.'+encodeURIComponent(previous)+
    '&select=kind,id,updated_at';
  const response=await request(url,{method:'PATCH',headers,
    body:JSON.stringify({payload,updated_at:future})});
  return changedVersion(await response.json(),kind,id);
}
export async function deleteCloudRecord(kind:string,id:number,previous:string|null):Promise<void>{
  if(previous===null)throw new Error('Supabase record conflict: cannot remove an unconfirmed row');
  const url='/rest/v1/app_records?kind=eq.'+encodeURIComponent(kind)+
    '&id=eq.'+id+'&updated_at=eq.'+encodeURIComponent(previous)+
    '&select=kind,id,updated_at';
  const response=await request(url,{method:'DELETE',headers:{Prefer:'return=representation'}});
  changedVersion(await response.json(),kind,id);
}
/**
 * Allocate the next numeric ID in PostgreSQL with an optimistic CAS on the
 * existing private metadata row. Unlike a process-local counter this works
 * across multiple instances without migrations or a public RPC.
 *
 * Never re-use IDs after deletion: the high-water metadata value is persisted.
 */
export async function claimCloudId(kind:string,counterId:number):Promise<number>{
  if(!/^(users|products|quotes|execution_lists|account_audit|sessions)$/.test(kind)||
     !Number.isInteger(counterId)||counterId<101||counterId>106)
    throw Error('Invalid cloud ID counter');
  const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<14;attempt++){
    const counterResponse=await request(
      '/rest/v1/app_records?kind=eq.metadata&id=eq.'+counterId+
      '&select=kind,id,payload,updated_at&limit=1');
    const counters=await counterResponse.json();
    if(!Array.isArray(counters)||counters.length>1)throw Error('Invalid cloud ID metadata');
    const current=counters[0]??null;
    const existing=await request('/rest/v1/app_records?kind=eq.'+kind+
      '&select=id&order=id.desc&limit=1');
    const highestRows=await existing.json();
    if(!Array.isArray(highestRows))throw Error('Invalid cloud ID high-water mark');
    const highest=Number(highestRows[0]?.id||0);
    const last=Number(current?.payload?.last_id||0);
    if(!Number.isSafeInteger(last)||last<0||!Number.isSafeInteger(highest)||highest<0)
      throw Error('Corrupted cloud ID high-water mark');
    const next=Math.max(last,highest)+1;
    // Database app_records.id is a signed PostgreSQL INTEGER.
    if(next>=2147483647)throw Error('Cloud ID space is exhausted');
    try{
      await saveCloudRecord('metadata',counterId,{last_id:next},
        current?current.updated_at:null);
      return next;
    }catch(error){
      const conflict=error instanceof Error&&
        (/^Supabase record conflict:/.test(error.message)||
         /^Supabase request failed: HTTP 409/.test(error.message));
      const transient=error instanceof TypeError ||
        (error instanceof Error&&(
          ['TimeoutError','AbortError'].includes(error.name)||
          /^Supabase request failed: HTTP (?:429|5[0-9]{2})/.test(error.message)));
      if(!conflict&&!transient)throw error;
      // Another server won the reservation, or its response was interrupted:
      // re-read the counter before retrying to prevent reusing an ID.
      if(attempt===13)break;
      await pause(12+attempt*7);
    }
  }
  throw Error('Could not reserve a unique cloud record ID');
}

/** Read the complete current collection (including deletions).
 * Keyset paging avoids skipping/duplicating rows if another node inserts
 * or deletes records while a large catalogue is being scanned.
 */
export async function loadCloudKind(kind:string):Promise<CloudRecord[]>{
  if(!/^(users|products|quotes|execution_lists|account_audit|metadata)$/.test(kind))
    throw Error('Invalid cloud collection');
  const results:CloudRecord[]=[];
  const batchSize=1000; // Supabase default per-request maximum.
  let lastId=0;
  for(;;){
    const response=await request('/rest/v1/app_records?kind=eq.'+kind+
      '&id=gt.'+lastId+
      '&select=kind,id,payload,updated_at&order=id.asc&limit='+batchSize);
    const page=await response.json();
    if(!Array.isArray(page)||page.length>batchSize)
      throw Error('Invalid cloud collection page');
    for(const row of page){
      if(row?.kind!==kind||!Number.isSafeInteger(row.id)||row.id<=lastId||
         !row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)||
         typeof row.updated_at!=='string'||!Number.isFinite(Date.parse(row.updated_at)))
        throw Error('Invalid cloud row or non-increasing record ID');
      lastId=row.id;
      results.push(row);
    }
    if(results.length>250000)throw Error('Cloud collection exceeds safety limit');
    if(page.length<batchSize)break;
  }
  return results;
}

// Authenticate against the shared database rather than a per-server startup
// snapshot. This allows a session created on one instance to work on another,
// and makes a revoked/disabled session fail immediately across all instances.
export async function readCloudUser(id:number):Promise<Record<string,unknown>|null> {
  if(!Number.isSafeInteger(id)||id<1) return null;
  const endpoint='/rest/v1/app_records?kind=eq.users&id=eq.'+id+'&select=payload&limit=1';
  const response=await request(endpoint);
  const rows=await response.json();
  if(!Array.isArray(rows)||rows.length>1)throw Error('Invalid shared user lookup');
  return rows.length===1 && rows[0]?.payload && typeof rows[0].payload==='object'
    && !Array.isArray(rows[0].payload)?rows[0].payload:null;
}
export async function listCloudUsers():Promise<Array<Record<string,unknown>>> {
  const users:Array<Record<string,unknown>>=[];
  for(let offset=0;;offset+=500){
    const response=await request('/rest/v1/app_records?kind=eq.users&select=payload&order=id.asc&limit=500&offset='+offset);
    const rows=await response.json();
    if(!Array.isArray(rows))throw Error('Invalid shared user list');
    for(const row of rows){
      if(!row?.payload||typeof row.payload!=='object'||Array.isArray(row.payload))
        throw Error('Invalid shared user record');
      users.push(row.payload);
    }
    if(rows.length<500)break;
  }
  return users;
}
export async function readCloudSession(hash:string):Promise<Record<string,unknown>|null> {
  if(!/^[a-f0-9]{64}$/.test(hash))return null;
  // The comparison happens within PostgREST/PostgreSQL, without fetching
  // every active user's token digest into app-server memory.
  const endpoint='/rest/v1/app_records?kind=eq.sessions&payload->>token_hash=eq.'+hash+
    '&select=payload&limit=1';
  const response=await request(endpoint);
  const rows=await response.json();
  if(!Array.isArray(rows)||rows.length>1)throw Error('Invalid shared session lookup');
  return rows.length===1&&rows[0]?.payload&&typeof rows[0].payload==='object'
    && !Array.isArray(rows[0].payload)?rows[0].payload:null;
}
export async function removeCloudSession(hash:string):Promise<void>{
  if(!/^[a-f0-9]{64}$/.test(hash))throw Error('Invalid session digest');
  await request('/rest/v1/app_records?kind=eq.sessions&payload->>token_hash=eq.'+hash,{
    method:'DELETE',headers:{Prefer:'return=minimal'},
  });
}

export async function uploadCloudImage(filename: string, filePath: string, mime: string): Promise<void> {
  const buffer = await fs.readFile(filePath);
  await request('/storage/v1/object/item-images/' + encodeURIComponent(filename), {
    method:'POST',
    headers:{'Content-Type': mime, 'x-upsert':'false'},
    body:buffer
  });
}
export async function loadCloudImage(filename: string): Promise<{data:Buffer;mime:string}> {
  const response = await request('/storage/v1/object/item-images/' + encodeURIComponent(filename));
  return { data:Buffer.from(await response.arrayBuffer()),
    mime:response.headers.get('content-type') || 'application/octet-stream' };
}


/** One PostgreSQL transaction checks inventory, deducts counts, and records an
 * idempotent execution list. Never update several products with separate HTTP
 * requests: partial deduction would be unacceptable for a staff dispatch. */
export async function commitCloudStockDispatch(actorId:number,receiptId:number,requestId:string,
  items:Array<{product_id:number;quantity:number}>):Promise<any>{
  if(!cloudEnabled)throw Error('Supabase is not configured');
  const endpoint='/rest/v1/rpc/afrah_commit_stock_dispatch';
  const response=await fetch(url+endpoint,{
    method:'POST',signal:AbortSignal.timeout(25000),
    headers:{...headers(),'Content-Type':'application/json'},
    body:JSON.stringify({p_actor_id:actorId,p_receipt_id:receiptId,p_request_id:requestId,p_items:items})
  });
  if(!response.ok){
    const result=await response.json().catch(()=>({}));
    const code=String(result?.message||'');
    if(code.startsWith('STOCK_INSUFFICIENT:')||code.startsWith('STOCK_ITEM_MISSING:')||
       code.startsWith('STOCK_REQUEST_CONFLICT')||code.startsWith('INVALID_OR_DUPLICATE_STOCK_LINE')){
      const issue=Object.assign(new Error(code),{status:409});
      throw issue;
    }
    if(code==='INVALID_STOCK_REQUEST')throw Object.assign(new Error(code),{status:422});
    throw Error('Supabase stock transaction failed: HTTP '+response.status);
  }
  const result=await response.json();
  if(!result||!Number.isSafeInteger(result.id)||result.created_by_id!==actorId||
     !Array.isArray(result.items)||result.stock_deducted!==true)
    throw Error('Supabase stock transaction returned an invalid receipt');
  return result;
}
