import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Single central SQLite database on the company's computer.
// Node >=22.13 includes this driver. No server subscription or native npm module.
export type RecordKind = 'users' | 'products' | 'quotes';
export const storageDirectory = path.resolve(
  process.env.AFRAH_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'),
);
fs.mkdirSync(storageDirectory,{recursive:true});
export const databasePath=path.join(storageDirectory,'afrah.sqlite');
const db=new DatabaseSync(databasePath,{timeout:5000});
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
`);

const selectRecords=db.prepare('SELECT id,payload FROM app_records WHERE kind=? ORDER BY id');
const insertRecord=db.prepare('INSERT INTO app_records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload');
const deleteRecord=db.prepare('DELETE FROM app_records WHERE kind=? AND id=?');
const metaGet=db.prepare('SELECT value FROM app_metadata WHERE key=?');
const metaSet=db.prepare('INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const maxRecord=db.prepare('SELECT COALESCE(MAX(id),0) as id FROM app_records WHERE kind=?');

export function hasStoredKind(kind:RecordKind):boolean {
  return Boolean(metaGet.get('seed:'+kind));
}

export class PersistentMap<T> extends Map<number,T> {
  readonly kind:RecordKind;
  constructor(kind:RecordKind, seeds:Map<number,T>) {
    super();
    this.kind=kind;
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
    insertRecord.run(this.kind,id,encoded);
    return super.set(id,value);
  }
  override delete(id:number):boolean {
    deleteRecord.run(this.kind,id);
    return super.delete(id);
  }
  override clear():void {
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
 const inserted=saveExecution.run(createdById,createdAt,JSON.stringify(items));
 return {id:Number(inserted.lastInsertRowid),created_by_id:createdById,created_at:createdAt,items};
}
export function listExecutionLists(userId:number|null):ExecutionList[] {
 return (userId===null?allExecutions.all():ownExecutions.all(userId)).map(shapeExecution);
}

export function allocateRecordId(kind:RecordKind):number {
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
  insertAudit.run(actorId,targetId,action,new Date().toISOString(),detail.slice(0,150));
}
export function listAccountAudit(limit=60):AccountAuditEvent[] {
  return recentAudit.all(Math.min(100,Math.max(1,Math.trunc(limit)))).map((row:any)=>({
    id:Number(row.id),actor_id:Number(row.actor_id),
    target_id:Number(row.target_id),action:String(row.action),
    created_at:String(row.created_at),detail:String(row.detail),
  }));
}
