import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadCollectorConfig, parseCollectorConfig } from '../config.js';

const PROJECT_ID = '018f0a00-0000-7000-8000-000000000001';

function validConfig(): Record<string, unknown> {
  return {
    api_url: 'https://api.example.test',
    token_env: 'YORI_TOKEN',
    state_dir: '/var/tmp/yori-collector',
    projects: [{ repository: 'github.com/Org/Repo', project_id: PROJECT_ID }],
  };
}

describe('collector設定', () => {
  it('repositoryとproject_idを正規化し、設定ファイルから同じ結果を読み込む', async () => {
    const parsed = parseCollectorConfig({
      ...validConfig(),
      projects: [{ repository: 'GitHub.com/Org/Repo.git', project_id: PROJECT_ID.toUpperCase() }],
    });
    assert.equal(parsed.api_url, 'https://api.example.test');
    assert.equal(parsed.token_env, 'YORI_TOKEN');
    assert.equal(parsed.state_dir, '/var/tmp/yori-collector');
    assert.deepEqual(parsed.projects, [{ repository: 'github.com/Org/Repo', project_id: PROJECT_ID }]);

    const dir = await mkdtemp(path.join(tmpdir(), 'yori-collector-config-'));
    try {
      const file = path.join(dir, 'collector.json');
      await writeFile(file, JSON.stringify(validConfig()), 'utf8');
      assert.deepEqual(loadCollectorConfig(file), parseCollectorConfig(validConfig()));
      await writeFile(file, '{not json', 'utf8');
      assert.throws(() => loadCollectorConfig(file));
      assert.throws(() => loadCollectorConfig(path.join(dir, 'missing.json')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('HTTPSと開発用loopback HTTPだけをapi_urlとして許可する', () => {
    for (const api_url of ['https://api.example.test', 'http://127.0.0.1:3210', 'http://localhost:3210', 'http://[::1]:3210']) {
      assert.equal(parseCollectorConfig({ ...validConfig(), api_url }).api_url, api_url);
    }
    for (const api_url of [
      'http://api.example.test',
      'https://user:secret@api.example.test',
      'https://api.example.test/v1?x=1',
      'https://api.example.test/v1#frag',
      'ftp://api.example.test',
      'not-a-url',
    ]) {
      assert.throws(() => parseCollectorConfig({ ...validConfig(), api_url }), `api_url ${api_url} を受理している`);
    }
  });

  it('state_dir/token_env/projectsの不正とrepository重複を拒否する', () => {
    assert.equal(parseCollectorConfig(validConfig()).projects.length, 1);
    assert.deepEqual(parseCollectorConfig({ ...validConfig(), projects: [] }).projects, []);
    assert.throws(() => parseCollectorConfig({ ...validConfig(), state_dir: 'relative/state' }));
    assert.throws(() => parseCollectorConfig({ ...validConfig(), token_env: '' }));
    assert.throws(() =>
      parseCollectorConfig({ ...validConfig(), projects: [{ repository: 'github.com/Org/Repo', project_id: 'not-a-uuid' }] }),
    );
    assert.throws(() => parseCollectorConfig({ ...validConfig(), projects: [{ repository: '/local/path', project_id: PROJECT_ID }] }));
    assert.throws(() =>
      parseCollectorConfig({
        ...validConfig(),
        projects: [
          { repository: 'github.com/Org/Repo', project_id: PROJECT_ID },
          { repository: 'GitHub.com/Org/Repo.git', project_id: randomUUID() },
        ],
      }),
    );
  });
});
