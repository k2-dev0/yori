#!/usr/bin/env node
// MacからLightsailへ1コマンドでdeployする入口。npm run deploy:production から呼ばれる。
// 秘密値は受け取らず、引数・logへ出さない。SSHは~/.ssh/configのhost alias（ProxyJump可）を使う。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_HOST = 'yori-production';
const DEFAULT_HEALTH_URL = 'https://yori-pilot.online/health/ready';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
// SSH aliasとして安全な文字だけを許す。先頭-（ssh option化）、空白、shell文字は拒否する。
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// URLに空白やshellのmetacharacter、quote、backslashを含めない。
const UNSAFE_URL_PATTERN = /[\s;`$()|&<>'"\\]/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) {
    fail(`git ${args.join(' ')} を実行できない: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    fail(`git ${args.join(' ')} が失敗した${detail.length > 0 ? `: ${detail}` : ''}`);
  }
  return (result.stdout ?? '').trim();
}

// 引数は40桁hex SHAだけ。省略時はlocal HEADを使う。
function parseTarget(args) {
  if (args.length > 1) {
    fail('targetは1つだけ指定できる');
  }
  if (args.length === 0) {
    return null;
  }
  const target = args[0];
  if (!SHA_PATTERN.test(target)) {
    fail('targetは40桁hexのGit SHAで指定する');
  }
  return target;
}

function parseHost() {
  const host = process.env.YORI_DEPLOY_HOST ?? DEFAULT_HOST;
  if (!HOST_PATTERN.test(host)) {
    fail('YORI_DEPLOY_HOSTがSSH host名として不正');
  }
  return host;
}

// 既定はhttpsだけ。テスト用にloopbackのhttpのみ許可する。userinfoを含むURLも拒否する。
function parseHealthUrl() {
  const raw = process.env.YORI_DEPLOY_HEALTH_URL ?? DEFAULT_HEALTH_URL;
  if (UNSAFE_URL_PATTERN.test(raw)) {
    fail('YORI_DEPLOY_HEALTH_URLに使用できない文字が含まれる');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('YORI_DEPLOY_HEALTH_URLがURLとして解釈できない');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    fail('YORI_DEPLOY_HEALTH_URLにcredentialを含めない');
  }
  if (parsed.protocol === 'https:') {
    return parsed;
  }
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) {
    return parsed;
  }
  fail('YORI_DEPLOY_HEALTH_URLはhttps（loopbackのhttpのみ許可）で指定する');
}

// curlをPATHから起動する。--failで非200を非0にし、--silentでbodyを表示せず、--show-errorで失敗理由だけstderrへ出す。
function checkPublicHealth(url) {
  const result = spawnSync(
    'curl',
    ['--fail', '--silent', '--show-error', '--connect-timeout', '5', '--max-time', '20', url.href],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (result.error) {
    fail(`公開healthを確認できない: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`公開healthを確認できない (curl exit ${result.status})`);
  }
}

function main() {
  const targetArg = parseTarget(process.argv.slice(2));
  const host = parseHost();
  const healthUrl = parseHealthUrl();

  const repoRoot = runGit(['rev-parse', '--show-toplevel'], process.cwd());
  if (repoRoot.length === 0) {
    fail('repository rootを決定できない');
  }
  // tracked/staged/untrackedのどれでも、SSH前に失敗して未確認のsourceを配布しない。
  const dirty = runGit(['status', '--porcelain=v1', '--untracked-files=all'], repoRoot);
  if (dirty.length > 0) {
    fail('working treeがdirty。commitしてからdeployする');
  }

  const oldHead = runGit(['rev-parse', '--verify', 'HEAD^{commit}'], repoRoot);
  const target = targetArg ?? oldHead;
  if (!SHA_PATTERN.test(target) || !SHA_PATTERN.test(oldHead)) {
    fail('Git SHAを40桁hexで解決できない');
  }

  runGit(['fetch', 'origin', 'main'], repoRoot);

  // origin/mainへ含まれないcommit（未push）は配布しない。
  runGit(['cat-file', '-e', `${target}^{commit}`], repoRoot);
  runGit(['merge-base', '--is-ancestor', target, 'origin/main'], repoRoot);

  // remoteの旧scriptの有無に依存せず、現在のdeploy.sh本文をstdinで渡す。
  const deployScript = readFileSync(path.join(repoRoot, 'deployment', 'deploy.sh'), 'utf8');
  const remote = spawnSync('ssh', [host, 'bash', '-s', '--', target], {
    input: deployScript,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (remote.error) {
    fail(`sshの起動に失敗した: ${remote.error.message}`);
  }
  if (remote.status !== 0) {
    fail(`remote deployが失敗した (exit ${remote.status})`);
  }

  // remote成功後だけ公開healthを確認し、200なら終了0。
  checkPublicHealth(healthUrl);
  console.log(`deploy: ${target} を配布し、公開health ${healthUrl.href} が200`);
}

main();
