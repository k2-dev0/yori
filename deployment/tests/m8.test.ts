import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './docker.js';

// M8の配置契約。production profileはCaddy HTTPS gatewayだけを外部公開し、
// 永続化とlog rotationを維持する。実クラウド作成・実外部API送信は行わない。

interface ComposePort {
  host_ip?: string;
  published?: string;
  target?: number;
  protocol?: string;
}

interface ComposeVolume {
  type?: string;
  source?: string;
  target?: string;
}

interface ComposeLogging {
  driver?: string;
  options?: Record<string, string>;
}

interface ComposeService {
  image?: string;
  profiles?: string[];
  ports?: ComposePort[];
  volumes?: ComposeVolume[];
  logging?: ComposeLogging;
  depends_on?: Record<string, unknown>;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string }>;
}

// compose configはdaemon不要で、テスト環境のCOMPOSE_*・volume名へ左右されないenvで実行する。
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

function isLoopback(hostIp: string | undefined): boolean {
  return hostIp === '127.0.0.1' || hostIp === '::1' || hostIp === '[::1]';
}

describe('M8 配置: production profileのCaddy HTTPS gateway', () => {
  it('production profileはCaddyを提供し、外部公開を80/443だけにする', async () => {
    const config = await composeConfig(['--profile', 'production', '-f', 'deployment/compose.yaml']);
    const services = config.services;
    const caddy = services.caddy;
    assert.ok(caddy, `production profileにcaddy serviceがない: ${Object.keys(services).join(', ')}`);
    assert.ok(caddy.image?.includes('caddy'), `caddy imageがcaddyでない: ${caddy.image ?? ''}`);
    assert.ok(caddy.image?.includes('@sha256:'), `caddy imageがdigest固定されていない: ${caddy.image ?? ''}`);
    assert.ok(
      Object.hasOwn(caddy.depends_on ?? {}, 'api'),
      'caddyがapiのhealthcheck後に起動するdepends_onを持たない',
    );

    const caddyPorts = caddy.ports ?? [];
    const caddyPublished = new Set(caddyPorts.map((port) => String(port.published)));
    assert.ok(caddyPublished.has('80'), `caddyが80を公開していない: ${JSON.stringify(caddyPorts)}`);
    assert.ok(caddyPublished.has('443'), `caddyが443を公開していない: ${JSON.stringify(caddyPorts)}`);
    for (const port of caddyPorts) {
      assert.ok([80, 443].includes(Number(port.target)), `caddyが80/443以外を待ち受ける: ${JSON.stringify(port)}`);
      assert.ok(['80', '443'].includes(String(port.published)), `caddyが80/443以外を公開する: ${JSON.stringify(port)}`);
    }

    // 全serviceのhost公開は80/443だけ。APIはloopback、DBは非公開。
    for (const [name, service] of Object.entries(services)) {
      for (const port of service.ports ?? []) {
        if (!isLoopback(port.host_ip)) {
          assert.ok(
            ['80', '443'].includes(String(port.published)),
            `${name}が80/443以外を外部公開する: ${JSON.stringify(port)}`,
          );
        }
      }
    }
    const apiPorts = services.api?.ports ?? [];
    assert.ok(apiPorts.length >= 1, 'apiのhost公開がない');
    for (const port of apiPorts) {
      assert.ok(isLoopback(port.host_ip), `apiがloopback以外へ公開されている: ${JSON.stringify(port)}`);
    }
    assert.deepEqual(services.db?.ports ?? [], [], `DBがホストへポートを公開している: ${JSON.stringify(services.db?.ports ?? [])}`);

    // Caddy data/configとPostgreSQLを永続化する。
    const caddyVolumeTargets = (caddy.volumes ?? []).map((volume) => volume.target);
    for (const target of ['/data', '/config']) {
      assert.ok(caddyVolumeTargets.includes(target), `caddyの${target}が永続化されていない: ${JSON.stringify(caddy.volumes ?? [])}`);
    }
    for (const volume of caddy.volumes ?? []) {
      if (volume.target === '/data' || volume.target === '/config') {
        assert.ok(volume.source !== undefined && volume.source.length > 0, `caddy volumeのsourceがない: ${JSON.stringify(volume)}`);
      }
    }
    const volumeNames = Object.values(config.volumes ?? {}).map((volume) => volume.name ?? '');
    assert.ok(volumeNames.includes('yori-pgdata'), `PostgreSQLの永続volumeがない: ${volumeNames.join(', ')}`);

    // 全serviceのjson-file log rotationを維持する。
    for (const [name, service] of Object.entries(services)) {
      assert.equal(service.logging?.driver, 'json-file', `${name}のlogging driverがjson-fileでない`);
      assert.ok(service.logging.options?.['max-size'], `${name}のlog max-sizeがない`);
      assert.ok(service.logging.options?.['max-file'], `${name}のlog max-fileがない`);
    }

    // CaddyfileでHTTPS終端としてapi内部portへ転送する。
    const caddyfileMount = (caddy.volumes ?? []).find(
      (volume) => volume.type === 'bind' && volume.target === '/etc/caddy/Caddyfile',
    );
    assert.ok(caddyfileMount?.source, 'Caddyfileのbind mountがない');
    assert.ok(existsSync(caddyfileMount.source), `Caddyfileが存在しない: ${caddyfileMount.source}`);
    const caddyfile = await readFile(caddyfileMount.source, 'utf8');
    assert.match(caddyfile, /reverse_proxy\s+api:3210/, 'Caddyfileがapi:3210へreverse_proxyしていない');
  });

  it('production profileなしの通常composeはgateway portを公開しない', async () => {
    const config = await composeConfig(['-f', 'deployment/compose.yaml']);
    assert.equal(Object.hasOwn(config.services, 'caddy'), false, 'production profileのcaddyが既定起動へ含まれる');
    for (const [name, service] of Object.entries(config.services)) {
      for (const port of service.ports ?? []) {
        assert.notEqual(String(port.published), '80', `${name}が既定起動で80を公開する`);
        assert.notEqual(String(port.published), '443', `${name}が既定起動で443を公開する`);
      }
    }
  });

  it('運用手順に再索引・世代削除・metrics・Caddy・増設の手順がある', async () => {
    const docsDir = path.join(REPO_ROOT, 'docs');
    const docFiles = (await readdir(docsDir)).filter((file) => file.endsWith('.md')).map((file) => path.join(docsDir, file));
    const files = [path.join(REPO_ROOT, 'deployment', 'README.md'), ...docFiles];
    const text = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
    for (const term of ['worker:reindex', 'worker:generation-delete', 'worker:metrics', 'Caddy', '増設', '--force-recreate', 'forward-only']) {
      assert.ok(text.includes(term), `運用・性能手順に${term}がない`);
    }
  });
});
