import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// MacからLightsailへの1コマンドdeploy (npm run deploy:production) の契約。
// 実SSH・AWS API・本番server・実秘密へは接続せず、PATH上のfake git/ssh/curl/sudo/flock/stat/dockerと
// loopback HTTP serverだけで検証する。Red工程のためdeployment/deploy-production.mjsと
// deployment/deploy.shはまだ存在しない。
//
// harnessの前提:
// - Mac scriptはNode 24で起動し、git/sshはPATH経由、公開healthはcurlまたはfetchで確認する。
// - remote scriptはUbuntu向けだが、手元ではbash (4以上があれば優先、無ければmacOS標準のbash) で実行する。
// - remote scriptは/srv/yoriを実際にcdしたり`exec 9>...`のようなshell redirectionでlock fileを
//   開いたりせず、`git -C`と`flock <path> command`のようにPATHのcommand経由で扱う。
//   これにより/srv/yoriを作れないsandboxでもlock下の順序を検証できる。
// - /etc/yori/yori.envの存在・所有・modeは`stat -c`相当のPATH commandで検査する。
// - remote scriptがlock下の本体をflockの引数commandとして実行する場合、fake flockはそのcommandを
//   そのまま実行するため、順序検証は本体まで到達する。

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAC_SCRIPT = path.join(REPO_ROOT, 'deployment', 'deploy-production.mjs');
const REMOTE_SCRIPT = path.join(REPO_ROOT, 'deployment', 'deploy.sh');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

// 合成SHA。実repositoryのcommitとは無関係の40桁hex。
const HEAD_SHA = '1111111111111111111111111111111111111111';
const TARGET_SHA = '2222222222222222222222222222222222222222';
const UNPUSHED_SHA = '3333333333333333333333333333333333333333';
const SECRET_MARKER = 'YORI_TEST_SECRET_MARKER_do_not_print_01';

const FAKE_GIT_SOURCE = `#!/usr/bin/env -S node --
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const stateDir = process.env.YORI_FAKE_STATE_DIR;
if (!stateDir) {
  console.error('fake git: YORI_FAKE_STATE_DIR is required');
  process.exit(70);
}
function log(line) {
  appendFileSync(path.join(stateDir, 'commands.log'), line + String.fromCharCode(10));
}
const argv = process.argv.slice(2);
log(['git'].concat(argv).join(' '));

let index = 0;
while (index < argv.length) {
  const token = argv[index];
  if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree' || token === '--namespace') {
    index = index + 2;
    continue;
  }
  if (token.indexOf('--git-dir=') === 0 || token.indexOf('--work-tree=') === 0 || token.indexOf('-c') === 0) {
    index = index + 1;
    continue;
  }
  break;
}
const command = argv[index] || '';
const args = argv.slice(index + 1);
if (command === 'reset' || command === 'checkout' || command === 'clean') {
  console.error('fake git: forbidden command ' + command);
  process.exit(90);
}
function envList(name) {
  const values = [];
  const parts = (process.env[name] || '').split(',');
  for (const part of parts) {
    const value = part.trim();
    if (value.length > 0) {
      values.push(value);
    }
  }
  return values;
}
function isSha(value) {
  return value.length === 40 && /^[0-9a-f]{40}$/.test(value);
}
function specBase(spec) {
  let value = spec;
  if (value.endsWith('^{commit}')) {
    value = value.slice(0, -9);
  }
  if (value.endsWith('^{}')) {
    value = value.slice(0, -3);
  }
  if (value.endsWith('^0')) {
    value = value.slice(0, -2);
  }
  if (value.endsWith('^')) {
    value = value.slice(0, -1);
  }
  return value;
}
function positional() {
  const out = [];
  for (const token of args) {
    if (token.charAt(0) !== '-') {
      out.push(token);
    }
  }
  return out;
}
const headFile = path.join(stateDir, 'fake-head');
const head = existsSync(headFile) ? readFileSync(headFile, 'utf8').trim() : (process.env.FAKE_GIT_HEAD || '');
const originMain = process.env.FAKE_GIT_ORIGIN_MAIN || head;
const contained = envList('FAKE_GIT_CONTAINED');
const known = envList('FAKE_GIT_KNOWN');
function knownSha(value) {
  return isSha(value) && (known.length === 0 || known.indexOf(value) !== -1 || contained.indexOf(value) !== -1 || value === head);
}

switch (command) {
  case 'status': {
    const dirty = process.env.FAKE_GIT_DIRTY || '';
    if (dirty === 'tracked') {
      process.stdout.write(' M src/api/server.ts' + String.fromCharCode(10));
    } else if (dirty === 'untracked') {
      process.stdout.write('?? src/new-file.ts' + String.fromCharCode(10));
    } else if (dirty.length > 0) {
      process.stdout.write(dirty + String.fromCharCode(10));
    }
    process.exit(0);
  }
  case 'diff-index':
  case 'diff': {
    process.exit(process.env.FAKE_GIT_DIRTY ? 1 : 0);
  }
  case 'rev-parse': {
    if (args.indexOf('--show-toplevel') !== -1) {
      process.stdout.write((process.env.YORI_FAKE_REPO_ROOT || process.cwd()) + String.fromCharCode(10));
      process.exit(0);
    }
    if (args.indexOf('--is-inside-work-tree') !== -1) {
      process.stdout.write('true' + String.fromCharCode(10));
      process.exit(0);
    }
    if (args.indexOf('--abbrev-ref') !== -1) {
      process.stdout.write('main' + String.fromCharCode(10));
      process.exit(0);
    }
    if (args.indexOf('--short') !== -1) {
      process.stdout.write(head.slice(0, 12) + String.fromCharCode(10));
      process.exit(0);
    }
    const values = positional();
    const spec = values[values.length - 1] || 'HEAD';
    const base = specBase(spec);
    if (spec === 'HEAD' || base === 'HEAD') {
      process.stdout.write(head + String.fromCharCode(10));
      process.exit(0);
    }
    if (spec === 'origin/main' || base === 'origin/main') {
      process.stdout.write(originMain + String.fromCharCode(10));
      process.exit(0);
    }
    if (knownSha(base)) {
      process.stdout.write(base + String.fromCharCode(10));
      process.exit(0);
    }
    console.error('fake git: unknown revision ' + spec);
    process.exit(128);
  }
  case 'merge-base': {
    const values = positional();
    if (args.indexOf('--is-ancestor') !== -1) {
      const ancestor = values[0] || '';
      const descendant = values[1] || '';
      if (descendant === 'origin/main') {
        process.exit(contained.indexOf(ancestor) !== -1 ? 0 : 1);
      }
      if (ancestor === head && descendant === process.env.FAKE_GIT_TARGET) {
        process.exit(process.env.FAKE_GIT_FF_OK === '0' ? 1 : 0);
      }
      process.exit(process.env.FAKE_GIT_FF_OK === '0' ? 1 : 0);
    }
    process.stdout.write((values[0] || head) + String.fromCharCode(10));
    process.exit(0);
  }
  case 'rev-list': {
    const range = args[args.length - 1] || '';
    if (range.indexOf('..HEAD') !== -1) {
      process.stdout.write((process.env.FAKE_GIT_DIVERGED === '1' ? '1' : '0') + String.fromCharCode(10));
      process.exit(0);
    }
    process.stdout.write('1' + String.fromCharCode(10));
    process.exit(0);
  }
  case 'cat-file': {
    const spec = specBase(args[args.length - 1] || '');
    process.exit(knownSha(spec) ? 0 : 128);
  }
  case 'merge': {
    if (args.indexOf('--ff-only') === -1) {
      console.error('fake git: merge without --ff-only');
      process.exit(91);
    }
    let target = '';
    for (let i = args.length - 1; i >= 0; i = i - 1) {
      if (args[i].charAt(0) !== '-') {
        target = args[i];
        break;
      }
    }
    if (!isSha(target)) {
      console.error('fake git: invalid merge target');
      process.exit(92);
    }
    writeFileSync(headFile, target + String.fromCharCode(10));
    process.exit(0);
  }
  case 'fetch':
    process.exit(Number(process.env.FAKE_GIT_FETCH_STATUS || '0'));
  case 'branch': {
    if (args.indexOf('--contains') !== -1) {
      for (const value of positional()) {
        if (contained.indexOf(value) !== -1) {
          process.stdout.write('  origin/main' + String.fromCharCode(10));
          break;
        }
      }
    }
    process.exit(0);
  }
  case 'log': {
    if (args.join(' ').indexOf('..HEAD') !== -1 && process.env.FAKE_GIT_DIVERGED === '1') {
      process.stdout.write('deadbeef fake' + String.fromCharCode(10));
    }
    process.exit(0);
  }
  default:
    process.exit(0);
}
`;

