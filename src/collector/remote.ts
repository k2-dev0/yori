import type { CollectorConfig, CollectorProject } from './config.js';

// HTTPS/SSH/SCP形式のgit remoteをcanonical host/pathへ正規化する。非対応・曖昧なremoteはnull。
export function normalizeGitRemote(_remoteUrl: string): string | null {
  throw new Error('collector remote: 未実装');
}

// 設定に書かれたrepository値をcanonical host/pathへ正規化する。
export function normalizeRepositoryIdentifier(_value: string): string | null {
  throw new Error('collector remote: 未実装');
}

// hook.cwdからgitを引数配列で呼び、remote.origin.urlをcanonical repositoryへ正規化する。
export function resolveRepositoryFromCwd(_cwd: string): string | null {
  throw new Error('collector remote: 未実装');
}

// canonical repositoryが設定の対応表にあればprojectを返す。未登録はundefined。
export function findRegisteredProject(_config: CollectorConfig, _repository: string): CollectorProject | undefined {
  throw new Error('collector remote: 未実装');
}
