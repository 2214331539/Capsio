import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, initDb } from '../src/db.mjs';
import { createServer } from '../src/server.mjs';
import { hashSecret } from '../src/jwt.mjs';

// Runs against a throwaway PostgreSQL database, in its own schema so it can run beside the
// sync API tests.
const databaseUrl = process.env.TEST_DATABASE_URL;
const options = { skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run the auth API tests' };
const schemaUrl = () => {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-c search_path=auth_test');
  return url.toString();
};

const config = {
  host: '127.0.0.1',
  port: 0,
  trustProxy: false,
  get databaseUrl() {
    return schemaUrl();
  },
  jwtSecret: 'y'.repeat(40),
  jwtIssuer: 'test',
  accessTokenTtl: 900,
  refreshTokenTtl: 3600,
  oss: {},
  sms: { dryRun: true, developmentCode: '123456', developmentPhones: [] },
  officialModel: { models: [], maxBodyBytes: 4_194_304 },
};

let db;
let server;
let base;

async function post(path, body, token) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function me(token) {
  const response = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
  return response.json();
}
// The send-code endpoint allows one code a minute per number; tests reuse the stored code.
async function code(phone) {
  await db.query('DELETE FROM auth_codes WHERE phone = $1', [phone]);
  const sent = await post('/v1/auth/send-code', { phone });
  assert.equal(sent.status, 202);
  return '123456';
}

// A code put in place directly, for tests that would otherwise run into the per-address
// limit on sending codes.
async function storedCode(phone) {
  await db.query(
    `INSERT INTO auth_codes(phone, code_hash, expires_at, last_sent_at, attempts)
     VALUES ($1, $2, NOW() + INTERVAL '5 minutes', NOW() - INTERVAL '2 minutes', 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
    [phone, hashSecret(`${config.jwtSecret}:${phone}:123456`)],
  );
  return '123456';
}

before(async () => {
  if (!databaseUrl) return;
  const admin = createDb({ databaseUrl });
  await admin.query('DROP SCHEMA IF EXISTS auth_test CASCADE; CREATE SCHEMA auth_test;');
  await admin.end();
  db = createDb(config);
  await initDb(db);
  server = createServer(config, db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!databaseUrl) return;
  await new Promise((resolve) => server.close(resolve));
  await db.query('DROP SCHEMA IF EXISTS auth_test CASCADE');
  await db.end();
});

test('registering sets a password that signs in on its own', options, async () => {
  const phone = '13900000001';
  const weak = await post('/v1/auth/register', { phone, code: await code(phone), password: 'short' });
  assert.equal(weak.status, 400);
  const created = await post('/v1/auth/register', {
    phone,
    code: await code(phone),
    password: 'research2026',
  });
  assert.equal(created.status, 200);
  assert.ok(created.body.accessToken && created.body.refreshToken);
  assert.equal((await me(created.body.accessToken)).hasPassword, true);
  const again = await post('/v1/auth/register', {
    phone,
    code: await code(phone),
    password: 'another2026',
  });
  assert.equal(again.status, 409);
  const signedIn = await post('/v1/auth/password-login', { phone, password: 'research2026' });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.user.id, created.body.user.id);
  const wrong = await post('/v1/auth/password-login', { phone, password: 'research2025' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /手机号或密码不正确/);
});

test('an SMS-only account is told to use a code, and can register a password', options, async () => {
  const phone = '13900000002';
  const viaCode = await post('/v1/auth/login', { phone, code: await code(phone) });
  assert.equal(viaCode.status, 200);
  assert.equal((await me(viaCode.body.accessToken)).hasPassword, false);
  const noPassword = await post('/v1/auth/password-login', { phone, password: 'whatever2026' });
  assert.equal(noPassword.status, 400);
  assert.match(noPassword.body.error, /还没有设置密码/);
  const set = await post('/v1/auth/register', { phone, code: await code(phone), password: 'paper12345' });
  assert.equal(set.status, 200);
  assert.equal(set.body.user.id, viaCode.body.user.id, 'the same account keeps its projects');
});

test('resetting the password signs out other devices', options, async () => {
  const phone = '13900000003';
  const created = await post('/v1/auth/register', {
    phone,
    code: await code(phone),
    password: 'first12345',
  });
  const unknown = await post('/v1/auth/reset-password', {
    phone: '13900000099',
    code: await code('13900000099'),
    password: 'second12345',
  });
  assert.equal(unknown.status, 404);
  const reset = await post('/v1/auth/reset-password', {
    phone,
    code: await code(phone),
    password: 'second12345',
  });
  assert.equal(reset.status, 200);
  const stale = await post('/v1/auth/refresh', { refreshToken: created.body.refreshToken });
  assert.equal(stale.status, 401);
  assert.equal((await post('/v1/auth/password-login', { phone, password: 'first12345' })).status, 400);
  assert.equal((await post('/v1/auth/password-login', { phone, password: 'second12345' })).status, 200);
});

test('too many wrong passwords pause password sign-in for that number', options, async () => {
  const phone = '13900000004';
  await post('/v1/auth/register', { phone, code: await code(phone), password: 'right12345' });
  for (let i = 0; i < 10; i++)
    assert.equal((await post('/v1/auth/password-login', { phone, password: 'wrong12345' })).status, 400);
  const paused = await post('/v1/auth/password-login', { phone, password: 'right12345' });
  assert.equal(paused.status, 429);
});

test('wrong codes sent together still count toward the five attempts', options, async () => {
  const phone = '13900000005';
  await storedCode(phone);
  const guesses = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      post('/v1/auth/login', { phone, code: String(200000 + i) }),
    ),
  );
  assert.equal(guesses.filter((g) => g.status === 400).length, 5);
  assert.equal((await post('/v1/auth/login', { phone, code: '123456' })).status, 429);
});

test('a code signs in once, even when sent twice at once', options, async () => {
  const phone = '13900000006';
  const right = await storedCode(phone);
  const tries = await Promise.all([
    post('/v1/auth/login', { phone, code: right }),
    post('/v1/auth/login', { phone, code: right }),
  ]);
  assert.deepEqual(tries.map((t) => t.status).sort(), [200, 400]);
});

test('a refresh token works once and a bad one answers 401', options, async () => {
  const phone = '13900000007';
  const signedIn = await post('/v1/auth/login', { phone, code: await storedCode(phone) });
  assert.equal(signedIn.status, 200);
  const refreshes = await Promise.all([
    post('/v1/auth/refresh', { refreshToken: signedIn.body.refreshToken }),
    post('/v1/auth/refresh', { refreshToken: signedIn.body.refreshToken }),
  ]);
  assert.deepEqual(refreshes.map((r) => r.status).sort(), [200, 401]);
  assert.equal((await post('/v1/auth/refresh', { refreshToken: 'not-a-token' })).status, 401);
});

test('a malformed request address is refused and the server keeps going', options, async () => {
  const net = await import('node:net');
  const { port } = server.address();
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () =>
      socket.write(['GET // HTTP/1.1', 'Host: [', 'Connection: close', '', ''].join('\r\n')),
    );
    let text = '';
    socket.on('data', (chunk) => (text += chunk));
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  const health = await fetch(`${base}/v1/health`);
  assert.equal(health.status, 200);
});
