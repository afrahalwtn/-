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
export function allocateRecordId(kind:RecordKind):number {
  const key='last-id:'+kind;
  const last=Number((metaGet.get(key) as {value?:string}|undefined)?.value||0);
  const largest=Number((maxRecord.get(kind) as {id:number}).id||0);
  const next=Math.max(last,largest)+1;
  if(!Number.isSafeInteger(next)||next<1)throw Error('Record ID overflow');
  metaSet.run(key,String(next));
  return next;
}
