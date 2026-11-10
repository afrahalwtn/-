// Device-local encrypted offline data. No passphrase or activation code.
// Important: a user with access to the unlocked device/browser can open the
// encrypted copy. Never cache /api, cookies, CSRF or bearer tokens.
const DB='afrah-private-offline-v2';
const STORE='records';
// A preparation facility may have no internet for weeks. This is an access
// ceiling, not a promise of current inventory. Every offline screen labels age.
const TTL_MS=180*24*60*60*1000;
const encoder=new TextEncoder(),decoder=new TextDecoder();
function ensure(){
  if(!window.isSecureContext||!crypto?.subtle||!indexedDB)
    throw Error('الأوفلاين يحتاج متصفحاً حديثاً واتصال HTTPS عند أول إعداد');
}
function openDb(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB,1);
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||Error('فشل فتح التخزين المحلي'));
    request.onblocked=()=>reject(Error('أغلق تبويبات التطبيق الأخرى وأعد المحاولة'));
  });
}
async function read(key){
  const db=await openDb();
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readonly');
      const request=tx.objectStore(STORE).get(key);
      request.onsuccess=()=>resolve(request.result??null);
      request.onerror=()=>reject(request.error||Error('تعذر قراءة البيانات المحلية'));
      tx.onerror=()=>reject(tx.error||Error('تعذر قراءة التخزين المحلي'));
    });
  }finally{db.close();}
}
async function write(values){
  const db=await openDb();
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);
      tx.oncomplete=resolve;
      tx.onabort=()=>reject(tx.error||Error('فشل حفظ النسخة المحلية'));
      tx.onerror=()=>reject(tx.error||Error('فشل حفظ النسخة المحلية'));
      for(const [name,value] of Object.entries(values)){
        if(value===null)store.delete(name);
        else store.put(value,name);
      }
    });
  }finally{db.close();}
}
async function encrypt(key,value){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  return {iv,ciphertext:await crypto.subtle.encrypt(
    {name:'AES-GCM',iv},key,encoder.encode(JSON.stringify(value)))};
}
async function decrypt(key,record){
  const bytes=await crypto.subtle.decrypt(
    {name:'AES-GCM',iv:record.iv},key,record.ciphertext);
  return JSON.parse(decoder.decode(bytes));
}
function validateDraft(draft){
  return (Array.isArray(draft)?draft:[]).filter(row=>
    Number.isSafeInteger(row?.product_id)&&row.product_id>0&&
    Number.isSafeInteger(row?.quantity)&&row.quantity>=1&&row.quantity<=100000000
  ).slice(0,500).map(row=>({product_id:row.product_id,quantity:row.quantity}));
}
function validSnapshot(data,portal,{allowExpired=false}={}){
  return data?.portal===portal&&data?.user?.id>0&&
    Array.isArray(data.products)&&typeof data.generation==='string'&&data.generation.length>0&&
    Number.isFinite(data.updatedAt)&&(allowExpired||Date.now()-data.updatedAt<=TTL_MS)&&
    data.updatedAt<=Date.now()+60000;
}
export function makeOfflineVault(portal){
  if(!['admin','staff'].includes(portal))throw Error('Invalid vault');
  const prefix=portal+':';
  let key=null,owner=null,generation=null,pending=Promise.resolve(),lastDraft=null;
  const lock=()=>{key=null;owner=null;generation=null;lastDraft=null;};
  return {
    get unlocked(){return Boolean(key);},
    get accountId(){return owner;},
    get generation(){return generation;},
    async hasSnapshot(){ensure();return Boolean(await read(prefix+'snapshot'));},
    async enable(payload,draft=[],serverGeneration){
      ensure();
      if(typeof serverGeneration!=='string'||!serverGeneration)
        throw Error('لم تفعّل الإدارة الأوفلاين');
      if(!navigator.serviceWorker)throw Error('المتصفح لا يدعم الأوفلاين');
      // Login can complete before the service worker finishes installing.
      // Wait for activation, but never hang the normal online application.
      const registration=await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_,reject)=>setTimeout(()=>reject(
          Error('تعذّر تجهيز أوفلاين على هذا الجهاز؛ افتح التطبيق بالإنترنت مجدداً')),6500))
      ]);
      if(!registration?.active)throw Error('أعد فتح التطبيق بالإنترنت حتى تكتمل ملفات الأوفلاين');
      if(!payload?.user?.id||!Array.isArray(payload.products))
        throw Error('يلزم تسجيل الدخول وتحميل الايتمات أولاً');
      // Reuse the browser-bound key for the same account; do not overwrite
      // an existing pending draft on subsequent online refreshes.
      // Note: never rotate another account's device key without checking for pending work.
      if(!key||owner!==payload.user.id||generation!==serverGeneration){
        try{
          const existing=await this.unlock({ignoreBlock:true,allowExpired:true});
          if(existing.user.id!==payload.user.id){
            if(existing.pendingLists.length||existing.draft.length)throw Error('قوائم أو مسودات مستخدم آخر غير مرسلة؛ لا يمكن استبدالها');
            lock();
          }
        }catch(error){
          if(error?.message?.includes('لا يمكن استبدالها'))throw error;
          lock();
        }
      }
      if(!key){
        key=await crypto.subtle.generateKey(
          {name:'AES-GCM',length:256},false,['encrypt','decrypt']);
      }
      owner=payload.user.id;
      generation=serverGeneration;
      const updatedAt=Date.now();
      const normalized=validateDraft(draft);
      const snapshot=await encrypt(key,{...payload,portal,generation,updatedAt});
      const previous=await read(prefix+'draft');
      const draftValue=previous&&lastDraft!==null?previous:
        await encrypt(key,{draft:normalized,updatedAt});
      await write({[prefix+'snapshot']:{...snapshot,key},
        [prefix+'draft']:draftValue,[prefix+'blocked']:null});
      lastDraft=previous&&lastDraft!==null?lastDraft:JSON.stringify(normalized);
      return updatedAt;
    },
    async unlock({ignoreBlock=false,allowExpired=false}={}){
      ensure();
      if(!ignoreBlock&&await read(prefix+'blocked'))throw Error('أوقفت الإدارة الأوفلاين على هذا الجهاز؛ يلزم الاتصال بالخادم');
      const snapshot=await read(prefix+'snapshot');
      if(!snapshot)throw Error('ماكو نسخة أوفلاين محفوظة على هذا الجهاز');
      const data=await decrypt(snapshot.key,snapshot);
      if(!validSnapshot(data,portal,{allowExpired}))
        throw Error('انتهت صلاحية النسخة المحلية أو صارت غير صالحة؛ اتصل بالإنترنت');
      const record=await read(prefix+'draft');
      const draftValue=record?await decrypt(snapshot.key,record):{};
      const draft=validateDraft(draftValue.draft);
      key=snapshot.key;owner=data.user.id;generation=data.generation;
      lastDraft=JSON.stringify(draft);
      const outboxRecord=await read(prefix+'outbox');
      const outbox=outboxRecord?await decrypt(snapshot.key,outboxRecord):{lists:[]};
      const pendingLists=Array.isArray(outbox?.lists)?outbox.lists.filter(x=>
        /^[0-9a-f-]{36}$/i.test(x?.client_request_id)&&Array.isArray(x.items)&&
        x.items.length>0&&x.items.length<=500).slice(0,500):[];
      return {...data,draft,pendingLists};
    },
    async saveDraft(draft){
      if(!key)return;
      const normalized=validateDraft(draft),signature=JSON.stringify(normalized);
      if(signature===lastDraft)return pending;
      const ownedKey=key;
      pending=pending.catch(()=>{}).then(async()=>{
        if(!key||key!==ownedKey)return;
        const record=await encrypt(ownedKey,{draft:normalized,updatedAt:Date.now()});
        await write({[prefix+'draft']:record});
        lastDraft=signature;
      });
      return pending;
    },

    async blockOffline(){
      // Keep the encrypted pending outbox until the server acknowledges it.
      await write({[prefix+'blocked']:true});
    },
    async listPending(){
      if(!key)return [];
      await pending.catch(()=>{});
      const record=await read(prefix+'outbox');
      const data=record?await decrypt(key,record):{lists:[]};
      return Array.isArray(data?.lists)?data.lists:[];
    },
    async enqueueExecutionList(draft,{deductStock=false}={}){
      if(!key||!owner)throw Error('يلزم فتح نسخة الأوفلاين على هذا الجهاز');
      const items=validateDraft(draft);
      if(items.length<1||items.length>500||items.length!==draft.length)
        throw Error('القائمة تحتاج من 1 إلى 500 أيتم بأعداد صحيحة');
      const item={client_request_id:crypto.randomUUID(),items,created_at:new Date().toISOString(),deduct_stock:deductStock===true};
      const ownedKey=key;
      pending=pending.catch(()=>{}).then(async()=>{
        if(!key||key!==ownedKey)throw Error('تم قفل النسخة المحلية قبل الحفظ');
        const old=await read(prefix+'outbox');
        const lists=old?(await decrypt(ownedKey,old))?.lists||[]:[];
        if(!Array.isArray(lists)||lists.length>=2000)
          throw Error('وصل الجهاز إلى حد القوائم غير المزامنة. وصّله بالإنترنت أولاً');
        const now=Date.now();
        const outbox=await encrypt(ownedKey,{lists:[...lists,item]});
        const draftRecord=await encrypt(ownedKey,{draft:[],updatedAt:now});
        await write({[prefix+'outbox']:outbox,[prefix+'draft']:draftRecord});
        lastDraft='[]';
      });
      await pending;
      return item;
    },
    async acknowledgeExecutionList(clientRequestId){
      if(!key||!owner)throw Error('لا توجد جلسة أوفلاين لحفظ تأكيد المزامنة');
      const ownedKey=key;
      pending=pending.catch(()=>{}).then(async()=>{
        if(!key||key!==ownedKey)throw Error('تغيّر حساب الجهاز أثناء المزامنة');
        const old=await read(prefix+'outbox');
        if(!old)return;
        const lists=(await decrypt(ownedKey,old))?.lists;
        if(!Array.isArray(lists))throw Error('قوائم الجهاز المحلية غير صالحة');
        const next=lists.filter(x=>x.client_request_id!==clientRequestId);
        if(next.length===lists.length)return;
        await write({[prefix+'outbox']:await encrypt(ownedKey,{lists:next})});
      });
      await pending;
    },
    async refreshSnapshot(payload,serverGeneration){
      if(!key||owner!==payload?.user?.id||generation!==serverGeneration)return;
      const ownedKey=key;
      pending=pending.catch(()=>{}).then(async()=>{
        if(!key||key!==ownedKey)return;
        const updatedAt=Date.now();
        const record=await encrypt(ownedKey,{...payload,portal,generation,updatedAt});
        await write({[prefix+'snapshot']:{...record,key:ownedKey}});
      });
      return pending;
    },
    lock,
    async clear(){
      lock();
      await pending.catch(()=>{});
      await write({[prefix+'snapshot']:null,[prefix+'draft']:null,[prefix+'outbox']:null,[prefix+'blocked']:null});
    }
  };
}