const FAKE_SSH_SOURCE = `#!/usr/bin/env -S node --
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const stateDir = process.env.YORI_FAKE_STATE_DIR;
if (!stateDir) {
  console.error('fake ssh: YORI_FAKE_STATE_DIR is required');
  process.exit(70);
}
const argv = process.argv.slice(2);
appendFileSync(path.join(stateDir, 'commands.log'), ['ssh'].concat(argv).join(' ') + String.fromCharCode(10));
appendFileSync(path.join(stateDir, 'ssh.log'), JSON.stringify(argv) + String.fromCharCode(10));
let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch (error) {
  stdin = '';
}
appendFileSync(path.join(stateDir, 'ssh-stdin.txt'), stdin);
process.stdout.write('fake ssh: remote deploy ok' + String.fromCharCode(10));
process.exit(Number(process.env.FAKE_SSH_STATUS || '0'));
`;

const FAKE_CURL_SOURCE = `#!/usr/bin/env -S node --
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const stateDir = process.env.YORI_FAKE_STATE_DIR;
if (!stateDir) {
  console.error('fake curl: YORI_FAKE_STATE_DIR is required');
  process.exit(70);
}
const argv = process.argv.slice(2);
appendFileSync(path.join(stateDir, 'commands.log'), ['curl'].concat(argv).join(' ') + String.fromCharCode(10));
let url = '';
for (let i = 0; i < argv.length; i = i + 1) {
  if (argv[i].indexOf('http://') === 0 || argv[i].indexOf('https://') === 0) {
    url = argv[i];
  }
}
appendFileSync(path.join(stateDir, 'curl.log'), url + String.fromCharCode(10));
const writeOut = argv.indexOf('-w') !== -1 || argv.indexOf('--write-out') !== -1 || argv.some((arg) => arg.indexOf('--write-out=') === 0);
const isSetup = url.endsWith('/v1/collector/setup');
const status = isSetup ? (process.env.FAKE_SETUP_HTTP_CODE || '401') : (process.env.FAKE_CURL_HTTP_CODE || '200');
const body = isSetup
  ? (process.env.FAKE_SETUP_BODY || '{"error":{"code":"unauthorized"}}')
  : (process.env.FAKE_HEALTH_BODY || JSON.stringify({ status: status === '200' ? 'ready' : 'unavailable', release_sha: process.env.FAKE_HEALTH_SHA || process.env.FAKE_GIT_HEAD, api_contract_version: 1 }));
let outputPath = null;
for (let i = 0; i < argv.length; i = i + 1) {
  if ((argv[i] === '-o' || argv[i] === '--output') && argv[i + 1]) {
    outputPath = argv[i + 1];
  }
}
if (outputPath !== null) {
  writeFileSync(outputPath, body);
} else {
  process.stdout.write(body);
}
if (writeOut) {
  process.stdout.write((outputPath === null ? String.fromCharCode(10) : '') + status + String.fromCharCode(10));
}
process.exit(Number(process.env.FAKE_CURL_STATUS || '0'));
`;

const FAKE_SUDO_SOURCE = `#!/usr/bin/env -S node --
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const stateDir = process.env.YORI_FAKE_STATE_DIR;
if (!stateDir) {
  console.error('fake sudo: YORI_FAKE_STATE_DIR is required');
  process.exit(70);
}
const argv = process.argv.slice(2);
appendFileSync(path.join(stateDir, 'commands.log'), ['sudo'].concat(argv).join(' ') + String.fromCharCode(10));
let index = 0;
while (index < argv.length) {
  const token = argv[index];
  if (token === '-n' || token === '--non-interactive' || token === '-v' || token === '--validate' || token === '-k' || token === '-K' || token === '-E' || token === '--preserve-env' || token === '-H' || token === '-S' || token === '-A' || token === '-b' || token === '-e' || token === '-i') {
    index = index + 1;
    continue;
  }
  if (token === '-u' || token === '--user' || token === '-g' || token === '--group' || token === '-h' || token === '--host' || token === '-p' || token === '--prompt' || token === '-C' || token === '--close-from' || token === '-T' || token === '--command-timeout' || token === '-r' || token === '--role' || token === '-t' || token === '--type' || token === '-D' || token === '--chdir') {
    index = index + 2;
    continue;
  }
  if (token.indexOf('--preserve-env=') === 0 || token.indexOf('--user=') === 0 || token.indexOf('--group=') === 0 || token.indexOf('--host=') === 0 || token.indexOf('--prompt=') === 0 || token.indexOf('--command-timeout=') === 0 || token.indexOf('--role=') === 0 || token.indexOf('--type=') === 0 || token.indexOf('--chdir=') === 0 || token.indexOf('--close-from=') === 0) {
    index = index + 1;
    continue;
  }
  break;
}
const rest = argv.slice(index);
if (rest.length === 0) {
  process.exit(0);
}
const childEnv = Object.assign({}, process.env, { YORI_FAKE_VIA_SUDO: '1' });
delete childEnv.YORI_RELEASE_SHA;
const child = spawnSync(rest[0], rest.slice(1), { stdio: 'inherit', env: childEnv });
process.exit(child.status === null ? 1 : child.status);
`;

const FAKE_FLOCK_SOURCE = `#!/usr/bin/env -S node --
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const stateDir = process.env.YORI_FAKE_STATE_DIR;
if (!stateDir) {
  console.error('fake flock: YORI_FAKE_STATE_DIR is required');
  process.exit(70);
}
const argv = process.argv.slice(2);
let lock = '';
let commandValue = null;
let commandArgs = [];
let index = 0;
while (index < argv.length) {
  const token = argv[index];
  if (token === '-c' || token === '--command') {
    commandValue = argv[index + 1] || '';
    index = index + 2;
    continue;
  }
  if (token.indexOf('--command=') === 0) {
    commandValue = token.slice('--command='.length);
    index = index + 1;
    continue;
  }
  if (token === '-w' || token === '--wait' || token === '--timeout' || token === '-E' || token === '--conflict-exit-code' || token === '-F') {
    index = index + 2;
    continue;
  }
  if (token.indexOf('--timeout=') === 0 || token.indexOf('--conflict-exit-code=') === 0 || token.indexOf('-w') === 0) {
    index = index + 1;
    continue;
  }
  if (token === '-n' || token === '--nonblock' || token === '--nb' || token === '--no-fork' || token === '-o' || token === '--close' || token === '--fcntl' || token === '--no-clobber') {
    index = index + 1;
    continue;
  }
  if (token.charAt(0) === '-') {
    index = index + 1;
    continue;
  }
  lock = token;
  commandArgs = argv.slice(index + 1);
  break;
}
if (commandArgs.length > 0 && (commandArgs[0] === '-c' || commandArgs[0] === '--command')) {
  commandValue = commandArgs[1] || '';
  commandArgs = [];
}
appendFileSync(path.join(stateDir, 'commands.log'), ['flock', lock].join(' ') + (commandValue !== null || commandArgs.length > 0 ? ' +command' : '') + String.fromCharCode(10));
const status = Number(process.env.FAKE_FLOCK_STATUS || '0');
if (status !== 0) {
  process.exit(status);
}
if (commandValue !== null) {
  const child = spawnSync('bash', ['-c', commandValue], { stdio: 'inherit', env: process.env });
  process.exit(child.status === null ? 1 : child.status);
}
if (commandArgs.length > 0) {
  const child = spawnSync(commandArgs[0], commandArgs.slice(1), { stdio: 'inherit', env: process.env });
  process.exit(child.status === null ? 1 : child.status);
}
process.exit(0);
`;

