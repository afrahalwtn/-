import crypto from 'node:crypto';

// Scrypt with random salt; only the encoded hash is persisted in SQLite.
// Test/demo credentials remain valid, but the passwords themselves are never stored.
export function hashPassword(password:string):string {
  if(typeof password!=='string'||password.length<8||password.length>1024)throw Error('Invalid password');
  const salt=crypto.randomBytes(16);
  const result=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1});
  return 'scrypt$'+salt.toString('hex')+'$'+result.toString('hex');
}
export function verifyPassword(input:string,stored:string):boolean {
  if(typeof input!=='string'||typeof stored!=='string')return false;
  const parts=stored.split('$');
  if(parts.length!==3||parts[0]!=='scrypt'||!/^[a-f0-9]{32}$/i.test(parts[1])||!/^[a-f0-9]{128}$/i.test(parts[2]))return false;
  const expected=Buffer.from(parts[2],'hex');
  const candidate=crypto.scryptSync(input,Buffer.from(parts[1],'hex'),64,{N:16384,r:8,p:1});
  return crypto.timingSafeEqual(candidate,expected);
}
