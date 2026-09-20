import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './docker.js';

// 通常composeが使う開発用volume名。テスト用projectから参照・共有されてはならない。
const DEV_VOLUMES = ['yori-pgdata', 'yori-node-modules', 'yori-npm-cache'];

interface ComposePort {
  host_ip?: string;
  published?: string;
  target?: number;
}

interface ComposeConfig {
  services: Record<string, { image?: string; ports?: ComposePort[]; network_mode?: string }>;
  volumes?: Record<string, { name?: string }>;
}

// compose configはdaemon不要で、テスト用project/volumeの環境変数に左右されないenvで実行する。
function composeConfig(args: string[]): Promise<ComposeConfig> {
  const env = { ...process.env };
  for (const key of [
    'COMPOSE_FILE',
    'COMPOSE_PROJECT_NAME',
    'COMPOSE_PROFILES',
    'YORI_API_PORT',
    'YORI_PGDATA_VOLUME',
    'YORI_NODE_MODULES_VOLUME',
    'YORI_NPM_CACHE_VOLUME',
    'YORI_TEST_PGDATA_VOLUME',
    'YORI_TEST_NODE_MODULES_VOLUME',
    'YORI_TEST_NPM_CACHE_VOLUME',
  ]) {
    delete env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', ...args, 'config', '--format', 'json'], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`docker compose configが失敗しました (exit ${code}): ${stderr.trim()}`));
        return;
      }
      resolve(JSON.parse(stdout) as ComposeConfig);
    });
  });
}

function volumeNames(config: ComposeConfig): string[] {
  return Object.values(config.volumes ?? {}).map((volume) => volume.name ?? '');
}

describe('deploymentのテスト構成分離', () => {
  it('通常composeはtest serviceを持たず、開発用volume名を維持する', async () => {
    const defaultConfig = await composeConfig(['-f', 'deployment/compose.yaml']);
    assert.equal(
      Object.hasOwn(defaultConfig.services, 'test'),
      false,
      `通常composeのデフォルト起動にtest serviceが含まれる: ${Object.keys(defaultConfig.services).join(', ')}`,
    );
    assert.ok(
      Object.keys(defaultConfig.services).every((name) => ['api', 'db', 'migrate'].includes(name)),
      `通常composeに想定外のserviceがある: ${Object.keys(defaultConfig.services).join(', ')}`,
    );
    assert.deepEqual(volumeNames(defaultConfig).sort(), [...DEV_VOLUMES].sort(), '通常composeの開発用volume名が変わっている');

    // profileで隠したtest serviceも残存として検出する。
    const allProfiles = await composeConfig(['--profile', '*', '-f', 'deployment/compose.yaml']);
    assert.equal(
      Object.hasOwn(allProfiles.services, 'test'),
      false,
      `通常composeにtest serviceが残っている: ${Object.keys(allProfiles.services).join(', ')}`,
    );
  });

  it('テスト専用composeはprojectごとに隔離したvolumeを使い、開発DBを公開しない', async () => {
    const testCompose = path.join(REPO_ROOT, 'deployment', 'compose.test.yaml');
    assert.ok(existsSync(testCompose), 'deployment/compose.test.yaml が未作成');

    const first = await composeConfig(['-p', 'yori-test-a', '--profile', '*', '-f', 'deployment/compose.test.yaml']);
    const second = await composeConfig(['-p', 'yori-test-b', '--profile', '*', '-f', 'deployment/compose.test.yaml']);

    assert.deepEqual(
      Object.keys(first.services).sort(),
      ['api', 'db', 'migrate', 'test'],
      `テスト専用composeのservice構成が違う: ${Object.keys(first.services).join(', ')}`,
    );

    const firstVolumes = volumeNames(first);
    const secondVolumes = volumeNames(second);
    assert.ok(firstVolumes.length >= 1, `テスト専用composeにvolume定義が無い`);
    for (const name of firstVolumes) {
      assert.equal(DEV_VOLUMES.includes(name), false, `テストvolumeが開発volume名を参照している: ${name}`);
      assert.ok(name.startsWith('yori-test-a_'), `volumeがCompose projectで隔離されていない: ${name}`);
    }
    assert.equal(
      firstVolumes.some((name) => secondVolumes.includes(name)),
      false,
      `projectを変えてもvolumeが共有される: ${firstVolumes.join(', ')} / ${secondVolumes.join(', ')}`,
    );
    assert.deepEqual(first.services.db.ports ?? [], [], `テストDBがホストへポートを公開している: ${JSON.stringify(first.services.db.ports)}`);
    assert.notEqual(first.services.db.network_mode, 'host', 'テストDBがhost networkを使っている');

    // 現状継承の基本設定: imageはdigest固定、テストAPIは開発用(39119)と分離したloopback 39120で公開する。
    for (const [name, service] of Object.entries(first.services)) {
      assert.ok(service.image?.includes('@sha256:'), `${name}のimageがdigest固定されていない: ${service.image ?? ''}`);
    }
    const apiPorts = first.services.api.ports ?? [];
    assert.ok(
      apiPorts.some((port) => port.host_ip === '127.0.0.1' && port.published === '39120' && port.target === 3210),
      `テストAPIが127.0.0.1:39120で公開されていない: ${JSON.stringify(apiPorts)}`,
    );
  });
});
