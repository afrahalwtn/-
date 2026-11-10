// Locale-aware numeric entry for iOS Safari and other Arabic keyboards.
// No input type="number": WebKit may reject Arabic-Indic numerals or hide decimals.
const ARABIC_DIGITS='٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS='۰۱۲۳۴۵۶۷۸۹';
export function parseLocalizedNumber(value,{integer=false,optional=false,min=0,max=1000000000000}={}){
  let raw=String(value??'').trim();
  if(!raw){
    if(optional)return null;
    throw new Error('اكتب الرقم قبل الحفظ');
  }
  raw=raw.replace(/[٠-٩۰-۹]/g,d=>{
    const n=ARABIC_DIGITS.indexOf(d);
    return String(n>=0?n:PERSIAN_DIGITS.indexOf(d));
  }).replace(/[\u00a0\u202f\s]/g,'')
    .replace(/٬/g,',').replace(/٫/g,'.');
  // 1,250 and ١٬٢٥٠ are thousands; 1,5 is a decimal only for non-integers.
  if(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw))raw=raw.replace(/,/g,'');
  else if(!integer && /^\d+,\d{1,2}$/.test(raw))raw=raw.replace(',','.');
  if(!/^\d+(\.\d+)?$/.test(raw))
    throw new Error('اكتب رقماً صحيحاً بالأرقام العربية أو الإنجليزية، بدون حروف أو رموز');
  const number=Number(raw);
  if(!Number.isFinite(number)||(integer&&!Number.isSafeInteger(number))||number<min||number>max)
    throw new Error('الرقم خارج الحدود المسموحة');
  return number;
}
// Tabulator custom editor: text-input + numeric keyboard works reliably in Safari.
export function quantityEditor(cell,onRendered,success,cancel){
  const input=document.createElement('input');
  input.type='text';
  input.inputMode='numeric';
  input.dir='ltr';
  input.autocomplete='off';
  input.setAttribute('aria-label','العدد');
  input.value=String(cell.getValue()??'');
  input.style.cssText='box-sizing:border-box;width:100%;min-width:0;min-height:36px;font-size:16px;text-align:center;';
  let done=false;
  const finish=()=>{
    if(done)return;
    try{
      const n=parseLocalizedNumber(input.value,{integer:true,min:1,max:100000000});
      done=true;success(n);
    }catch{
      done=true;cancel();
    }
  };
  input.addEventListener('blur',finish);
  input.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();finish();}
    if(event.key==='Escape'){event.preventDefault();done=true;cancel();}
  });
  onRendered(()=>{input.focus();input.select();});
  return input;
}
