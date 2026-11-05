// Same-origin portal switch via a one-use 30-second server ticket.
// Session tokens remain in JS memory and are never put in URLs or storage.
const TICKET_KEY='afrah:portal-handoff:once';
export async function switchPortal(api,destination){
  if(destination!=='/'&&destination!=='/admin')throw Error('مسار الانتقال غير صالح');
  const result=await api('/auth/handoff',{method:'POST'});
  if(!result?.ticket)throw Error('تعذر إنشاء جلسة الانتقال');
  sessionStorage.setItem(TICKET_KEY,result.ticket);
  location.assign(destination);
}
export async function resumePortal(api,setAccessToken,setCsrf){
  const ticket=sessionStorage.getItem(TICKET_KEY);
  if(!ticket)return false;
  // Remove before network request to ensure at-most-once redemption.
  sessionStorage.removeItem(TICKET_KEY);
  const result=await api('/auth/handoff/exchange',{method:'POST',data:{ticket}});
  if(!result?.access_token||!result?.csrf||result?.user?.role!=='admin'){
    throw Error('تعذر التحقق من جلسة الانتقال');
  }
  setAccessToken(result.access_token);
  setCsrf(result.csrf);
  return true;
}
