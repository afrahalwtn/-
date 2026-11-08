import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { cloudEnabled, loadCloudRecords, saveCloudRecord, deleteCloudRecord } from './cloud.js';

// Single central SQLite database on the company's computer.
// Node >=22.13 includes this driver. No server subscription or native npm module.
export type RecordKind = 'users' | 'products' | 'quotes';
export const storageDirectory = path.resolve(
  process.env.AFRAH_DATA_DIR || (cloudEnabled
    ? path.join(os.tmpdir(), 'afrah-cloud-runtime')
    : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data')),
);
fs.mkdirSync(storageDirectory,{recursive:true});
export const databasePath=path.join(storageDirectory,'afrah.sqlite');
const db=new DatabaseSync(databasePath,{timeout:5000});

// Cloud mode reads Supabase FIRST. SQLite is never the source of truth in this mode.
// An unavailable cloud causes startup to fail rather than silently changing databases.
const cloudRows = new Map<string,Map<number,any>>();
if (cloudEnabled) {
  for (const row of await loadCloudRecords()) {
    if (!cloudRows.has(row.kind)) cloudRows.set(row.kind,new Map());
    cloudRows.get(row.kind)!.set(row.id,row.payload);
  }
}
let cloudQueue:Promise<void>=Promise.resolve();
let cloudFailure:Error|null=null;
function putCloud(kind:string,id:number,payload:any):void {
  if (!cloudEnabled)return;
  // Snapshot each write: later in-memory edits must not mutate queued commits.
  const snapshot=JSON.parse(JSON.stringify(payload));
  if (!cloudRows.has(kind))cloudRows.set(kind,new Map());
  cloudRows.get(kind)!.set(id,snapshot);
  cloudQueue=cloudQueue.then(()=>saveCloudRecord(kind,id,snapshot));
  void cloudQueue.catch((error:unknown)=>{cloudFailure=error instanceof Error?error:Error(String(error));});
}
function removeCloud(kind:string,id:number):void {
  if (!cloudEnabled)return;
  cloudRows.get(kind)?.delete(id);
  cloudQueue=cloudQueue.then(()=>deleteCloudRecord(kind,id));
  void cloudQueue.catch((error:unknown)=>{cloudFailure=error instanceof Error?error:Error(String(error));});
}
export async function flushCloudWrites():Promise<void> {
  if(cloudEnabled)await cloudQueue;
}
export function cloudStorageHealthy():boolean {return !cloudFailure;}
export {cloudEnabled};
const seedIds:Record<RecordKind,number>={users:1,products:2,quotes:3};
const counterIds:Record<RecordKind|'execution_lists'|'account_audit'|'sessions',number>={
  users:101,products:102,quotes:103,execution_lists:104,account_audit:105,sessions:106
};
function cloudValue(kind:string,id:number):any{return cloudRows.get(kind)?.get(id);}
function nextCloudId(kind: keyof typeof counterIds):number {
  const counterId=counterIds[kind];
  const last=Number(cloudValue('metadata',counterId)?.last_id||0);
  const largest=Math.max(0,...Array.from(cloudRows.get(kind)?.keys()||[]));
  const next=Math.max(last,largest)+1;
  if(!Number.isSafeInteger(next)||next<1)throw Error('Invalid cloud ID');
  putCloud('metadata',counterId,{last_id:next});
  return next;
}
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS app_records(
  kind TEXT NOT NULL,
  id INTEGER NOT NULL CHECK(id > 0),
  payload TEXT NOT NULL,
  PRIMARY KEY(kind,id),
  CHECK(kind IN ('users','products','quotes'))
) STRICT;
CREATE TABLE IF NOT EXISTS app_metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS app_records_by_kind ON app_records(kind);
CREATE TABLE IF NOT EXISTS auth_sessions(
 token_hash TEXT PRIMARY KEY,
 payload TEXT NOT NULL
) STRICT;
`);

const selectRecords=db.prepare('SELECT id,payload FROM app_records WHERE kind=? ORDER BY id');
const insertRecord=db.prepare('INSERT INTO app_records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload');
const deleteRecord=db.prepare('DELETE FROM app_records WHERE kind=? AND id=?');
const metaGet=db.prepare('SELECT value FROM app_metadata WHERE key=?');
const metaSet=db.prepare('INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const maxRecord=db.prepare('SELECT COALESCE(MAX(id),0) as id FROM app_records WHERE kind=?');

// Sessions persist only SHA-256 token digests, NEVER raw login tokens.
// Cloud mode: saved in app_records (service-role-only). Local mode: SQLite.
// A single Node server is assumed; multi-server access requires central session lookups.
const selectSessions=db.prepare('SELECT token_hash,payload FROM auth_sessions');
const saveSession=db.prepare('INSERT INTO auth_sessions(token_hash,payload) VALUES(?,?) ON CONFLICT(token_hash) DO UPDATE SET payload=excluded.payload');
const dropSession=db.prepare('DELETE FROM auth_sessions WHERE token_hash=?');
export class PersistentSessionMap<T extends {token_hash:string;expires_at:number}> extends Map<string,T> {
  private cloudIds=new Map<string,number>();
  constructor(){
    super();
    if(cloudEnabled){
      for(const [id,payload] of cloudRows.get('sessions')||[]){
        if(typeof payload?.token_hash!=='string'||!Number.isSafeInteger(payload.expires_at))continue;
        this.cloudIds.set(payload.token_hash,id);
        if(payload.expires_at>Date.now())super.set(payload.token_hash,payload as T);
        else removeCloud('sessions',id);
      }
    } else {
      for(const row of selectSessions.all() as Array<{token_hash:string;payload:string}>){
        try{
          const payload=JSON.parse(row.payload) as T;
          if(payload.token_hash===row.token_hash&&payload.expires_at>Date.now()){
            super.set(row.token_hash,payload);
          } else dropSession.run(row.token_hash);
        } catch{ dropSession.run(row.token_hash); }
      }
    }
  }
  override set(hash:string,value:T):this{
    if(!/^[a-f0-9]{64}$/.test(hash)||value.token_hash!==hash)throw Error('Invalid session digest');
    if(cloudEnabled){
      let id=this.cloudIds.get(hash);
      if(!id){id=nextCloudId('sessions');this.cloudIds.set(hash,id);}
      putCloud('sessions',id,value);
    } else saveSession.run(hash,JSON.stringify(value));
    return super.set(hash,value);
  }
  override delete(hash:string):boolean{
    if(cloudEnabled){
      const id=this.cloudIds.get(hash);
      if(id){removeCloud('sessions',id);this.cloudIds.delete(hash);}
    } else dropSession.run(hash);
    return super.delete(hash);
  }
}

// Owner-controlled one-time cloud administrator recovery marker.
// It stores a salted password verifier, never the raw password or a fast digest.
// ID 107 is reserved for this marker and is inaccessible through public RLS.
export function getAdminResetMarker():string|null {
  if(!cloudEnabled)return null;
  const value=cloudValue('metadata',107)?.password_hash;
  return typeof value==='string'&&value.startsWith('scrypt
  if (cloudEnabled) return Boolean(cloudValue('metadata',seedIds[kind]) || cloudRows.get(kind)?.size);
  return Boolean(metaGet.get('seed:'+kind));
}

export class PersistentMap<T> extends Map<number,T> {
  readonly kind:RecordKind;
  constructor(kind:RecordKind, seeds:Map<number,T>) {
    super();
    this.kind=kind;
    if (cloudEnabled) {
      if (!hasStoredKind(kind)) {
        // A new cloud project starts with NO demo products or demo quotes.
        // Only initial accounts may be seeded using strong env-provided passwords.
        if (kind === 'users') {
          for (const [id,value] of seeds) {
            // Create ONLY the company administrator on first cloud startup.
            // Never create an active demo employee automatically.
            if ((value as any)?.role !== 'admin') continue;
            super.set(id,value);
            putCloud(kind,id,value);
          }
        }
        putCloud('metadata',seedIds[kind],{initialized:true});
      } else {
        for (const [id,value] of cloudRows.get(kind)||[])super.set(id,value as T);
        // If records were imported before this adapter existed, mark as initialized.
        if (!cloudValue('metadata',seedIds[kind]))
          putCloud('metadata',seedIds[kind],{initialized:true});
      }
      return;
    }
    if(!hasStoredKind(kind)){
      db.exec('BEGIN IMMEDIATE');
      try {
        // Never reintroduce deleted seed products on later restarts.
        for(const [id,value] of seeds)insertRecord.run(kind,id,JSON.stringify(value));
        metaSet.run('seed:'+kind,'1');
        db.exec('COMMIT');
      } catch(error){
        db.exec('ROLLBACK');throw error;
      }
    }
    for(const row of selectRecords.all(kind)){
      super.set(Number(row.id),JSON.parse(String(row.payload)) as T);
    }
  }
  override set(id:number,value:T):this {
    if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid record ID');
    const encoded=JSON.stringify(value);
    if(encoded===undefined)throw Error('Invalid stored record');
    if (cloudEnabled) {
      putCloud(this.kind,id,value);
      return super.set(id,value);
    }
    insertRecord.run(this.kind,id,encoded);
    return super.set(id,value);
  }
  override delete(id:number):boolean {
    if (cloudEnabled) {
      removeCloud(this.kind,id);
      return super.delete(id);
    }
    deleteRecord.run(this.kind,id);
    return super.delete(id);
  }
  override clear():void {
    if (cloudEnabled) {
      for (const id of this.keys())removeCloud(this.kind,id);
      super.clear();
      return;
    }
    db.prepare('DELETE FROM app_records WHERE kind=?').run(this.kind);
    super.clear();
  }
}

// IDs are never reused after an item is deleted or the server restarts.
// Staff execution lists are stored separately from quotations and inventory.
// They never change product quantities and never contain purchase/sale prices.
db.exec(`
CREATE TABLE IF NOT EXISTS execution_lists(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 created_by_id INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 payload TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS execution_lists_by_user ON execution_lists(created_by_id,id);
`);
const saveExecution=db.prepare(
 'INSERT INTO execution_lists(created_by_id,created_at,payload) VALUES(?,?,?)'
);
const ownExecutions=db.prepare(
 'SELECT id,created_by_id,created_at,payload FROM execution_lists WHERE created_by_id=? ORDER BY id DESC'
);
const allExecutions=db.prepare(
 'SELECT id,created_by_id,created_at,payload FROM execution_lists ORDER BY id DESC'
);
export interface ExecutionLine {
 product_id:number;
 name:string;
 description:string;
 manufacture:string;
 image_url:string|null;
 quantity:number;
}
export interface ExecutionList {
 id:number;
 created_by_id:number;
 created_at:string;
 items:ExecutionLine[];
}
function shapeExecution(row:any):ExecutionList {
 return {
  id:Number(row.id),created_by_id:Number(row.created_by_id),created_at:String(row.created_at),
  items:JSON.parse(String(row.payload)) as ExecutionLine[],
 };
}
export function createExecutionList(createdById:number,items:ExecutionLine[]):ExecutionList {
 const createdAt=new Date().toISOString();
 if (cloudEnabled) {
   const id=nextCloudId('execution_lists');
   const record={id,created_by_id:createdById,created_at:createdAt,items};
   putCloud('execution_lists',id,record);
   return record;
 }
 const inserted=saveExecution.run(createdById,createdAt,JSON.stringify(items));
 return {id:Number(inserted.lastInsertRowid),created_by_id:createdById,created_at:createdAt,items};
}
export function listExecutionLists(userId:number|null):ExecutionList[] {
 if (cloudEnabled) return Array.from(cloudRows.get('execution_lists')?.values()||[])
   .filter((row:any)=>userId===null||row.created_by_id===userId)
   .sort((a:any,b:any)=>b.id-a.id) as ExecutionList[];
 return (userId===null?allExecutions.all():ownExecutions.all(userId)).map(shapeExecution);
}

export function allocateRecordId(kind:RecordKind):number {
  if (cloudEnabled)return nextCloudId(kind);
  const key='last-id:'+kind;
  const last=Number((metaGet.get(key) as {value?:string}|undefined)?.value||0);
  const largest=Number((maxRecord.get(kind) as {id:number}).id||0);
  const next=Math.max(last,largest)+1;
  if(!Number.isSafeInteger(next)||next<1)throw Error('Record ID overflow');
  metaSet.run(key,String(next));
  return next;
}


/* Account security audit: records administrative actions without passwords or tokens.
   History is retained separately from user credentials and the business activity ledger. */
db.exec(`
CREATE TABLE IF NOT EXISTS account_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS account_audit_recent ON account_audit(id DESC);
`);
const insertAudit=db.prepare('INSERT INTO account_audit(actor_id,target_id,action,created_at,detail) VALUES(?,?,?,?,?)');
const recentAudit=db.prepare('SELECT id,actor_id,target_id,action,created_at,detail FROM account_audit ORDER BY id DESC LIMIT ?');
export interface AccountAuditEvent {
  id:number;
  actor_id:number;
  target_id:number;
  action:string;
  created_at:string;
  detail:string;
}
export function recordAccountAudit(actorId:number,targetId:number,action:string,detail=''):void {
  if (cloudEnabled) {
    const id=nextCloudId('account_audit');
    putCloud('account_audit',id,{
      id,actor_id:actorId,target_id:targetId,action,
      created_at:new Date().toISOString(),detail:detail.slice(0,150)
    });
    return;
  }
  insertAudit.run(actorId,targetId,action,new Date().toISOString(),detail.slice(0,150));
}
export function listAccountAudit(limit=60):AccountAuditEvent[] {
  if (cloudEnabled)return Array.from(cloudRows.get('account_audit')?.values()||[])
    .sort((a:any,b:any)=>b.id-a.id)
    .slice(0,Math.min(100,Math.max(1,Math.trunc(limit)))) as AccountAuditEvent[];
  return recentAudit.all(Math.min(100,Math.max(1,Math.trunc(limit)))).map((row:any)=>({
    id:Number(row.id),actor_id:Number(row.actor_id),
    target_id:Number(row.target_id),action:String(row.action),
    created_at:String(row.created_at),detail:String(row.detail),
  }));
}
)?value:null;
}
export function storeAdminResetMarker(passwordHash:string):void {
  if(!cloudEnabled||typeof passwordHash!=='string'||!passwordHash.startsWith('scrypt
  if (cloudEnabled) return Boolean(cloudValue('metadata',seedIds[kind]) || cloudRows.get(kind)?.size);
  return Boolean(metaGet.get('seed:'+kind));
}

export class PersistentMap<T> extends Map<number,T> {
  readonly kind:RecordKind;
  constructor(kind:RecordKind, seeds:Map<number,T>) {
    super();
    this.kind=kind;
    if (cloudEnabled) {
      if (!hasStoredKind(kind)) {
        // A new cloud project starts with NO demo products or demo quotes.
        // Only initial accounts may be seeded using strong env-provided passwords.
        if (kind === 'users') {
          for (const [id,value] of seeds) {
            // Create ONLY the company administrator on first cloud startup.
            // Never create an active demo employee automatically.
            if ((value as any)?.role !== 'admin') continue;
            super.set(id,value);
            putCloud(kind,id,value);
          }
        }
        putCloud('metadata',seedIds[kind],{initialized:true});
      } else {
        for (const [id,value] of cloudRows.get(kind)||[])super.set(id,value as T);
        // If records were imported before this adapter existed, mark as initialized.
        if (!cloudValue('metadata',seedIds[kind]))
          putCloud('metadata',seedIds[kind],{initialized:true});
      }
      return;
    }
    if(!hasStoredKind(kind)){
      db.exec('BEGIN IMMEDIATE');
      try {
        // Never reintroduce deleted seed products on later restarts.
        for(const [id,value] of seeds)insertRecord.run(kind,id,JSON.stringify(value));
        metaSet.run('seed:'+kind,'1');
        db.exec('COMMIT');
      } catch(error){
        db.exec('ROLLBACK');throw error;
      }
    }
    for(const row of selectRecords.all(kind)){
      super.set(Number(row.id),JSON.parse(String(row.payload)) as T);
    }
  }
  override set(id:number,value:T):this {
    if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid record ID');
    const encoded=JSON.stringify(value);
    if(encoded===undefined)throw Error('Invalid stored record');
    if (cloudEnabled) {
      putCloud(this.kind,id,value);
      return super.set(id,value);
    }
    insertRecord.run(this.kind,id,encoded);
    return super.set(id,value);
  }
  override delete(id:number):boolean {
    if (cloudEnabled) {
      removeCloud(this.kind,id);
      return super.delete(id);
    }
    deleteRecord.run(this.kind,id);
    return super.delete(id);
  }
  override clear():void {
    if (cloudEnabled) {
      for (const id of this.keys())removeCloud(this.kind,id);
      super.clear();
      return;
    }
    db.prepare('DELETE FROM app_records WHERE kind=?').run(this.kind);
    super.clear();
  }
}

// IDs are never reused after an item is deleted or the server restarts.
// Staff execution lists are stored separately from quotations and inventory.
// They never change product quantities and never contain purchase/sale prices.
db.exec(`
CREATE TABLE IF NOT EXISTS execution_lists(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 created_by_id INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 payload TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS execution_lists_by_user ON execution_lists(created_by_id,id);
`);
const saveExecution=db.prepare(
 'INSERT INTO execution_lists(created_by_id,created_at,payload) VALUES(?,?,?)'
);
const ownExecutions=db.prepare(
 'SELECT id,created_by_id,created_at,payload FROM execution_lists WHERE created_by_id=? ORDER BY id DESC'
);
const allExecutions=db.prepare(
 'SELECT id,created_by_id,created_at,payload FROM execution_lists ORDER BY id DESC'
);
export interface ExecutionLine {
 product_id:number;
 name:string;
 description:string;
 manufacture:string;
 image_url:string|null;
 quantity:number;
}
export interface ExecutionList {
 id:number;
 created_by_id:number;
 created_at:string;
 items:ExecutionLine[];
}
function shapeExecution(row:any):ExecutionList {
 return {
  id:Number(row.id),created_by_id:Number(row.created_by_id),created_at:String(row.created_at),
  items:JSON.parse(String(row.payload)) as ExecutionLine[],
 };
}
export function createExecutionList(createdById:number,items:ExecutionLine[]):ExecutionList {
 const createdAt=new Date().toISOString();
 if (cloudEnabled) {
   const id=nextCloudId('execution_lists');
   const record={id,created_by_id:createdById,created_at:createdAt,items};
   putCloud('execution_lists',id,record);
   return record;
 }
 const inserted=saveExecution.run(createdById,createdAt,JSON.stringify(items));
 return {id:Number(inserted.lastInsertRowid),created_by_id:createdById,created_at:createdAt,items};
}
export function listExecutionLists(userId:number|null):ExecutionList[] {
 if (cloudEnabled) return Array.from(cloudRows.get('execution_lists')?.values()||[])
   .filter((row:any)=>userId===null||row.created_by_id===userId)
   .sort((a:any,b:any)=>b.id-a.id) as ExecutionList[];
 return (userId===null?allExecutions.all():ownExecutions.all(userId)).map(shapeExecution);
}

export function allocateRecordId(kind:RecordKind):number {
  if (cloudEnabled)return nextCloudId(kind);
  const key='last-id:'+kind;
  const last=Number((metaGet.get(key) as {value?:string}|undefined)?.value||0);
  const largest=Number((maxRecord.get(kind) as {id:number}).id||0);
  const next=Math.max(last,largest)+1;
  if(!Number.isSafeInteger(next)||next<1)throw Error('Record ID overflow');
  metaSet.run(key,String(next));
  return next;
}


/* Account security audit: records administrative actions without passwords or tokens.
   History is retained separately from user credentials and the business activity ledger. */
db.exec(`
CREATE TABLE IF NOT EXISTS account_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS account_audit_recent ON account_audit(id DESC);
`);
const insertAudit=db.prepare('INSERT INTO account_audit(actor_id,target_id,action,created_at,detail) VALUES(?,?,?,?,?)');
const recentAudit=db.prepare('SELECT id,actor_id,target_id,action,created_at,detail FROM account_audit ORDER BY id DESC LIMIT ?');
export interface AccountAuditEvent {
  id:number;
  actor_id:number;
  target_id:number;
  action:string;
  created_at:string;
  detail:string;
}
export function recordAccountAudit(actorId:number,targetId:number,action:string,detail=''):void {
  if (cloudEnabled) {
    const id=nextCloudId('account_audit');
    putCloud('account_audit',id,{
      id,actor_id:actorId,target_id:targetId,action,
      created_at:new Date().toISOString(),detail:detail.slice(0,150)
    });
    return;
  }
  insertAudit.run(actorId,targetId,action,new Date().toISOString(),detail.slice(0,150));
}
export function listAccountAudit(limit=60):AccountAuditEvent[] {
  if (cloudEnabled)return Array.from(cloudRows.get('account_audit')?.values()||[])
    .sort((a:any,b:any)=>b.id-a.id)
    .slice(0,Math.min(100,Math.max(1,Math.trunc(limit)))) as AccountAuditEvent[];
  return recentAudit.all(Math.min(100,Math.max(1,Math.trunc(limit)))).map((row:any)=>({
    id:Number(row.id),actor_id:Number(row.actor_id),
    target_id:Number(row.target_id),action:String(row.action),
    created_at:String(row.created_at),detail:String(row.detail),
  }));
}
)){
    throw Error('Invalid owner reset marker');
  }
  putCloud('metadata',107,{password_hash:passwordHash});
}

export function hasStoredKind(kind:RecordKind):boolean {
  if (cloudEnabled) return Boolean(cloudValue('metadata',seedIds[kind]) || cloudRows.get(kind)?.size);
  return Boolean(metaGet.get('seed:'+kind));
}

export class PersistentMap<T> extends Map<number,T> {
  readonly kind:RecordKind;
  constructor(kind:RecordKind, seeds:Map<number,T>) {
    super();
    this.kind=kind;
    if (cloudEnabled) {
      if (!hasStoredKind(kind)) {
        // A new cloud project starts with NO demo products or demo quotes.
        // Only initial accounts may be seeded using strong env-provided passwords.
        if (kind === 'users') {
          for (const [id,value] of seeds) {
            // Create ONLY the company administrator on first cloud startup.
            // Never create an active demo employee automatically.
            if ((value as any)?.role !== 'admin') continue;
            super.set(id,value);
            putCloud(kind,id,value);
          }
        }
        putCloud('metadata',seedIds[kind],{initialized:true});
      } else {
        for (const [id,value] of cloudRows.get(kind)||[])super.set(id,value as T);
        // If records were imported before this adapter existed, mark as initialized.
        if (!cloudValue('metadata',seedIds[kind]))
          putCloud('metadata',seedIds[kind],{initialized:true});
      }
      return;
    }
    if(!hasStoredKind(kind)){
      db.exec('BEGIN IMMEDIATE');
      try {
        // Never reintroduce deleted seed products on later restarts.
        for(const [id,value] of seeds)insertRecord.run(kind,id,JSON.stringify(value));
        metaSet.run('seed:'+kind,'1');
        db.exec('COMMIT');
      } catch(error){
        db.exec('ROLLBACK');throw error;
      }
    }
    for(const row of selectRecords.all(kind)){
      super.set(Number(row.id),JSON.parse(String(row.payload)) as T);
    }
  }
  override set(id:number,value:T):this {
    if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid record ID');
    const encoded=JSON.stringify(value);
    if(encoded===undefined)throw Error('Invalid stored record');
    if (cloudEnabled) {
      putCloud(this.kind,id,value);
      return super.set(id,value);
    }
    insertRecord.run(this.kind,id,encoded);
    return super.set(id,value);
  }
  override delete(id:number):boolean {
    if (cloudEnabled) {
      removeCloud(this.kind,id);
      return super.delete(id);
    }
    deleteRecord.run(this.kind,id);
    return super.delete(id);
  }
  override clear():void {
    if (cloudEnabled) {
      for (const id of this.keys())removeCloud(this.kind,id);
      super.clear();
      return;
    }
    db.prepare('DELETE FROM app_records WHERE kind=?').run(this.kind);
    super.clear();
  }
}

// IDs are never reused after an item is deleted or the server restarts.
// Staff execution lists are stored separately from quotations and inventory.
// They never change product quantities and never contain purchase/sale prices.
db.exec(`
CREATE TABLE IF NOT EXISTS execution_lists(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 created_by_id INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 payload TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS execution_lists_by_user ON execution_lists(created_by_id,id);
`);
const saveExecution=db.prepare(
 'INSERT INTO execution_lists(created_by_id,created_at,payload) VALUES(?,?,?)'
);
const ownExecutions=db.prepare(
 'SELECT id,created_by_id,created_at,payload FROM execution_lists WHERE created_by_id=? ORDER BY id DESC'
);
const allExecutions=db.prepare(
 'SELECT id,created_by_id,created_at,payload FROM execution_lists ORDER BY id DESC'
);
export interface ExecutionLine {
 product_id:number;
 name:string;
 description:string;
 manufacture:string;
 image_url:string|null;
 quantity:number;
}
export interface ExecutionList {
 id:number;
 created_by_id:number;
 created_at:string;
 items:ExecutionLine[];
}
function shapeExecution(row:any):ExecutionList {
 return {
  id:Number(row.id),created_by_id:Number(row.created_by_id),created_at:String(row.created_at),
  items:JSON.parse(String(row.payload)) as ExecutionLine[],
 };
}
export function createExecutionList(createdById:number,items:ExecutionLine[]):ExecutionList {
 const createdAt=new Date().toISOString();
 if (cloudEnabled) {
   const id=nextCloudId('execution_lists');
   const record={id,created_by_id:createdById,created_at:createdAt,items};
   putCloud('execution_lists',id,record);
   return record;
 }
 const inserted=saveExecution.run(createdById,createdAt,JSON.stringify(items));
 return {id:Number(inserted.lastInsertRowid),created_by_id:createdById,created_at:createdAt,items};
}
export function listExecutionLists(userId:number|null):ExecutionList[] {
 if (cloudEnabled) return Array.from(cloudRows.get('execution_lists')?.values()||[])
   .filter((row:any)=>userId===null||row.created_by_id===userId)
   .sort((a:any,b:any)=>b.id-a.id) as ExecutionList[];
 return (userId===null?allExecutions.all():ownExecutions.all(userId)).map(shapeExecution);
}

export function allocateRecordId(kind:RecordKind):number {
  if (cloudEnabled)return nextCloudId(kind);
  const key='last-id:'+kind;
  const last=Number((metaGet.get(key) as {value?:string}|undefined)?.value||0);
  const largest=Number((maxRecord.get(kind) as {id:number}).id||0);
  const next=Math.max(last,largest)+1;
  if(!Number.isSafeInteger(next)||next<1)throw Error('Record ID overflow');
  metaSet.run(key,String(next));
  return next;
}


/* Account security audit: records administrative actions without passwords or tokens.
   History is retained separately from user credentials and the business activity ledger. */
db.exec(`
CREATE TABLE IF NOT EXISTS account_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS account_audit_recent ON account_audit(id DESC);
`);
const insertAudit=db.prepare('INSERT INTO account_audit(actor_id,target_id,action,created_at,detail) VALUES(?,?,?,?,?)');
const recentAudit=db.prepare('SELECT id,actor_id,target_id,action,created_at,detail FROM account_audit ORDER BY id DESC LIMIT ?');
export interface AccountAuditEvent {
  id:number;
  actor_id:number;
  target_id:number;
  action:string;
  created_at:string;
  detail:string;
}
export function recordAccountAudit(actorId:number,targetId:number,action:string,detail=''):void {
  if (cloudEnabled) {
    const id=nextCloudId('account_audit');
    putCloud('account_audit',id,{
      id,actor_id:actorId,target_id:targetId,action,
      created_at:new Date().toISOString(),detail:detail.slice(0,150)
    });
    return;
  }
  insertAudit.run(actorId,targetId,action,new Date().toISOString(),detail.slice(0,150));
}
export function listAccountAudit(limit=60):AccountAuditEvent[] {
  if (cloudEnabled)return Array.from(cloudRows.get('account_audit')?.values()||[])
    .sort((a:any,b:any)=>b.id-a.id)
    .slice(0,Math.min(100,Math.max(1,Math.trunc(limit)))) as AccountAuditEvent[];
  return recentAudit.all(Math.min(100,Math.max(1,Math.trunc(limit)))).map((row:any)=>({
    id:Number(row.id),actor_id:Number(row.actor_id),
    target_id:Number(row.target_id),action:String(row.action),
    created_at:String(row.created_at),detail:String(row.detail),
  }));
}
