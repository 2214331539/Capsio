#!/usr/bin/env node
// Refuses credentials and server login details in what goes to the public repository: private
// keys, provider tokens, passwords in connection strings and assignments, real phone numbers and,
// on a developer's machine, the hosts, addresses and key files of their own ~/.ssh/config.
// GitHub's push protection knows providers' token formats; this covers what it cannot know.
//
//   node scripts/check-secrets.mjs                the commits not yet on origin
//   node scripts/check-secrets.mjs <range>        e.g. origin/main..HEAD
//   node scripts/check-secrets.mjs --all          the whole history (CI)
//   .githooks/pre-push runs it on what is being pushed: git config core.hooksPath .githooks
//
// A line meant to stay (an example in a test, say) can carry the marker `secret-check: allow`.
// Public addresses that may appear are listed in scripts/check-secrets.allow.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOW_MARK = 'secret-check: allow';
/** Values that only stand in for a secret. */
const PLACEHOLDER =
  /change-?me|replace|example|your[-_]|xxx|<[^>]*>|\$\{|^\$|process\.env|\.\.\.|^(?:pass(?:word)?|token|secret|pwd)$/i;
/** Hosts reserved for examples (RFC 2606): credentials there are test data. Not localhost: a
 *  server's own database is reached there, with its real password. */
const EXAMPLE_HOST = /^(?:[\w-]+\.)*example(?:\.(?:com|org|net))?(?:[:/]|$)/i;
/** Settings that count or measure something are numbers, not secrets. */
const MEASURE = /TTL|SECONDS|MINUTES|HOURS|DAYS|LENGTH|SIZE|COUNT|LIMIT/;
const TEST_PATH = /(^|\/)(tests?|fixtures)\/|\.test\.[cm]?[jt]sx?$|_test\.rs$/;
/** Phone numbers in tests and examples: runs of zeros, or the textbook 138 0013 8000. */
const FAKE_PHONE = /0000|13800138000/;
const DEFAULT_KEYS = new Set(['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']);

const RULES = [
  { name: '私钥', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '阿里云 AccessKey', pattern: /\bLTAI[A-Za-z0-9]{12,30}\b/ },
  {
    name: 'API 令牌',
    pattern:
      /\b(?:sk|rk)-[A-Za-z0-9_-]{24,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}/,
  },
  {
    name: '连接串里的密码',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{4,})@(\S*)/i,
    value: (match) => (EXAMPLE_HOST.test(match[2]) ? null : match[1]),
  },
  {
    name: '赋值的密钥或密码',
    pattern:
      /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'#,;)]{6,})/,
    // A reference to a value (a call, a property, a variable) is not the value, and a secret
    // has a digit in it somewhere.
    value: ([, name, value]) =>
      MEASURE.test(name) || /[(.{$]/.test(value) || !/\d/.test(value) ? null : value,
  },
  {
    name: '写死的密码',
    pattern: /\b(?:password|passwd|secret|api_?key|access_?key)\s*[:=]\s*["']([^"'\s]{6,})["']/i,
    value: (match, path) => (TEST_PATH.test(path) ? null : match[1]),
  },
  {
    name: '密码',
    pattern: /(?:密码|口令)\s*[:：]\s*([\x21-\x7e]{4,})/,
    value: (match) => match[1],
  },
  {
    name: '手机号',
    pattern: /(?<!\d)(1[3-9]\d{9})(?!\d)/,
    value: (match) => (FAKE_PHONE.test(match[1]) ? null : match[1]),
  },
];

/** Host aliases, addresses and key files from an OpenSSH config, which never belong here. */
export function sshDetails(config, allowed = []) {
  const details = new Set();
  for (const raw of config.split(/\r?\n/)) {
    const [key, ...rest] = raw.trim().split(/[\s=]+/);
    const value = rest.join(' ');
    if (!key || key.startsWith('#') || !value) continue;
    switch (key.toLowerCase()) {
      case 'host':
        // Distinctive names only: a lone common word would match ordinary text.
        for (const alias of value.split(/\s+/))
          if (!/[*?]/.test(alias) && /[-_]/.test(alias) && alias.length >= 5) details.add(alias);
        break;
      case 'hostname':
        if (!allowed.includes(value)) details.add(value);
        break;
      case 'identityfile': {
        const name = value
          .replace(/^["']|["']$/g, '')
          .split(/[\\/]/)
          .pop();
        if (name && !DEFAULT_KEYS.has(name.replace(/\.pub$/, ''))) details.add(name);
        break;
      }
    }
  }
  return [...details];
}

/** What is wrong with one added line of a file, if anything. */
export function findings(path, line, ssh = []) {
  if (line.includes(ALLOW_MARK)) return [];
  const found = [];
  for (const rule of RULES) {
    const match = line.match(rule.pattern);
    if (!match) continue;
    const value = rule.value ? rule.value(match, path) : match[0];
    if (value && !PLACEHOLDER.test(value)) found.push(rule.name);
  }
  for (const detail of ssh) {
    if (line.includes(detail))
      found.push(`SSH 配置里的 ${detail.includes('.') ? '地址或密钥文件' : '主机别名'}`);
  }
  return found;
}

/** Added lines of the commits in `range`, with their file and commit. */
function addedLines(range) {
  const log = execFileSync(
    'git',
    ['log', '-p', '--no-color', '--no-merges', '--format=@@COMMIT %h', ...range],
    {
      encoding: 'utf8',
      maxBuffer: 1 << 30,
    },
  );
  const lines = [];
  let commit = '';
  let path = '';
  for (const text of log.split('\n')) {
    if (text.startsWith('@@COMMIT ')) commit = text.slice(9);
    else if (text.startsWith('+++ ')) path = text.replace(/^\+\+\+ (b\/)?/, '');
    else if (text.startsWith('+')) lines.push({ commit, path, line: text.slice(1) });
  }
  return lines;
}

/** The ranges a pre-push hook is asked about, from the lines git writes to its input. */
export function pushRanges(input) {
  const zero = /^0+$/;
  return input
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 4 && !zero.test(fields[1]))
    .map(([, local, , remote]) =>
      zero.test(remote) ? [local, '--not', '--remotes'] : [`${remote}..${local}`],
    );
}

function main(args) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const allowFile = join(root, 'scripts', 'check-secrets.allow');
  const allowed = existsSync(allowFile)
    ? readFileSync(allowFile, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean)
    : [];
  const configFile = join(homedir(), '.ssh', 'config');
  const ssh = existsSync(configFile) ? sshDetails(readFileSync(configFile, 'utf8'), allowed) : [];

  let ranges;
  if (args[0] === '--pre-push') ranges = pushRanges(readFileSync(0, 'utf8'));
  else if (args[0] === '--all') ranges = [['--all']];
  else ranges = [args.length ? args : ['@{upstream}..HEAD']];

  const problems = [];
  for (const range of ranges) {
    for (const { commit, path, line } of addedLines(range)) {
      for (const name of findings(path, line, ssh)) problems.push(`${commit} ${path}: ${name}`);
    }
  }
  if (!problems.length) return 0;
  const unique = [...new Set(problems)];
  console.error(`发现 ${unique.length} 处疑似密钥或服务器登录信息，已拒绝：`);
  for (const problem of unique.slice(0, 50)) console.error(`  ${problem}`);
  console.error(`改掉后再提交；确属示例的行可加注释 "${ALLOW_MARK}"。`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