const FAKE_STAT_SOURCE = `#!/usr/bin/env -S node --
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const stateDir = process.env.YORI_FAKE_STATE_DIR;
if (!stateDir) {
  console.error('fake stat: YORI_FAKE_STATE_DIR is required');
  process.exit(70);
}
const argv = process.argv.slice(2);
appendFileSync(path.join(stateDir, 'commands.log'), ['stat'].concat(argv).join(' ') + String.fromCharCode(10));
if (process.env.FAKE_ENV_PARENT_MODE === '700' && process.env.YORI_FAKE_VIA_SUDO !== '1') {
  console.error('stat: cannot statx /etc/yori/yori.env: Permission denied');
  process.exit(1);
}
const owner = process.env.FAKE_ENVFILE_OWNER || 'root';
const group = process.env.FAKE_ENVFILE_GROUP || 'root';
const mode = process.env.FAKE_ENVFILE_MODE || '600';
let format = null;
for (let i = 0; i < argv.length; i = i + 1) {
  if ((argv[i] === '-c' || argv[i] === '--format') && argv[i + 1] !== undefined) {
    format = argv[i + 1];
  }
  if (argv[i].indexOf('--format=') === 0) {
    format = argv[i].slice('--format='.length);
  }
  if (argv[i].indexOf('--printf=') === 0) {
    format = argv[i].slice('--printf='.length);
  }
}
if (format !== null) {
  let out = format;
  while (out.indexOf('%U') !== -1) {
    out = out.replace('%U', owner);
  }
  while (out.indexOf('%G') !== -1) {
    out = out.replace('%G', group);
  }
  while (out.indexOf('%a') !== -1) {
    out = out.replace('%a', mode);
  }
  while (out.indexOf('%n') !== -1) {
    out = out.replace('%n', argv[argv.length - 1] || '');
  }
  while (out.indexOf('%u') !== -1) {
    out = out.replace('%u', '0');
  }
  while (out.indexOf('%g') !== -1) {
    out = out.replace('%g', '0');
  }
  while (out.indexOf('%A') !== -1) {
    out = out.replace('%A', mode === '600' ? '-rw-------' : '-rw-r--r--');
  }
  process.stdout.write(out + String.fromCharCode(10));
} else {
  process.stdout.write(owner + ' ' + group + ' ' + mode + ' ' + (argv[argv.length - 1] || '') + String.fromCharCode(10));
}
process.exit(0);
`;

const FAKE_DOCKER_SOURCE = `#!/usr/bin/env -S node --
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const stateDir = process.env.YORI_FAKE_STATE_DIR;
if (!stateDir) {
  console.error('fake docker: YORI_FAKE_STATE_DIR is required');
  process.exit(70);
}
const argv = process.argv.slice(2);
const prefix = process.env.YORI_FAKE_VIA_SUDO === '1' ? 'docker via-sudo' : 'docker';
appendFileSync(path.join(stateDir, 'commands.log'), prefix + ' ' + argv.join(' ') + String.fromCharCode(10));
function has(value) {
  return argv.indexOf(value) !== -1;
}
let sub = '';
for (const candidate of ['config', 'pull', 'up', 'run', 'rm', 'port', 'ps', 'down', 'logs', 'exec']) {
  if (has(candidate)) {
    sub = candidate;
    break;
  }
}
let status = 0;
if (sub === 'config') {
  status = process.env.YORI_RELEASE_SHA ? Number(process.env.FAKE_DOCKER_CONFIG_STATUS || '0') : 64;
} else if (sub === 'pull') {
  status = Number(process.env.FAKE_DOCKER_PULL_STATUS || '0');
} else if (sub === 'up') {
  status = has('db') ? Number(process.env.FAKE_DOCKER_DB_STATUS || '0') : Number(process.env.FAKE_DOCKER_RECREATE_STATUS || '0');
} else if (sub === 'run') {
  status = Number(process.env.FAKE_DOCKER_MIGRATE_STATUS || '0');
} else if (sub === 'exec') {
  status = Number(has('worker') ? process.env.FAKE_DOCKER_WORKER_RELEASE_STATUS || '0' : process.env.FAKE_DOCKER_API_RELEASE_STATUS || '0');
} else if (sub === 'rm') {
  for (const service of ['api', 'worker']) {
    if (has(service)) {
      rmSync(path.join(stateDir, service + '-id'), { force: true });
      writeFileSync(path.join(stateDir, service + '-removed'), '1');
    }
  }
} else if (sub === 'port') {
  process.stdout.write((process.env.FAKE_DOCKER_PORT || '127.0.0.1:39119') + String.fromCharCode(10));
  process.exit(0);
} else if (sub === 'ps') {
  if (has('-q')) {
    const service = has('worker') ? 'worker' : 'api';
    const idPath = path.join(stateDir, service + '-id');
    const removedPath = path.join(stateDir, service + '-removed');
    if (!existsSync(idPath) && !existsSync(removedPath) && process.env.FAKE_DOCKER_NO_OLD !== '1') {
      writeFileSync(idPath, process.env['FAKE_DOCKER_' + service.toUpperCase() + '_OLD_ID'] || 'old-' + service + '-id');
    }
    if (existsSync(idPath)) {
      process.stdout.write(readFileSync(idPath, 'utf8') + String.fromCharCode(10));
    }
    process.exit(0);
  }
  process.stdout.write('NAME IMAGE STATUS' + String.fromCharCode(10) + 'fake-ps api running' + String.fromCharCode(10));
  process.exit(0);
}
if (sub === 'up' && status === 0 && !has('db')) {
  for (const service of ['api', 'worker']) {
    if (has(service)) {
      writeFileSync(path.join(stateDir, service + '-id'), process.env['FAKE_DOCKER_' + service.toUpperCase() + '_NEW_ID'] || 'new-' + service + '-id');
    }
  }
}
if (status !== 0) {
  console.error('fake docker: ' + sub + ' failed');
}
process.exit(status);
`;

let fakeRoot = '';
let fakeBin = '';
let bashEnvFile = '';
let bashPath = '';

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

function resultOf(result: ReturnType<typeof spawnSync>): RunResult {
  return {
    status: typeof result.status === 'number' ? result.status : -1,
    stdout: result.stdout == null ? '' : String(result.stdout),
    stderr: result.stderr == null ? '' : String(result.stderr),
    error: result.error ?? undefined,
  };
}

