// Private offline data is NEVER stored in Cache Storage or in plaintext.
// Opt-in encrypted IndexedDB vault, scoped to a single portal/browser profile.
// Access expires after 72h without online reauthentication; revocations cannot
// be checked during a network outage. No background stock/price mutation queue.
const DB='afrah-private-offline-v1';
const STORE='records';
const TTL_MS=72*60*60*1000;
const encoder=new TextEncoder();
const decoder=new TextDecoder();
function supported(){
  return Boolean(window.isSecureContext && crypto?.subtle && indexedDB);
}
function openDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB,1);
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE);};
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error||Error('تعذّر فتح مساحة التخزين على الجهاز'));
    req.onblocked=()=>reject(Error('أغلق التبويبات الأخرى للتطبيق ثم حاول مرة ثانية'));
  });
}
async function transact(mode,work){
  const db=await openDb();
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,mode),store=tx.objectStore(STORE);
      let result;
      tx.oncomplete=()=>resolve(result);
      tx.onerror=()=>reject(tx.error||Error('فشل حفظ البيانات على هذا الجهاز'));
      tx.onabort=()=>reject(tx.error||Error('تم إلغاء التخزين المحلي'));
      try{result=work(store);}catch(error){tx.abort();reject(error);}
    });
  }finally{db.close();}
}
function read(key){
  return new Promise(async(resolve,reject)=>{
    let db;
    try{
      db=await openDb();
      const tx=db.transaction(STORE,'readonly');
      const req=tx.objectStore(STORE).get(key);
      req.onsuccess=()=>resolve(req.result??null);
      req.onerror=()=>reject(req.error||Error('تعذّر قراءة النسخة المحلية'));
      tx.oncomplete=()=>db.close();
      tx.onerror=()=>db.close();
    }catch(error){db?.close();reject(error);}
  });
}
function ensure(){
  if(!supported())throw Error('التخزين المشفّر يتطلب سفاري أو متصفحاً حديثاً واتصال HTTPS عند الإعداد');
}
async function derive(passphrase,salt){
  if(typeof passphrase!=='string'||passphrase.length<10||passphrase.length>256)
    throw Error('اكتب عبارة حماية من 10 رموز على الأقل');
  const original=await crypto.subtle.importKey('raw',encoder.encode(passphrase),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'PBKDF2',hash:'SHA-256',salt,iterations:240000},
    original,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function encrypt(key,value){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode(JSON.stringify(value)));
  return {iv,encrypted};
}
async function decrypt(key,record){
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:record.iv},key,record.encrypted);
  return JSON.parse(decoder.decode(plain));
}
export function makeOfflineVault(portal){
  if(!['admin','staff'].includes(portal))throw Error('Invalid vault');
  const prefix=portal+':';
  let key=null,owner=null,pending=Promise.resolve(),lastDraft=null;
  async function writeBatch(values){
    await transact('readwrite',store=>{
      for(const [name,value] of Object.entries(values))store.put(value,prefix+name);
    });
  }
  return {
    get unlocked(){return Boolean(key);},
    get accountId(){return owner;},
    async hasSnapshot(){ensure();return Boolean(await read(prefix+'snapshot'));},
    async enable(passphrase,payload,draft=[]){
      ensure();
      if(!navigator.serviceWorker)throw Error('المتصفح لا يدعم تشغيل الواجهة دون إنترنت');
      const registration=await navigator.serviceWorker.getRegistration('/');
      if(!registration?.active)throw Error('أعد تحميل التطبيق بالإنترنت أولاً حتى تكتمل ملفات الأوفلاين');
      if(!payload?.user?.id||!Array.isArray(payload.products))throw Error('يلزم الدخول إلى الحساب وتحميل الايتمات أولاً');
      const salt=crypto.getRandomValues(new Uint8Array(16));
      const nextKey=await derive(passphrase,salt);
      const updatedAt=Date.now();
      const snapshot=await encrypt(nextKey,{...payload,portal,updatedAt});
      const draftRecord=await encrypt(nextKey,{draft,updatedAt});
      await writeBatch({snapshot:{...snapshot,salt,updatedAt},draft:draftRecord});
      key=nextKey;owner=payload.user.id;lastDraft=JSON.stringify(draft);
      return updatedAt;
    },
    async unlock(passphrase){
      ensure();
      const snapshotRecord=await read(prefix+'snapshot');
      if(!snapshotRecord)throw Error('لا توجد بيانات أوفلاين محفوظة. فعّلها أولاً أثناء اتصال الإنترنت');
      try{
        const nextKey=await derive(passphrase,snapshotRecord.salt);
        const data=await decrypt(nextKey,snapshotRecord);
        if(data.portal!==portal||!data.user?.id||!Array.isArray(data.products))
          throw Error('النسخة المحلية غير صالحة');
        if(!Number.isFinite(data.updatedAt)||Date.now()-data.updatedAt>TTL_MS||data.updatedAt>Date.now()+60000)
          throw Error('انتهت صلاحية النسخة المحلية؛ سجّل الدخول بالإنترنت وحدّثها');
        const draftRecord=await read(prefix+'draft');
        const draftData=draftRecord?await decrypt(nextKey,draftRecord):null;
        const draft=Array.isArray(draftData?.draft)?draftData.draft.filter(row=>
          Number.isSafeInteger(row.product_id)&&Number.isSafeInteger(row.quantity)&&
          row.quantity>=1&&row.quantity<=100000000).slice(0,4000):[];
        key=nextKey;owner=data.user.id;lastDraft=JSON.stringify(draft);
        return {...data,draft};
      }catch(error){
        this.lock();
        if(error?.name==='OperationError')throw Error('عبارة الحماية غير صحيحة أو النسخة المحلية تالفة');
        throw error;
      }
    },
    async saveDraft(draft){
      if(!key)return;
      const normalized=draft.map(row=>({product_id:Number(row.product_id),quantity:Number(row.quantity)}))
        .filter(row=>Number.isSafeInteger(row.product_id)&&Number.isSafeInteger(row.quantity)&&row.quantity>=1&&row.quantity<=100000000)
        .slice(0,4000);
      const signature=JSON.stringify(normalized);
      if(signature===lastDraft)return;
      pending=pending.catch(()=>{}).then(async()=>{
        const record=await encrypt(key,{draft:normalized,updatedAt:Date.now()});
        await writeBatch({draft:record});
        lastDraft=signature;
      });
      return pending;
    },
    async refreshSnapshot(payload){
      if(!key||!payload?.user?.id||payload.user.id!==owner)return;
      pending=pending.catch(()=>{}).then(async()=>{
        const existing=await read(prefix+'snapshot');
        if(!existing)return;
        const updatedAt=Date.now();
        const record=await encrypt(key,{...payload,portal,updatedAt});
        await writeBatch({snapshot:{...record,salt:existing.salt,updatedAt}});
      });
      return pending;
    },
    lock(){key=null;owner=null;lastDraft=null;},
    async clear(){
      this.lock();
      await transact('readwrite',store=>{store.delete(prefix+'snapshot');store.delete(prefix+'draft');});
    }
  };
}
