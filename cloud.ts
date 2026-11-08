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
          !Number.isFinite(Date.parse(row.updated_at))) throw new Error('Invalid Supabase record');
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