function describeResult(result: RunResult): string {
  return `exit ${result.status}${result.error ? ` error=${result.error.message}` : ''}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function writeFakeBins(dir: string): void {
  const files: Array<[string, string]> = [
    ['git', FAKE_GIT_SOURCE],
    ['ssh', FAKE_SSH_SOURCE],
    ['curl', FAKE_CURL_SOURCE],
    ['sudo', FAKE_SUDO_SOURCE],
    ['flock', FAKE_FLOCK_SOURCE],
    ['stat', FAKE_STAT_SOURCE],
    ['docker', FAKE_DOCKER_SOURCE],
  ];
  for (const [name, source] of files) {
    const file = path.join(dir, name);
    writeFileSync(file, source, { mode: 0o755 });
    chmodSync(file, 0o755);
  }
}

function findBash(): string {
  const candidates = [process.env.YORI_TEST_BASH, '/opt/homebrew/bin/bash', '/usr/local/bin/bash'].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return 'bash';
}

function makeStateDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'yori-deploy-state-'));
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function commandLines(stateDir: string): string[] {
  return readText(path.join(stateDir, 'commands.log')).split('\n').filter((line) => line.length > 0);
}

function curlCalls(stateDir: string): string[] {
  return readText(path.join(stateDir, 'curl.log')).split('\n').filter((line) => line.length > 0);
}

function sshCalls(stateDir: string): string[][] {
  return readText(path.join(stateDir, 'ssh.log'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function healthCallCount(stateDir: string, serverCalls: string[]): number {
  return curlCalls(stateDir).length + serverCalls.length;
}

function pathEnv(): string {
  return [fakeBin, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
}

function macEnv(stateDir: string, healthUrl: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: pathEnv(),
    HOME: stateDir,
    YORI_FAKE_STATE_DIR: stateDir,
    YORI_FAKE_REPO_ROOT: REPO_ROOT,
    FAKE_GIT_HEAD: HEAD_SHA,
    FAKE_GIT_ORIGIN_MAIN: HEAD_SHA,
    FAKE_GIT_CONTAINED: HEAD_SHA,
    FAKE_CURL_STATUS: '0',
    FAKE_CURL_HTTP_CODE: '200',
    FAKE_HEALTH_SHA: HEAD_SHA,
    YORI_DEPLOY_HEALTH_URL: healthUrl,
    ...overrides,
  };
}

function remoteEnv(stateDir: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: pathEnv(),
    HOME: stateDir,
    BASH_ENV: bashEnvFile,
    YORI_DEPLOY_TEST_REPO_ROOT: REPO_ROOT,
    YORI_FAKE_STATE_DIR: stateDir,
    YORI_FAKE_REPO_ROOT: REPO_ROOT,
    FAKE_GIT_HEAD: HEAD_SHA,
    FAKE_GIT_ORIGIN_MAIN: HEAD_SHA,
    FAKE_GIT_CONTAINED: HEAD_SHA,
    FAKE_CURL_STATUS: '0',
    FAKE_DOCKER_PORT: '127.0.0.1:39119',
    FAKE_ENVFILE_OWNER: 'root',
    FAKE_ENVFILE_GROUP: 'root',
    FAKE_ENVFILE_MODE: '600',
    ...overrides,
  };
}

function runMac(args: string[], stateDir: string, healthUrl: string, overrides: Record<string, string> = {}, cwd = REPO_ROOT): RunResult {
  return resultOf(
    spawnSync(process.execPath, [MAC_SCRIPT, ...args], {
      cwd,
      env: macEnv(stateDir, healthUrl, overrides),
      encoding: 'utf8',
      timeout: 60_000,
    }),
  );
}

function runNpmMac(stateDir: string, healthUrl: string, overrides: Record<string, string> = {}): RunResult {
  return resultOf(
    spawnSync('npm', ['run', '--silent', 'deploy:production'], {
      cwd: REPO_ROOT,
      env: macEnv(stateDir, healthUrl, overrides),
      encoding: 'utf8',
      timeout: 120_000,
    }),
  );
}

function runRemote(stateDir: string, target: string, overrides: Record<string, string> = {}): RunResult {
  return resultOf(
    spawnSync(bashPath, [REMOTE_SCRIPT, target], {
      cwd: REPO_ROOT,
      env: remoteEnv(stateDir, overrides),
      encoding: 'utf8',
      timeout: 60_000,
    }),
  );
}

interface HealthServer {
  url: string;
  calls: string[];
  close: () => Promise<void>;
}

function startHealthServer(status: number, releaseSha = HEAD_SHA): Promise<HealthServer> {
  return new Promise((resolve, reject) => {
    const calls: string[] = [];
    const server: Server = createServer((_request, response) => {
      calls.push(_request.url ?? '');
      response.setHeader('connection', 'close');
      response.statusCode = status;
      if ((_request.url ?? '').endsWith('/v1/collector/setup')) {
        response.statusCode = 401;
        response.setHeader('content-type', 'application/json');
        response.end('{"error":{"code":"unauthorized"}}');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: status === 200 ? 'ready' : 'unavailable', release_sha: releaseSha, api_contract_version: 1 }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        reject(new Error('health serverのaddressを取得できない'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/health/ready`,
        calls,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function requireMacScript(): void {
  assert.ok(existsSync(MAC_SCRIPT), '未実装: deployment/deploy-production.mjs がない');
}

function requireRemoteScript(): void {
  assert.ok(existsSync(REMOTE_SCRIPT), '未実装: deployment/deploy.sh がない');
}

function requireScripts(): void {
  requireMacScript();
  requireRemoteScript();
}

function assertSshInvocation(args: string[], host: string, sha: string): void {
  const hostIndex = args.indexOf(host);
  assert.ok(hostIndex !== -1, `ssh引数にhost ${host}がない: ${args.join(' ')}`);
  const commandIndex = args.findIndex((arg, index) => index > hostIndex && (arg === 'bash' || arg.startsWith('bash ')));
  assert.ok(commandIndex !== -1, `ssh引数にbash -sがない: ${args.join(' ')}`);
  if (args.includes('-s')) {
    assert.equal(args[args.length - 1], sha, `ssh引数のSHAが違う: ${args.join(' ')}`);
    assert.ok(args.indexOf('--') !== -1 && args.indexOf('--') < args.length - 1, `ssh引数に-- SHAがない: ${args.join(' ')}`);
  } else {
    assert.match(args[commandIndex] ?? '', new RegExp(`bash -s -- ${sha}$`), `ssh commandがbash -s -- SHAでない: ${args.join(' ')}`);
  }
}

function remoteHappyEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    FAKE_GIT_HEAD: HEAD_SHA,
    FAKE_GIT_ORIGIN_MAIN: TARGET_SHA,
    FAKE_GIT_CONTAINED: `${HEAD_SHA},${TARGET_SHA}`,
    FAKE_GIT_KNOWN: TARGET_SHA,
    FAKE_HEALTH_SHA: TARGET_SHA,
    ...overrides,
  };
}

before(() => {
  fakeRoot = mkdtempSync(path.join(tmpdir(), 'yori-deploy-fakes-'));
  fakeBin = path.join(fakeRoot, 'bin');
  mkdirSync(fakeBin);
  writeFakeBins(fakeBin);
  bashEnvFile = path.join(fakeRoot, 'bash-env.sh');
  writeFileSync(
    bashEnvFile,
    'cd() { builtin cd "${YORI_DEPLOY_TEST_REPO_ROOT:-$PWD}" 2>/dev/null || builtin cd "$@"; }\nexport -f cd 2>/dev/null || true\n',
  );
  bashPath = findBash();
});

