import { execFileSync } from 'node:child_process';
import type { CollectorConfig, CollectorProject } from './config.js';

const DEFAULT_PORTS: Record<string, string> = { 'https:': '443', 'ssh:': '22' };

// host小文字＋先頭のないpath（末尾slash・末尾.git除去、path大小文字維持）へ揃える。
function canonicalizePath(host: string, rawPath: string): string | null {
  let repoPath = rawPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (repoPath.endsWith('.git')) {
    repoPath = repoPath.slice(0, -4);
  }
  repoPath = repoPath.replace(/\/+$/, '');
  if (host.length === 0 || repoPath.length === 0) {
    return null;
  }
  return `${host}/${repoPath}`;
}

// https/ssh URLからhost+portとpathを取り出す。userinfo/query/fragmentは識別子へ残さない。
function canonicalizeRemoteUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const port = url.port;
  const hostWithPort = port.length > 0 && port !== DEFAULT_PORTS[url.protocol] ? `${host}:${port}` : host;
  return canonicalizePath(hostWithPort, url.pathname);
}

// scp形式 (user@host:path) をhostとpathへ分解する。
function canonicalizeScp(value: string): string | null {
  const match = /^(?:[^@/]+@)?([A-Za-z0-9.-]+(?::\d+)?):(.+)$/.exec(value);
  if (!match) {
    return null;
  }
  const host = match[1];
  const portSeparator = host.lastIndexOf(':');
  const hostname = (portSeparator === -1 ? host : host.slice(0, portSeparator)).toLowerCase();
  const port = portSeparator === -1 ? '' : host.slice(portSeparator + 1);
  const hostWithPort = port.length > 0 && port !== '22' ? `${hostname}:${port}` : hostname;
  return canonicalizePath(hostWithPort, match[2]);
}

// ローカルpathやWindows driveはremote識別子にしない。
function isLocalPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || /^[A-Za-z]:[\\/]/.test(value);
}

// HTTPS/SSH/SCP形式のgit remoteをcanonical host/pathへ正規化する。非対応・曖昧なremoteはnull。
export function normalizeGitRemote(remoteUrl: string): string | null {
  const value = remoteUrl.trim();
  if (value.length === 0 || isLocalPath(value)) {
    return null;
  }
  if (value.includes('://')) {
    return canonicalizeRemoteUrl(value);
  }
  return canonicalizeScp(value);
}

// 設定に書かれたrepository値をcanonical host/pathへ正規化する。URL形式とcanonical形式の両方を受ける。
export function normalizeRepositoryIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || isLocalPath(trimmed)) {
    return null;
  }
  if (trimmed.includes('://')) {
    return canonicalizeRemoteUrl(trimmed);
  }
  const canonical = /^([A-Za-z0-9.-]+(?::\d+)?)\/(.+)$/.exec(trimmed);
  if (canonical) {
    const host = canonical[1];
    const portSeparator = host.lastIndexOf(':');
    const hostname = (portSeparator === -1 ? host : host.slice(0, portSeparator)).toLowerCase();
    const port = portSeparator === -1 ? '' : host.slice(portSeparator + 1);
    const hostWithPort = port.length > 0 && port !== '22' ? `${hostname}:${port}` : hostname;
    return canonicalizePath(hostWithPort, canonical[2]);
  }
  if (trimmed.includes('@')) {
    return canonicalizeScp(trimmed);
  }
  return null;
}

// hook.cwdからgitを引数配列で呼び、remote.origin.urlをcanonical repositoryへ正規化する。
export function resolveRepositoryFromCwd(cwd: string): string | null {
  let toplevel: string;
  try {
    toplevel = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  if (toplevel.length === 0) {
    return null;
  }
  let remote: string;
  try {
    remote = execFileSync('git', ['-C', toplevel, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  return normalizeGitRemote(remote);
}

// canonical repositoryが設定の対応表にあればprojectを返す。未登録はundefined。
export function findRegisteredProject(config: CollectorConfig, repository: string): CollectorProject | undefined {
  return config.projects.find((project) => project.repository === repository);
}
