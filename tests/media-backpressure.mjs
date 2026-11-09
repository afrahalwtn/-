import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {apiMedia} from '../web/api.js';
const originalFetch=globalThis.fetch;
let active=0,peak=0,requests=0;
try{
 globalThis.fetch=async (url)=>{
  active++;peak=Math.max(peak,active);requests++;
  try{
   await delay(15);
   if(String(url).includes('ffffffffffffffffffffffffffffffff'))
     throw new TypeError('simulated network loss');
   return new Response(new Blob([Uint8Array.of(137,80,78,71)],{type:'image/png'}),{status:200});
  }finally{active--;}
 };
 const urls=Array.from({length:35},(_,i)=>'/images/'+i.toString(16).padStart(32,'0')+'.png');
 const all=await Promise.all(urls.map(u=>apiMedia(u)));
 assert.equal(all.length,35);
 assert.equal(requests,35,'Each requested image is attempted exactly once');
 assert(peak>1&&peak<=5,'At most five simultaneous image downloads, observed '+peak);
 const fail=await Promise.allSettled([
  apiMedia('/images/ffffffffffffffffffffffffffffffff.png'),
  apiMedia('/images/000000000000000000000000000000ff.png')
 ]);
 assert.equal(fail[0].status,'rejected');
 assert.equal(fail[1].status,'fulfilled');
 // Failed fetches must return the concurrency permit to the pool.
 const recovered=await apiMedia('/images/000000000000000000000000000000fe.png');
 assert.equal(recovered.type,'image/png');
 console.log('PASS: queued media fetches max concurrency='+peak+', permits recovered after failure');
}finally{
 globalThis.fetch=originalFetch;
}