after(() => {
  if (fakeRoot.length > 0) {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

describe('deploy:production 契約 (Red)', () => {
  it('A: package.jsonのdeploy:productionと2つのscript pathが契約どおり存在する', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { scripts?: Record<string, string> };
    assert.equal(
      pkg.scripts?.['deploy:production'],
      'node deployment/deploy-production.mjs',
      'npm run deploy:productionのpackage scriptが契約と違う',
    );
    assert.ok(existsSync(MAC_SCRIPT), '未実装: deployment/deploy-production.mjs がない');
    assert.ok(existsSync(REMOTE_SCRIPT), '未実装: deployment/deploy.sh がない');
  });

  it('A3: remote scriptはset -euo pipefailで失敗を伝播する', () => {
    requireRemoteScript();
    const source = readFileSync(REMOTE_SCRIPT, 'utf8');
    assert.match(source, /set -euo pipefail/, 'deployment/deploy.shにset -euo pipefailがない');
  });

  it('A2: Mac scriptは既定host・health URLとoverride env名を持つ', () => {
    requireMacScript();
    const source = readFileSync(MAC_SCRIPT, 'utf8');
    assert.ok(source.includes('yori-production'), '既定SSH host yori-productionがない');
    assert.ok(source.includes('https://yori-pilot.online/health/ready'), '既定公開health URLがない');
    assert.ok(source.includes('YORI_DEPLOY_HOST'), 'YORI_DEPLOY_HOST overrideがない');
    assert.ok(source.includes('YORI_DEPLOY_HEALTH_URL'), 'YORI_DEPLOY_HEALTH_URL overrideがない');
  });
});

describe('Mac側 deploy-production.mjs (Red)', () => {
  it('B1: cleanかつpush済みHEADでnpm run deploy:productionがscript stdinとHEAD SHAをsshへ渡し、公開healthを1回確認して0', async () => {
    requireScripts();
    const stateDir = makeStateDir();
    const health = await startHealthServer(200);
    try {
      const result = runNpmMac(stateDir, health.url);
      assert.equal(result.status, 0, `npm run deploy:productionが0でない:\n${describeResult(result)}`);
      const calls = sshCalls(stateDir);
      assert.equal(calls.length, 1, `ssh呼び出しが1回でない: ${calls.length}`);
      assertSshInvocation(calls[0] ?? [], 'yori-production', HEAD_SHA);
      assert.equal(
        readText(path.join(stateDir, 'ssh-stdin.txt')),
        readFileSync(REMOTE_SCRIPT, 'utf8'),
        'ssh stdinがdeployment/deploy.sh本文と一致しない',
      );
      assert.equal(healthCallCount(stateDir, health.calls), 2, '公開healthとsetup smokeの確認が各1回でない');
    } finally {
      await health.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('B2: 40桁hexのtarget引数をsshへ渡し、そのSHAだけを配布する', async () => {
    requireScripts();
    const stateDir = makeStateDir();
    const health = await startHealthServer(200, TARGET_SHA);
    try {
      const result = runMac([TARGET_SHA], stateDir, health.url, {
        FAKE_GIT_ORIGIN_MAIN: TARGET_SHA,
        FAKE_GIT_CONTAINED: `${HEAD_SHA},${TARGET_SHA}`,
        FAKE_HEALTH_SHA: TARGET_SHA,
        FAKE_GIT_KNOWN: TARGET_SHA,
      });
      assert.equal(result.status, 0, `target指定deployが0でない:\n${describeResult(result)}`);
      assertSshInvocation(sshCalls(stateDir)[0] ?? [], 'yori-production', TARGET_SHA);
      assert.equal(healthCallCount(stateDir, health.calls), 2, '公開healthとsetup smokeの確認が各1回でない');
    } finally {
      await health.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('B3: YORI_DEPLOY_HOSTでSSH hostをoverrideする', async () => {
    requireScripts();
    const stateDir = makeStateDir();
    const health = await startHealthServer(200);
    try {
      const result = runMac([], stateDir, health.url, { YORI_DEPLOY_HOST: 'yori-staging' });
      assert.equal(result.status, 0, `host overrideで0でない:\n${describeResult(result)}`);
      assertSshInvocation(sshCalls(stateDir)[0] ?? [], 'yori-staging', HEAD_SHA);
    } finally {
      await health.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('B4: repository内の別cwdからでもrepository rootを決定してdeploy.shを送る', async () => {
    requireScripts();
    const stateDir = makeStateDir();
    const health = await startHealthServer(200);
    try {
      const result = runMac([], stateDir, health.url, {}, path.join(REPO_ROOT, 'deployment'));
      assert.equal(result.status, 0, `別cwdで0でない:\n${describeResult(result)}`);
      assertSshInvocation(sshCalls(stateDir)[0] ?? [], 'yori-production', HEAD_SHA);
      assert.equal(
        readText(path.join(stateDir, 'ssh-stdin.txt')),
        readFileSync(REMOTE_SCRIPT, 'utf8'),
        '別cwdでssh stdinがdeployment/deploy.sh本文と一致しない',
      );
    } finally {
      await health.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('C1: tracked/untrackedのdirtyではSSH前に失敗し、healthも呼ばない', async () => {
    requireScripts();
    const health = await startHealthServer(200);
    try {
      for (const dirty of ['tracked', 'untracked']) {
        const stateDir = makeStateDir();
        try {
          const result = runMac([], stateDir, health.url, { FAKE_GIT_DIRTY: dirty });
          assert.notEqual(result.status, 0, `${dirty}: dirtyなのに0で終了した:\n${describeResult(result)}`);
          assert.equal(sshCalls(stateDir).length, 0, `${dirty}: dirtyなのにSSHした`);
          assert.equal(healthCallCount(stateDir, health.calls), 0, `${dirty}: dirtyなのにhealthを呼んだ`);
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      }
    } finally {
      await health.close();
    }
  });

  it('C2: 40桁hexでないtargetはSSH 0回で失敗する', async () => {
    requireScripts();
    const health = await startHealthServer(200);
    try {
      const invalidTargets = ['abc', 'HEAD', 'main', '1'.repeat(39), '1'.repeat(41), 'g'.repeat(40), '$(touch marker)', '-x'];
      for (const invalidTarget of invalidTargets) {
        const stateDir = makeStateDir();
        try {
          const marker = path.join(stateDir, 'injected-marker');
          const target = invalidTarget.split('marker').join(marker);
          const result = runMac([target], stateDir, health.url);
          assert.notEqual(result.status, 0, `invalid target ${invalidTarget}が0で終了した:\n${describeResult(result)}`);
          assert.equal(sshCalls(stateDir).length, 0, `invalid target ${invalidTarget}でSSHした`);
          assert.equal(healthCallCount(stateDir, health.calls), 0, `invalid target ${invalidTarget}でhealthを呼んだ`);
          assert.ok(!existsSync(marker), `invalid target ${invalidTarget}で注入markerが作られた`);
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      }
    } finally {
      await health.close();
    }
  });

  it('C3: origin/mainに含まれないtarget（未push commit）はSSH 0回で失敗する', async () => {
    requireScripts();
    const health = await startHealthServer(200);
    try {
      const explicitState = makeStateDir();
      try {
        const result = runMac([UNPUSHED_SHA], explicitState, health.url, {
          FAKE_GIT_ORIGIN_MAIN: HEAD_SHA,
          FAKE_GIT_CONTAINED: HEAD_SHA,
          FAKE_GIT_KNOWN: UNPUSHED_SHA,
        });
        assert.notEqual(result.status, 0, `未pushのtarget指定が0で終了した:\n${describeResult(result)}`);
        assert.equal(sshCalls(explicitState).length, 0, '未pushのtarget指定でSSHした');
        assert.equal(healthCallCount(explicitState, health.calls), 0, '未pushのtarget指定でhealthを呼んだ');
      } finally {
        rmSync(explicitState, { recursive: true, force: true });
      }

      const defaultState = makeStateDir();
      try {
        const result = runMac([], defaultState, health.url, { FAKE_GIT_CONTAINED: '' });
        assert.notEqual(result.status, 0, `未pushのlocal HEADが0で終了した:\n${describeResult(result)}`);
        assert.equal(sshCalls(defaultState).length, 0, '未pushのlocal HEADでSSHした');
        assert.equal(healthCallCount(defaultState, health.calls), 0, '未pushのlocal HEADでhealthを呼んだ');
      } finally {
        rmSync(defaultState, { recursive: true, force: true });
      }
    } finally {
      await health.close();
    }
  });

  it('D1: SSH失敗時は公開healthを呼ばず非0で終わる', async () => {
    requireScripts();
    const stateDir = makeStateDir();
    const health = await startHealthServer(200);
    try {
      const result = runMac([], stateDir, health.url, { FAKE_SSH_STATUS: '1' });
      assert.notEqual(result.status, 0, `SSH失敗なのに0で終了した:\n${describeResult(result)}`);
      assert.equal(sshCalls(stateDir).length, 1, 'SSHが1回でない');
      assert.equal(healthCallCount(stateDir, health.calls), 0, 'SSH失敗後に公開healthを呼んだ');
    } finally {
      await health.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('D2: 公開healthが200でなければ非0で終わる', async () => {
    requireScripts();
    const stateDir = makeStateDir();
    const health = await startHealthServer(503);
    try {
      const result = runMac([], stateDir, health.url, { FAKE_CURL_STATUS: '22', FAKE_CURL_HTTP_CODE: '503' });
      assert.notEqual(result.status, 0, `health失敗なのに0で終了した:\n${describeResult(result)}`);
      assert.equal(sshCalls(stateDir).length, 1, 'SSHが成功していない');
      assert.equal(healthCallCount(stateDir, health.calls), 1, 'health確認が1回でない');
    } finally {
      await health.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('D3: 公開healthのrelease SHAまたはAPI契約versionが一致しなければ非0で終わる', async () => {
    requireScripts();
    for (const [label, overrides] of [
      ['release SHA不一致', { FAKE_HEALTH_SHA: TARGET_SHA }],
      ['契約version不一致', { FAKE_HEALTH_BODY: JSON.stringify({ status: 'ready', release_sha: HEAD_SHA, api_contract_version: 0 }) }],
    ] as Array<[string, Record<string, string>]>) {
      const stateDir = makeStateDir();
      const health = await startHealthServer(200);
      try {
        const result = runMac([], stateDir, health.url, overrides);
        assert.notEqual(result.status, 0, `${label}なのに0で終了した:\n${describeResult(result)}`);
        assert.equal(sshCalls(stateDir).length, 1, `${label}でSSHが成功していない`);
        assert.equal(healthCallCount(stateDir, health.calls), 1, `${label}でsetup smokeまで進んだ`);
      } finally {
        await health.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  });

  it('D4: 公開setup smokeが正規401でなければ非0で終わる', async () => {
    requireScripts();
    const stateDir = makeStateDir();
    const health = await startHealthServer(200);
    try {
      const result = runMac([], stateDir, health.url, {
        FAKE_SETUP_HTTP_CODE: '404',
        FAKE_SETUP_BODY: '{"message":"Route POST:/v1/collector/setup not found","error":"Not Found","statusCode":404}',
      });
      assert.notEqual(result.status, 0, `setup 404なのに0で終了した:\n${describeResult(result)}`);
      assert.equal(healthCallCount(stateDir, health.calls), 2, 'health後にsetup smokeを1回実行していない');
    } finally {
      await health.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('G1: shell注入可能なtarget・host・URLを受理しない', async () => {
    requireScripts();
    const health = await startHealthServer(200);
    try {
      const injections: Array<{ label: string; args: () => string[]; env: () => Record<string, string> }> = [
        { label: 'target: command substitution', args: () => ['$(touch marker)'], env: () => ({}) },
        { label: 'target: semicolon', args: () => ['deadbeef; touch marker'], env: () => ({}) },
        { label: 'target: space', args: () => ['1111 1111'], env: () => ({}) },
        { label: 'host: semicolon', args: () => [], env: () => ({ YORI_DEPLOY_HOST: 'yori-production; touch marker' }) },
        { label: 'host: command substitution', args: () => [], env: () => ({ YORI_DEPLOY_HOST: 'yori-production$(touch marker)' }) },
        { label: 'host: space', args: () => [], env: () => ({ YORI_DEPLOY_HOST: 'yori production' }) },
        { label: 'host: ssh option injection', args: () => [], env: () => ({ YORI_DEPLOY_HOST: '-oProxyCommand=touch marker' }) },
        { label: 'URL: semicolon', args: () => [], env: () => ({ YORI_DEPLOY_HEALTH_URL: 'https://yori-pilot.online/health/ready;touch marker' }) },
        { label: 'URL: command substitution', args: () => [], env: () => ({ YORI_DEPLOY_HEALTH_URL: 'http://127.0.0.1:1/health/ready$(touch marker)' }) },
        { label: 'URL: space', args: () => [], env: () => ({ YORI_DEPLOY_HEALTH_URL: 'not a url' }) },
      ];
      for (const injection of injections) {
        const stateDir = makeStateDir();
        try {
          const marker = path.join(stateDir, 'injected-marker');
          const replaceMarker = (value: string): string => value.split('marker').join(marker);
          const args = injection.args().map(replaceMarker);
          const overrides: Record<string, string> = {};
          for (const [key, value] of Object.entries(injection.env())) {
            overrides[key] = replaceMarker(value);
          }
          const result = runMac(args, stateDir, health.url, overrides);
          assert.notEqual(result.status, 0, `${injection.label}が0で終了した:\n${describeResult(result)}`);
          assert.equal(sshCalls(stateDir).length, 0, `${injection.label}でSSHした`);
          assert.equal(healthCallCount(stateDir, health.calls), 0, `${injection.label}でhealthを呼んだ`);
          assert.ok(!existsSync(marker), `${injection.label}で注入markerが作られた`);
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      }
    } finally {
      await health.close();
    }
  });

  it('G2: 秘密値を引数・log・標準出力へ出さない', async () => {
    requireScripts();
    const stateDir = makeStateDir();
    const health = await startHealthServer(200);
    try {
      const result = runMac([], stateDir, health.url, { YORI_POSTGRES_PASSWORD: SECRET_MARKER });
      assert.equal(result.status, 0, `secret付きdeployが0でない:\n${describeResult(result)}`);
      const output = result.stdout + result.stderr;
      const logs =
        readText(path.join(stateDir, 'commands.log')) +
        readText(path.join(stateDir, 'ssh.log')) +
        readText(path.join(stateDir, 'curl.log'));
      assert.ok(!output.includes(SECRET_MARKER), '標準出力・stderrへsecret markerが出た');
      assert.ok(!logs.includes(SECRET_MARKER), 'command log・ssh/curl引数へsecret markerが出た');
    } finally {
      await health.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('remote deployment/deploy.sh (Red)', () => {
  it('E1: migration後に旧ID取得→api/worker削除→個別起動→新ID・SHA・health・setup smokeを検証する', () => {
    requireRemoteScript();
    const stateDir = makeStateDir();
    try {
      const result = runRemote(stateDir, TARGET_SHA, remoteHappyEnv({ YORI_POSTGRES_PASSWORD: SECRET_MARKER }));
      assert.equal(result.status, 0, `remote scriptが0でない:\n${describeResult(result)}`);
      const lines = commandLines(stateDir);
      const findLine = (label: string, predicate: (line: string) => boolean): number => {
        const index = lines.findIndex(predicate);
        assert.ok(index !== -1, `${label}が実行されていない:\n${lines.join('\n')}`);
        return index;
      };
      const lockIndex = findLine('flock', (line) => line.startsWith('flock ') && line.includes('/srv/yori/'));
      const fetchIndex = findLine('git fetch', (line) => line.startsWith('git ') && line.includes(' fetch'));
      // fetchより前のrev-parseはold SHA取得でもよい。fetch後の最初の検証commandだけを順序へ使う。
      const verifyIndex = lines.findIndex(
        (line, index) =>
          index > fetchIndex && line.startsWith('git ') && (line.includes('rev-parse') || line.includes('merge-base') || line.includes('cat-file')),
      );
      assert.ok(verifyIndex !== -1, `fetch後のtarget検証が実行されていない:\n${lines.join('\n')}`);
      const mergeIndex = findLine('git merge --ff-only', (line) => line.startsWith('git ') && line.includes('merge --ff-only'));
      const configIndex = findLine('compose config --quiet', (line) => line.startsWith('docker ') && line.includes(' config') && line.includes('--quiet'));
      const pullIndex = findLine('compose pull', (line) => line.startsWith('docker ') && line.includes(' pull'));
      const dbIndex = findLine(
        'db up -d --wait',
        (line) => line.startsWith('docker ') && line.includes(' up ') && line.includes('--wait') && /(?:^|\s)db(?:\s|$)/.test(line),
      );
      const migrateIndex = findLine(
        'tools migrate',
        (line) => line.startsWith('docker ') && line.includes(' run ') && line.includes('migrate'),
      );
      const oldIdIndex = findLine('旧container ID取得', (line) => line.startsWith('docker ') && line.includes(' ps ') && line.includes(' -q '));
      const removeIndex = findLine(
        'api worker削除',
        (line) => line.startsWith('docker ') && line.includes(' rm ') && line.includes('api') && line.includes('worker'),
      );
      const apiUpIndex = findLine(
        'api新規起動',
        (line) => line.startsWith('docker ') && line.includes(' up ') && /(?:^|\s)api(?:\s|$)/.test(line) && !line.includes('worker'),
      );
      const workerUpIndex = findLine(
        'worker新規起動',
        (line) => line.startsWith('docker ') && line.includes(' up ') && /(?:^|\s)worker(?:\s|$)/.test(line),
      );
      const caddyUpIndex = findLine(
        'caddy再作成',
        (line) => line.startsWith('docker ') && line.includes(' up ') && line.includes('caddy') && line.includes('--force-recreate'),
      );
      const newIdIndex = lines.findIndex(
        (line, index) => index > caddyUpIndex && line.startsWith('docker ') && line.includes(' ps ') && line.includes(' -q '),
      );
      assert.ok(newIdIndex !== -1, `新container ID取得が実行されていない:\n${lines.join('\n')}`);
      const apiReleaseIndex = lines.findIndex(
        (line, index) => index > newIdIndex && line.startsWith('docker ') && line.includes(' exec ') && line.includes(' api '),
      );
      const workerReleaseIndex = lines.findIndex(
        (line, index) => index > newIdIndex && line.startsWith('docker ') && line.includes(' exec ') && line.includes(' worker '),
      );
      assert.ok(apiReleaseIndex !== -1 && workerReleaseIndex !== -1, `api/workerの稼働SHAを確認していない:\n${lines.join('\n')}`);
      const portIndex = findLine('compose port api 3210', (line) => line.startsWith('docker ') && line.includes(' port ') && line.includes('3210'));
      const healthIndex = findLine('curl health/ready', (line) => line.startsWith('curl ') && line.includes('/health/ready'));
      const smokeIndex = findLine('collector setup smoke', (line) => line.startsWith('curl ') && line.includes('/v1/collector/setup'));
      const psIndex = findLine('compose ps', (line) => line.startsWith('docker ') && line.includes(' ps') && !line.includes(' -q '));
      const indexes = [
        lockIndex,
        fetchIndex,
        verifyIndex,
        mergeIndex,
        configIndex,
        pullIndex,
        dbIndex,
        migrateIndex,
        oldIdIndex,
        removeIndex,
        apiUpIndex,
        workerUpIndex,
        caddyUpIndex,
        newIdIndex,
        apiReleaseIndex,
        workerReleaseIndex,
        portIndex,
        healthIndex,
        smokeIndex,
        psIndex,
      ];
      assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), `実行順序が契約と違う:\n${lines.join('\n')}`);

      for (const line of lines.filter(
        (line) => line.startsWith('docker ') && (line.includes(' config') || line.includes(' pull') || line.includes(' up ') || line.includes(' run ')),
      )) {
        assert.ok(line.startsWith('docker via-sudo'), `sudoなしのdocker呼び出し: ${line}`);
        assert.ok(line.includes('--env-file /etc/yori/yori.env'), `--env-fileがない: ${line}`);
        assert.ok(line.includes('-p yori'), `-p yoriがない: ${line}`);
        assert.ok(line.includes('deployment/compose.yaml'), `deployment/compose.yamlがない: ${line}`);
      }

      assert.ok((lines[removeIndex] ?? '').includes('-f'), `api/worker削除が強制停止を伴わない: ${lines[removeIndex] ?? ''}`);
      for (const index of [apiUpIndex, workerUpIndex, caddyUpIndex]) {
        assert.ok((lines[index] ?? '').includes('-d') && (lines[index] ?? '').includes('--wait'), `起動commandに-d --waitがない: ${lines[index] ?? ''}`);
      }
      const migrateLine = lines[migrateIndex] ?? '';
      assert.ok(migrateLine.includes('tools'), `migrateがtools profileでない: ${migrateLine}`);

      const output = result.stdout + result.stderr;
      assert.ok(output.includes(HEAD_SHA), `old SHAが表示されない:\n${output}`);
      assert.ok(output.includes(TARGET_SHA), `new SHAが表示されない:\n${output}`);
      assert.ok(output.includes('fake-ps'), `compose psの出力が表示されない:\n${output}`);
      assert.ok(
        (lines[healthIndex] ?? '').includes('http://127.0.0.1:39119/health/ready'),
        `loopbackのhealth URLが違う: ${lines[healthIndex] ?? ''}`,
      );
      assert.ok(
        (lines[smokeIndex] ?? '').includes('http://127.0.0.1:39119/v1/collector/setup'),
        `loopbackのsetup smoke URLが違う: ${lines[smokeIndex] ?? ''}`,
      );
      assert.ok(!output.includes(SECRET_MARKER), 'secret markerが出力された');
      assert.ok(!lines.join('\n').includes(SECRET_MARKER), 'secret markerがcommand logへ出た');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('E2: config失敗またはmigrate失敗ではapi worker caddyを再作成しない', () => {
    requireRemoteScript();
    const configState = makeStateDir();
    try {
      const result = runRemote(configState, TARGET_SHA, remoteHappyEnv({ FAKE_DOCKER_CONFIG_STATUS: '1' }));
      assert.notEqual(result.status, 0, `config失敗なのに0で終了した:\n${describeResult(result)}`);
      const lines = commandLines(configState);
      assert.ok(!lines.some((line) => line.includes('--force-recreate')), `config失敗後に再作成した:\n${lines.join('\n')}`);
      assert.ok(!lines.some((line) => line.includes(' rm ') && line.includes('api')), `config失敗後にapi/workerを削除した:\n${lines.join('\n')}`);
      assert.ok(!lines.some((line) => line.includes(' pull')), `config失敗後にpullした:\n${lines.join('\n')}`);
      assert.ok(!lines.some((line) => line.includes(' run ') && line.includes('migrate')), `config失敗後にmigrateした:\n${lines.join('\n')}`);
    } finally {
      rmSync(configState, { recursive: true, force: true });
    }

    const migrateState = makeStateDir();
    try {
      const result = runRemote(migrateState, TARGET_SHA, remoteHappyEnv({ FAKE_DOCKER_MIGRATE_STATUS: '1' }));
      assert.notEqual(result.status, 0, `migrate失敗なのに0で終了した:\n${describeResult(result)}`);
      const lines = commandLines(migrateState);
      assert.ok(lines.some((line) => line.includes(' run ') && line.includes('migrate')), 'migrateが実行されていない');
      assert.ok(!lines.some((line) => line.includes('--force-recreate')), `migrate失敗後に再作成した:\n${lines.join('\n')}`);
      assert.ok(!lines.some((line) => line.includes(' rm ') && line.includes('api')), `migrate失敗後にapi/workerを削除した:\n${lines.join('\n')}`);
    } finally {
      rmSync(migrateState, { recursive: true, force: true });
    }
  });

  it('E3: pull失敗またはdb起動失敗でもapi worker caddyを再作成しない', () => {
    requireRemoteScript();
    for (const [label, statusEnv] of [
      ['pull', 'FAKE_DOCKER_PULL_STATUS'],
      ['db', 'FAKE_DOCKER_DB_STATUS'],
    ] as Array<[string, string]>) {
      const stateDir = makeStateDir();
      try {
        const result = runRemote(stateDir, TARGET_SHA, remoteHappyEnv({ [statusEnv]: '1' }));
        assert.notEqual(result.status, 0, `${label}失敗なのに0で終了した:\n${describeResult(result)}`);
        const lines = commandLines(stateDir);
        assert.ok(!lines.some((line) => line.includes('--force-recreate')), `${label}失敗後に再作成した:\n${lines.join('\n')}`);
        assert.ok(!lines.some((line) => line.includes(' rm ') && line.includes('api')), `${label}失敗後にapi/workerを削除した:\n${lines.join('\n')}`);
        assert.ok(!lines.some((line) => line.includes(' run ') && line.includes('migrate')), `${label}失敗後にmigrateした:\n${lines.join('\n')}`);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  });

  it('E4: remote worktreeがdirtyならmergeや再作成をしない', () => {
    requireRemoteScript();
    const stateDir = makeStateDir();
    try {
      const result = runRemote(stateDir, TARGET_SHA, remoteHappyEnv({ FAKE_GIT_DIRTY: 'tracked' }));
      assert.notEqual(result.status, 0, `remote dirtyなのに0で終了した:\n${describeResult(result)}`);
      const lines = commandLines(stateDir);
      assert.ok(!lines.some((line) => line.startsWith('git ') && line.includes('merge --ff-only')), `dirtyなのにmergeした:\n${lines.join('\n')}`);
      assert.ok(!lines.some((line) => line.includes('--force-recreate')), `dirtyなのに再作成した:\n${lines.join('\n')}`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('E5: origin/main未包含またはfast-forward不可のtargetはmergeしない', () => {
    requireRemoteScript();
    const notContainedState = makeStateDir();
    try {
      const result = runRemote(notContainedState, UNPUSHED_SHA, remoteHappyEnv({ FAKE_GIT_CONTAINED: HEAD_SHA, FAKE_GIT_KNOWN: UNPUSHED_SHA }));
      assert.notEqual(result.status, 0, `origin/main未包含なのに0で終了した:\n${describeResult(result)}`);
      const lines = commandLines(notContainedState);
      assert.ok(!lines.some((line) => line.startsWith('git ') && line.includes('merge --ff-only')), `未包含なのにmergeした:\n${lines.join('\n')}`);
      assert.ok(!lines.some((line) => line.includes('--force-recreate')), `未包含なのに再作成した:\n${lines.join('\n')}`);
    } finally {
      rmSync(notContainedState, { recursive: true, force: true });
    }

    const divergeState = makeStateDir();
    try {
      const result = runRemote(divergeState, TARGET_SHA, remoteHappyEnv({ FAKE_GIT_FF_OK: '0', FAKE_GIT_DIVERGED: '1' }));
      assert.notEqual(result.status, 0, `fast-forward不可なのに0で終了した:\n${describeResult(result)}`);
      const lines = commandLines(divergeState);
      assert.ok(!lines.some((line) => line.startsWith('git ') && line.includes('merge --ff-only')), `fast-forward不可なのにmergeした:\n${lines.join('\n')}`);
    } finally {
      rmSync(divergeState, { recursive: true, force: true });
    }
  });

  it('E6: /etc/yori/yori.envがroot:root 0600でなければ停止する', () => {
    requireRemoteScript();
    for (const [label, overrides] of [
      ['mode 644', { FAKE_ENVFILE_MODE: '644' }],
      ['owner ubuntu', { FAKE_ENVFILE_OWNER: 'ubuntu' }],
    ] as Array<[string, Record<string, string>]>) {
      const stateDir = makeStateDir();
      try {
        const result = runRemote(stateDir, TARGET_SHA, remoteHappyEnv(overrides));
        assert.notEqual(result.status, 0, `${label}なのに0で終了した:\n${describeResult(result)}`);
        const lines = commandLines(stateDir);
        assert.ok(!lines.some((line) => line.includes(' config')), `${label}なのにconfigした:\n${lines.join('\n')}`);
        assert.ok(!lines.some((line) => line.includes('--force-recreate')), `${label}なのに再作成した:\n${lines.join('\n')}`);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  });

  it('E6b: /etc/yoriがroot:root 0700でもsudo statでenvを検査してdeployできる', () => {
    requireRemoteScript();
    const stateDir = makeStateDir();
    try {
      const result = runRemote(stateDir, TARGET_SHA, remoteHappyEnv({ FAKE_ENV_PARENT_MODE: '700' }));
      assert.equal(result.status, 0, `親directory 0700でdeployできない:\n${describeResult(result)}`);
      const lines = commandLines(stateDir);
      const sudoStat = lines.findIndex((line) => line.startsWith('sudo ') && line.includes('stat'));
      const stat = lines.findIndex((line) => line.startsWith('stat '));
      assert.ok(sudoStat !== -1 && stat !== -1 && sudoStat < stat, `sudo statを実行していない:\n${lines.join('\n')}`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('E6c: apiまたはworkerのcontainer IDが更新されなければ失敗する', () => {
    requireRemoteScript();
    for (const service of ['API', 'WORKER']) {
      const stateDir = makeStateDir();
      try {
        const overrides = {
          [`FAKE_DOCKER_${service}_OLD_ID`]: `same-${service.toLowerCase()}-id`,
          [`FAKE_DOCKER_${service}_NEW_ID`]: `same-${service.toLowerCase()}-id`,
        };
        const result = runRemote(stateDir, TARGET_SHA, remoteHappyEnv(overrides));
        assert.notEqual(result.status, 0, `${service} ID未更新なのに0で終了した:\n${describeResult(result)}`);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  });

  it('E6d: 初回deployで旧containerが無くても新ID・SHA・health・smokeが揃えば成功する', () => {
    requireRemoteScript();
    const stateDir = makeStateDir();
    try {
      const result = runRemote(stateDir, TARGET_SHA, remoteHappyEnv({ FAKE_DOCKER_NO_OLD: '1' }));
      assert.equal(result.status, 0, `初回deployが失敗した:\n${describeResult(result)}`);
      const lines = commandLines(stateDir);
      assert.ok(lines.some((line) => line.includes('/health/ready')), '初回deployでhealthを確認していない');
      assert.ok(lines.some((line) => line.includes('/v1/collector/setup')), '初回deployでsetup smokeを確認していない');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('E6e: loopback healthのSHA不一致またはsetup 404を成功扱いしない', () => {
    requireRemoteScript();
    for (const [label, overrides] of [
      ['SHA不一致', { FAKE_HEALTH_SHA: HEAD_SHA }],
      [
        'setup 404',
        {
          FAKE_SETUP_HTTP_CODE: '404',
          FAKE_SETUP_BODY: '{"message":"Route POST:/v1/collector/setup not found","error":"Not Found","statusCode":404}',
        },
      ],
    ] as Array<[string, Record<string, string>]>) {
      const stateDir = makeStateDir();
      try {
        const result = runRemote(stateDir, TARGET_SHA, remoteHappyEnv(overrides));
        assert.notEqual(result.status, 0, `${label}なのに0で終了した:\n${describeResult(result)}`);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  });

  it('E6f: apiまたはworkerの稼働SHA確認が失敗すればdeployを失敗させる', () => {
    requireRemoteScript();
    for (const key of ['FAKE_DOCKER_API_RELEASE_STATUS', 'FAKE_DOCKER_WORKER_RELEASE_STATUS']) {
      const stateDir = makeStateDir();
      try {
        const result = runRemote(stateDir, TARGET_SHA, remoteHappyEnv({ [key]: '1' }));
        assert.notEqual(result.status, 0, `${key}失敗なのに0で終了した:\n${describeResult(result)}`);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  });

  it('E7: lock取得失敗時はgit処理も再作成もしない', () => {
    requireRemoteScript();
    const stateDir = makeStateDir();
    try {
      const result = runRemote(stateDir, TARGET_SHA, remoteHappyEnv({ FAKE_FLOCK_STATUS: '1' }));
      assert.notEqual(result.status, 0, `lock失敗なのに0で終了した:\n${describeResult(result)}`);
      const lines = commandLines(stateDir);
      assert.ok(!lines.some((line) => line.includes(' merge --ff-only')), `lock失敗後にmergeした:\n${lines.join('\n')}`);
      assert.ok(!lines.some((line) => line.includes('--force-recreate')), `lock失敗後に再作成した:\n${lines.join('\n')}`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('F: 両script本文にgit reset/checkout、down -v、volume削除がない', () => {
    requireScripts();
    for (const file of [MAC_SCRIPT, REMOTE_SCRIPT]) {
      const source = readFileSync(file, 'utf8');
      const name = path.basename(file);
      assert.ok(!/\bgit\b[^\n]*\b(reset|checkout)\b/.test(source), `${name}にgit reset/checkoutがある`);
      assert.ok(!/\bdown\b[^\n]*\s-v\b/.test(source), `${name}にdown -vがある`);
      assert.ok(!/\bvolume\s+(rm|prune)\b/.test(source), `${name}にvolume削除がある`);
      assert.ok(!/\bdocker\s+volume\b/.test(source), `${name}にdocker volume操作がある`);
    }
  });
});
