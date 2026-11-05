import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = 43187;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
  env: { ...process.env, PORT: String(port), AFRAH_SECURE_COOKIES: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', data => { logs += data.toString(); });
server.stderr.on('data', data => { logs += data.toString(); });

async function request(path, opts = {}) {
  return fetch(origin + '/api' + path, { cache:'no-store', ...opts });
}

try {
  let live = false;
  for (let i=0; i<60; i++) {
    try {
      const res = await request('/health');
      if (res.ok && (await res.json()).status === 'ok') { live = true; break; }
    } catch {}
    if (server.exitCode !== null) break;
    await delay(500);
  }
  assert(live, 'Server did not start: ' + logs);

  const login = await request('/auth/login', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'admin',password:'admin123456'}),
  });
  assert.equal(login.status, 200, 'Demo credentials should work with the real API');
  const session = await login.json();
  assert.match(session.access_token, /^[A-Za-z0-9_-]{48}$/, 'Login returns an ephemeral access token');
  assert.equal(typeof session.csrf,'string');

  const anonymous = await request('/products');
  assert.equal(anonymous.status,401,'No session must remain unauthorized');

  const auth = { Authorization:'Bearer ' + session.access_token };
  const withToken = await request('/products',{headers:auth});
  assert.equal(withToken.status,200,'Explicit bearer token must authenticate without cookies');
  assert(Array.isArray(await withToken.json()));

  const me = await request('/me',{headers:auth});
  assert.equal(me.status,200,'Session is accepted by /me');
  assert.equal((await me.json()).user.role,'admin');

  const missingCsrf = await request('/products',{
    method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{}',
  });
  assert.equal(missingCsrf.status,403,'CSRF check must remain enabled');

  const badLogin = await request('/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'admin',password:'wrong'}),
  });
  assert.equal(badLogin.status,401,'Wrong passwords must still be rejected');

  const logout = await request('/auth/logout',{
    method:'POST',headers:{...auth,'X-CSRF-Token':session.csrf},
  });
  assert.equal(logout.status,200,'Logout must revoke the bearer session');

  const revoked = await request('/me',{headers:auth});
  assert.equal(revoked.status,401,'Revoked token must no longer work');

  console.log('PASS: login, bearer without cookies, protected endpoints, CSRF, wrong password, logout');
} finally {
  server.kill('SIGTERM');
}
