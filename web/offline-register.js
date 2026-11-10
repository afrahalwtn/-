// Registration is a progressive enhancement. Preview contexts may lack SW access.
if('serviceWorker' in navigator && window.isSecureContext){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(error=>{
      console.warn('Offline shell not available:',error?.message||error);
    });
  },{once:true});
}
