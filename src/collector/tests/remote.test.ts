import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { findRegisteredProject, normalizeGitRemote, normalizeRepositoryIdentifier, resolveRepositoryFromCwd } from '../remote.js';
import { addGitWorktree, createGitRepository, makeTempDir, removeTempDir } from './support.js';

const PROJECT_ID = '018f0a00-0000-7000-8000-000000000001';
const CONFIG = {
  api_url: 'https://api.example.test',
  token_env: 'YORI_TEST_TOKEN',
  state_dir: '/var/tmp/yori-collector',
  projects: [{ repository: 'github.com/Org/Repo', project_id: PROJECT_ID }],
};

describe('remote正規化', () => {
  it('HTTPS/SSH/SCP形式をhost小文字・path大小文字維持でcanonical化する', () => {
    assert.equal(normalizeGitRemote('https://github.com/Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeGitRemote('https://user:password@GitHub.com/Org/Repo.git?x=1#frag'), 'github.com/Org/Repo');
    assert.equal(normalizeGitRemote('git@GitHub.com:Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeGitRemote('ssh://git@github.com/Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeGitRemote('ssh://git@github.com:22/Org/Repo.git'), 'github.com/Org/Repo');
  });

  it('ローカルpath・file URL・曖昧なremoteは識別子にしない', () => {
    assert.equal(normalizeGitRemote('/local/path/repo'), null);
    assert.equal(normalizeGitRemote('file:///tmp/repo'), null);
    assert.equal(normalizeGitRemote('git://github.com/Org/Repo.git'), null);
    assert.equal(normalizeGitRemote('https://github.com'), null);
    assert.equal(normalizeGitRemote(''), null);
  });

  it('設定側のrepository値もcanonical化し、不正値は拒否する', () => {
    assert.equal(normalizeRepositoryIdentifier('github.com/Org/Repo'), 'github.com/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('GitHub.com/Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('https://user:password@github.com/Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('git@github.com:Org/Repo.git'), 'github.com/Org/Repo');
    assert.equal(normalizeRepositoryIdentifier('/local/path'), null);
    assert.equal(normalizeRepositoryIdentifier('not a repository'), null);
    assert.equal(normalizeRepositoryIdentifier(''), null);
  });

  it('git worktreeは同じcanonical repositoryとして解決する', async () => {
    const dir = await makeTempDir();
    try {
      const repo = path.join(dir, 'main');
      const worktree = path.join(dir, 'worktree');
      await createGitRepository(repo, 'git@GitHub.com:Org/Repo.git');
      assert.equal(resolveRepositoryFromCwd(repo), 'github.com/Org/Repo');
      await addGitWorktree(repo, worktree);
      assert.equal(resolveRepositoryFromCwd(worktree), 'github.com/Org/Repo');
      assert.equal(resolveRepositoryFromCwd(path.join(dir, 'missing')), null);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('登録済みrepositoryだけをprojectへ対応付ける', async () => {
    assert.equal(findRegisteredProject(CONFIG, 'github.com/Org/Repo')?.project_id, PROJECT_ID);
    assert.equal(findRegisteredProject(CONFIG, 'github.com/Org/Other'), undefined);

    const dir = await makeTempDir();
    try {
      const plain = path.join(dir, 'plain');
      const localRemote = path.join(dir, 'local-remote');
      await createGitRepository(plain, null);
      await createGitRepository(localRemote, '/tmp/elsewhere/repo');
      assert.equal(resolveRepositoryFromCwd(plain), null);
      assert.equal(resolveRepositoryFromCwd(localRemote), null);
    } finally {
      await removeTempDir(dir);
    }
  });
});
