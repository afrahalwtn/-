import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const tmp=mkdtempSync(path.join(os.tmpdir(),'afrah-credentials-'));
const origin='http://127.0.0.1:43952/api';
const child=spawn(process.execPath,['--import','tsx','server.ts'],{
 env:{...process.env,SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',AFRAH_ADMIN_RESET_PASSWORD:'',AFRAH_ADMIN_PASSWORD:'',AFRAH_STAFF_PASSWORD:'',AFRAH_TRUST_PROXY_HOPS:'0',NODE_ENV:'development',PORT:'43952',AFRAH_DATA_DIR:tmp,AFRAH_ENABLE_ADMIN_RECOVERY:'1',AFRAH_SECURE_COOKIES:'false'},
 stdio:['ignore','pipe','pipe']
});
let stdout='';
child.stdout.on('data',chunk=>stdout+=chunk.toString());
child.stderr.on('data',chunk=>stdout+=chunk.toString());
const call=(route,opts={})=>fetch(origin+route,{cache:'no-store',...opts});
const post=(route,data,session)=>call(route,{
 method:'POST',
 headers:{'Content-Type':'application/json',
  ...(session?{Authorization:'Bearer '+session.access_token,'X-CSRF-Token':session.csrf}:{})},
 body:JSON.stringify(data),
});
const login=async(route,username,password)=>{
 const res=await post(route,{username,password});
 return {status:res.status,body:await res.json()};
};
try{
 let ready=false;
 for(let i=0;i<80;i++){
  try{if((await call('/health')).ok){ready=true;break;}}catch{}
  if(child.exitCode!==null)break;
  await delay(250);
 }
 assert(ready,'Server not available: '+stdout);
 const adminLogin=await login('/admin/auth/login','admin','admin123456');
 assert.equal(adminLogin.status,200,'Fresh admin login should work');
 const admin=adminLogin.body;
 const staff=await login('/staff/auth/login','staff','staff123456');
 assert.equal(staff.status,200,'Fresh employee login should work');
 const adminViaStaff=await login('/staff/auth/login','admin','admin123456');
 assert.equal(adminViaStaff.status,200,'Admin may enter staff gate using admin credentials');
 assert.equal(adminViaStaff.body.user.role,'admin');
 assert.equal((await post('/auth/handoff',{},staff.body)).status,403,'Employee cannot get admin handoff ticket');
 assert.equal((await call('/admin/me',{headers:{Authorization:'Bearer '+staff.body.access_token}})).status,403);

 const handoff=await post('/auth/handoff',{},admin);
 assert.equal(handoff.status,200);
 const ticket=(await handoff.json()).ticket;
 assert.match(ticket,/^[A-Za-z0-9_-]{43}$/);
 const first=await post('/auth/handoff/exchange',{ticket});
 assert.equal(first.status,200,'Admin handoff redeems without employee credentials');
 const transferred=await first.json();
 assert.equal(transferred.user.role,'admin');
 assert.equal((await call('/admin/me',{headers:{Authorization:'Bearer '+transferred.access_token}})).status,200);
 assert.equal((await post('/auth/handoff/exchange',{ticket})).status,401,'Handoff is single-use');
 assert.equal((await call('/admin/me',{headers:{Authorization:'Bearer '+admin.access_token}})).status,401,'Old session is invalidated after handoff');

 assert.equal((await post('/auth/change-credentials',{
  username:'new_admin',current_password:'wrong_current',
 },transferred)).status,403,'Old password verification required');

 const changed=await post('/auth/change-credentials',{
  username:'owner_new',current_password:'admin123456',new_password:'OwnerSafe2026!super',
 },transferred);
 assert.equal(changed.status,200,'Admin sets own username and password from dashboard');
 assert.equal((await changed.json()).user.username,'owner_new');
 assert.equal((await login('/admin/auth/login','admin','admin123456')).status,401,'Old admin credentials no longer work');
 assert.equal((await login('/admin/auth/login','owner_new','OwnerSafe2026!super')).status,200,'New admin credentials work');

 const owner=(await login('/admin/auth/login','owner_new','OwnerSafe2026!super')).body;
 const update=await call('/users/2',{
  method:'PATCH',
  headers:{'Content-Type':'application/json',Authorization:'Bearer '+owner.access_token,'X-CSRF-Token':owner.csrf},
  body:JSON.stringify({username:'employee_new',password:'EmployeeSafe2026!',full_name:'موظف الشركة'}),
 });
 assert.equal(update.status,200,'Admin can manually change staff credentials');
 assert.equal((await login('/staff/auth/login','staff','staff123456')).status,401,'Old staff password rejected');
 assert.equal((await login('/staff/auth/login','employee_new','EmployeeSafe2026!')).status,200);
 const staffSession=(await login('/staff/auth/login','employee_new','EmployeeSafe2026!')).body;
 const staffSelf=await post('/auth/change-credentials',{
  current_password:'EmployeeSafe2026!',username:'employee_own',new_password:'EmployeeOwn2026!',
 },staffSession);
 assert.equal(staffSelf.status,200,'Staff can change their own credentials, not admin credentials');
 assert.equal((await login('/staff/auth/login','employee_own','EmployeeOwn2026!')).status,200);

 const code=(stdout.match(/AFRAH ADMIN RECOVERY \(10 minutes, one use\): ([A-Za-z0-9_-]{24})/)||[])[1];
 assert(code,'Recovery code must be present only on server console');
 assert.equal((await post('/admin/recover',{
  recovery_code:'not_the_correct_recovery',username:'owner_restored',new_password:'RecoveredStrong2026!',
 })).status,403);
 const recovery=await post('/admin/recover',{
  recovery_code:code,username:'owner_restored',new_password:'RecoveredStrong2026!',
 });
 assert.equal(recovery.status,200,'Owner can set a fresh admin login with console-only code');
 assert.equal((await recovery.json()).user.username,'owner_restored');
 assert.equal((await login('/admin/auth/login','owner_new','OwnerSafe2026!super')).status,401);
 assert.equal((await login('/admin/auth/login','owner_restored','RecoveredStrong2026!')).status,200);
 assert.equal((await post('/admin/recover',{
  recovery_code:code,username:'should_not_work',new_password:'InvalidReplay2026!',
 })).status,404,'Recovery is strictly one-use');

 console.log('PASS: both logins, admin staff view, one-use transition, manual passwords, staff edit and owner recovery');
}finally{
 child.kill('SIGTERM');
 await delay(250);
 rmSync(tmp,{force:true,recursive:true});
}
