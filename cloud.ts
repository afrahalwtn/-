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

/** Download ALL pages; Supabase limits a single API response to 1000 rows. */
export async function loadCloudRecords(): Promise<CloudRecord[]> {
  if (!cloudEnabled) return [];
  const result: CloudRecord[] = [];
  for (let offset = 0; ; offset += 500) {
    const response = await request('/rest/v1/app_records?select=kind,id,payload,updated_at&order=kind.asc,id.asc&limit=500&offset=' + offset);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Supabase returned invalid data');
    for (const row of page) {
      if (!row || typeof row.kind !== 'string' || !Number.isSafeInteger(row.id) ||
          row.id < 1 || !row.payload || typeof row.payload !== 'object' ||
          Array.isArray(row.payload) || typeof row.updated_at!=='string' ||
          !Number.isFinite(Date.parse(row.updated_at))) throw new Error('Invalid Supabase record: '+String(row?.kind)+' #'+String(row?.id)+' timestamp='+String(row?.updated_at).slice(0,60));
      result.push(row);
    }
    if (page.length < 500) break;
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

/** Read a complete current collection; includes deletions, not just new rows. */
export async function loadCloudKind(kind:string):Promise<CloudRecord[]>{
  if(!/^(users|products|quotes|execution_lists|account_audit)$/.test(kind))
    throw Error('Invalid cloud collection');
  const results:CloudRecord[]=[];
  for(let offset=0;;offset+=500){
    const response=await request('/rest/v1/app_records?kind=eq.'+kind+
      '&select=kind,id,payload,updated_at&order=id.asc&limit=500&offset='+offset);
    const page=await response.json();
    if(!Array.isArray(page))throw Error('Invalid cloud collection');
    for(const row of page){
      if(row?.kind!==kind||!Number.isInteger(row.id)||
         !row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)||
         typeof row.updated_at!=='string')throw Error('Invalid cloud row in collection');
      results.push(row);
    }
    if(page.length<500)break;
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
