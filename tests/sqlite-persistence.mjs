import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {matchesArabicSearch} from '../web/arabic-search.js';

const folder=mkdtempSync(path.join(tmpdir(),'afrah-db-'));
// Always test an isolated local SQLite database, never a configured live Supabase project.
process.env.SUPABASE_URL='';
process.env.SUPABASE_SECRET_KEY='';
process.env.AFRAH_ADMIN_RESET_PASSWORD='';
process.env.NODE_ENV='development';
process.env.AFRAH_DATA_DIR=folder;
try {
 const {PersistentMap,allocateRecordId,databasePath}=await import('../storage.ts');
 const seeds=new Map([[1,{id:1,name:'أقداح ورقية',description:'مصنّعة',manufacture:'عراقي',quantity:8}]]);
 const first=new PersistentMap('products',seeds);
 assert.equal(first.get(1).quantity,8);
 first.set(1,{...first.get(1),quantity:4});
 assert.equal(new PersistentMap('products',seeds).get(1).quantity,4,'Stock persists when storage reloads');
 const second=await allocateRecordId('products');
 first.set(second,{id:second,name:'علبة طعام',description:'',manufacture:'تركي',quantity:10});
 first.delete(1);
 assert(!new PersistentMap('products',seeds).has(1),'Deleted demo data must not be restored');
 const id=await allocateRecordId('products');
 assert(id>second);
 const db=new DatabaseSync(databasePath);
 db.exec('BEGIN IMMEDIATE');
 const put=db.prepare("INSERT INTO app_records(kind,id,payload) VALUES('products',?,?)");
 for(let i=0;i<4200;i++){
  put.run(10000+i,JSON.stringify({id:10000+i,name:'أقداح ورقية '+i,description:'علبة عراقية',manufacture:'عراقي',quantity:25}));
 }
 db.exec('COMMIT');
 db.close();
 const reopened=new PersistentMap('products',seeds);
 const found=Array.from(reopened.values()).filter(p=>matchesArabicSearch('اقداح ورقيه',p.name,p.description,p.manufacture));
 assert.equal(found.length,4200);
 console.log('PASS: SQLite reload, 4200 materials, tolerant Arabic search, no data re-seeding');
} finally {
 rmSync(folder,{force:true,recursive:true});
}
