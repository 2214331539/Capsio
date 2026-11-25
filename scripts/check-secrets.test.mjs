import test from 'node:test';
import assert from 'node:assert/strict';
import { findings, pushRanges, sshDetails } from './check-secrets.mjs';

// The made-up secrets below are put together at run time, so that this file does not itself
// look like it holds one, to this check or to GitHub's.
const made = (...parts) => parts.join('');

test('keys, tokens and passwords are refused', () => {
  const refused = (path, line, expected) => assert.deepEqual(findings(path, line), expected, line);
  refused('notes.md', made('-----BEGIN OPENSSH ', 'PRIVATE KEY-----'), ['私钥']);
  refused('server.env', made('SMS_ACCESS_KEY_ID=LT', 'AI5tAbCdEfGhIjKlMnOp'), [
    '阿里云 AccessKey',
    '赋值的密钥或密码',
  ]);
  refused('a.ts', made('const key = "sk', '-abcdefghijklmnopqrstuvwxyz123456";'), ['API 令牌']);
  refused('deploy.md', made('postgresql://app:', 'Wrong4Real@127.0.0.1/db'), ['连接串里的密码']);
  refused('server.env', made('JWT_SECRET', '=a1b2c3d4e5f6a7b8'), ['赋值的密钥或密码']);
  // A password of digits only is still a password.
  refused('server.env', made('ROOT_PASSWORD', '=73915286'), ['赋值的密钥或密码']);
  refused('deploy.sh', 'pw = "Hunter2024"', []);
  refused('deploy.sh', made('password', ': "Hunter2024"'), ['写死的密码']);
  refused('README.md', made('服务器密码', '：Hunter2024'), ['密码']);
  refused('README.md', made('负责人手机 139', '12345678'), ['手机号']);
});

test('placeholders, references, test fixtures and marked lines pass', () => {
  for (const [path, line] of [
    ['.env.example', 'DATABASE_URL=postgresql://capsio_app:change-me@127.0.0.1:5432/capsio'],
    ['.env.example', 'JWT_SECRET=replace-with-a-long-random-secret'],
    ['build.mjs', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password(),'],
    ['build.mjs', 'env: { CAPSIO_KEY_PASSWORD_FILE: passwordFile },'],
    ['server/tests/auth.test.mjs', "password: 'first12345',"],
    ['src/a.test.tsx', "phone: '13800138000'"],
    ['src/b.ts', "members: [{ phone: '18200000000' }]"],
    [
      'src/c.ts',
      made('const sample = "sk', '-abcdefghijklmnopqrstuvwxyz123456"; // secret-check: allow'),
    ],
    ['src/browser.rs', '"https://user:pass1234@example.com/",'],
    ['src/writing.rs', 'assert!(has_password("https://git:token@git.overleaf.com/abc"));'],
    ['.env.example', 'REFRESH_TOKEN_TTL_SECONDS=2592000'],
  ]) {
    assert.deepEqual(findings(path, line), [], line);
  }
});

test('the hosts of an SSH config are refused, public addresses aside', () => {
  const config = [
    'Host *',
    '  ServerAliveInterval 30',
    'Host prod-box gpu',
    '  HostName 203.0.113.7',
    '  User deploy',
    '  IdentityFile ~/.ssh/prod-box.pem',
    'Host legacy_api',
    '  HostName=198.51.100.4',
    '  IdentityFile ~/.ssh/id_ed25519',
  ].join('\n');
  const details = sshDetails(config, ['198.51.100.4']);
  assert.deepEqual(
    details.sort(),
    ['203.0.113.7', 'legacy_api', 'prod-box', 'prod-box.pem'].sort(),
  );
  assert.deepEqual(findings('deploy.sh', 'host=${1:-prod-box}', details), [
    'SSH 配置里的 主机别名',
  ]);
  assert.deepEqual(findings('docs.md', 'ssh deploy@203.0.113.7', details), [
    'SSH 配置里的 地址或密钥文件',
  ]);
  assert.deepEqual(findings('app.rs', 'const OLD: &str = "https://198.51.100.4";', details), []);
});

test('a pre-push hook checks what each pushed branch adds', () => {
  const zero = '0'.repeat(40);
  const input = [
    `refs/heads/main aaa111 refs/heads/main bbb222`,
    `refs/heads/new ccc333 refs/heads/new ${zero}`,
    `(delete) ${zero} refs/heads/old ddd444`,
  ].join('\n');
  assert.deepEqual(pushRanges(input), [['bbb222..aaa111'], ['ccc333', '--not', '--remotes']]);
});
