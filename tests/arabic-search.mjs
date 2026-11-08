import assert from 'node:assert/strict';
import {normalizeArabicSearch, matchesArabicSearch, filterArabicProducts} from '../web/arabic-search.js';
for (const [a,b] of [
 ['أقداح','اقداح'],['آقداح','اقداح'],['إنتاج','انتاج'],['ٱقداح','اقداح'],
 ['علبة','علبه'],['مصنعة','مصنعه'],['ورقى','ورقي'],['نایلون','نايلون'],
 ['كرتون','کرتون'],['مُعَلّبَة','معلبه'],['رولــــ','رول'],['٢٠٢٧','2027'],
 ['مقاس ۳۰۰','مقاس 300'],['أكواب','اكْوَاب']
]) {
 assert.equal(normalizeArabicSearch(a),normalizeArabicSearch(b),a+' must equal '+b);
}
const products=[
 {id:1,name:'أقداح ورقية ٢٠٢٧',description:'بلد المنشأ: العراق',manufacture:'مصنعة عراقياً'},
 {id:2,name:'علبة طعام',description:'رول نايلون 45 سم',manufacture:'تركي'},
 {id:3,name:'ورقى كرافت',description:'أكواب ورقية 8 أونص',manufacture:'إماراتي'},
];
assert.deepEqual(filterArabicProducts(products,'اقداح'),[products[0]]);
assert.deepEqual(filterArabicProducts(products,'اقداح ورقيه'),[products[0]]);
assert.deepEqual(filterArabicProducts(products,'ورقيه اقداح'),[products[0]]);
assert.deepEqual(filterArabicProducts(products,'علبه'),[products[1]]);
assert.deepEqual(filterArabicProducts(products,'نايلون رول'),[products[1]]);
assert.deepEqual(filterArabicProducts(products,'2027'),[products[0]]);
assert.deepEqual(filterArabicProducts(products,'کرافت'),[products[2]]);
assert.equal(matchesArabicSearch('أكْوَاب ورقية',products[2].name,products[2].description),true);
assert.equal(matchesArabicSearch('اجهزة',products[0].name,products[0].description),false);
assert.equal(matchesArabicSearch('   ',products[0].name),true);
// Cached search text must not become stale after a direct item edit.
const changing={id:44,name:'رول نايلون',description:'صنع عراقي',custom_fields:[{label:'النوع',value:'ورقي'}]};
assert.deepEqual(filterArabicProducts([changing],'نايلون'),[changing]);
changing.name='علبة بلاستك';
assert.deepEqual(filterArabicProducts([changing],'نايلون'),[]);
assert.deepEqual(filterArabicProducts([changing],'بلاستك'),[changing]);
changing.custom_fields[0].value='معدني';
assert.deepEqual(filterArabicProducts([changing],'معدني'),[changing]);
assert.deepEqual(filterArabicProducts([changing],'ورقي'),[]);
changing.description='صنع تركي';
assert.deepEqual(filterArabicProducts([changing],'عراقي'),[]);
assert.deepEqual(filterArabicProducts([changing],'تركي'),[changing]);
// A fresh API catalogue replaces objects and must not inherit stale cache keys.
assert.deepEqual(filterArabicProducts([{id:44,name:'أقداح حديثة'}],'اقداح').map(p=>p.id),[44]);
assert.deepEqual(filterArabicProducts([{id:44,name:'أقداح حديثة'}],'بلاستك'),[]);
const tenThousand=Array.from({length:10000},(_,i)=>({
 id:i+1,name:'مادة '+i+' أقداح ورقية',description:'علبة ٢٠٢٧ نوع ممتاز',manufacture:i%2?'تركي':'عراقي'
}));
const start=performance.now();
for(let i=0;i<20;i++) {
  const result=filterArabicProducts(tenThousand,'اقداح ورقيه',12);
  assert.equal(result.length,12);
}
console.log('PASS Arabic orthography cases and 10,000-product search simulation ('+Math.round(performance.now()-start)+'ms for 20 filtered searches)');
