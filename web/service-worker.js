/* Offline shell only; NEVER cache /api, account data, or protected images. */
const CACHE='afrah-static-20261110-v2';
const CORE=[
  '/','/admin','/web/styles.css','/web/tabler-afrah.css','/web/koa-theme.css',
  '/web/afrah-clean.css','/web/afrah-layout-v5.css','/web/account-portal.css',
  '/web/staff-portal.css','/web/afrah-brand-2026.css','/web/afrah-stability.css',
  '/web/index.html','/web/admin.html','/web/app.js','/web/admin-app.js',
  '/web/api.js','/web/icons.js','/web/arabic-search.js','/web/numeric-input.js',
  '/web/portal-handoff.js','/web/offline-vault.js','/web/offline-register.js',
  '/vendor/tabulator.min.js','/vendor/tabulator.min.css','/vendor/tabler.rtl.min.css',
  '/vendor/tajawal/400.css','/vendor/tajawal/500.css',
  '/vendor/tajawal/700.css','/vendor/tajawal/800.css','/vendor/tajawal/900.css',
  '/assets/afrah-alwatan.svg','/assets/tapello.svg',
  '/web/manifest.webmanifest'
];
const allowed=(url)=>
  url.origin===self.location.origin &&
  !url.pathname.startsWith('/api/') &&
  (url.pathname==='/' || url.pathname==='/admin' || url.pathname==='/admin/' ||
   url.pathname.startsWith('/web/') || url.pathname.startsWith('/assets/') ||
   url.pathname.startsWith('/vendor/'));
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await Promise.all(CORE.map(async path=>{
      try{
        const response=await fetch(path,{credentials:'same-origin',cache:'reload'});
        if(response.ok && response.type==='basic' && !path.startsWith('/api/'))
          await cache.put(path,response);
      }catch{} // One offline asset must not prevent installing the shell.
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key.startsWith('afrah-static-')&&key!==CACHE).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(!allowed(url))return;
  if(request.mode==='navigate'){
    event.respondWith((async()=>{
      try{
        const response=await fetch(request);
        if(response.ok && response.type==='basic'){
          const cache=await caches.open(CACHE);
          await cache.put(url.pathname==='/admin/'?'/admin':url.pathname,response.clone());
        }
        return response;
      }catch{
        const cache=await caches.open(CACHE);
        return await cache.match(url.pathname==='/admin/'?'/admin':url.pathname) ||
          await cache.match(url.pathname.startsWith('/admin')?'/admin':'/') ||
          Response.error();
      }
    })());
    return;
  }
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const existing=await cache.match(request) || await cache.match(request,{ignoreSearch:true});
    if(existing)return existing;
    try{
      const response=await fetch(request);
      if(response.ok && response.type==='basic' && !response.headers.get('Cache-Control')?.includes('private'))
        await cache.put(request,response.clone());
      return response;
    }catch{return Response.error();}
  })());
});
