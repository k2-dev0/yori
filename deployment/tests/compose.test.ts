import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './docker.js';

// 通常composeが使う開発用volume名。テスト用projectから参照・共有されてはならない。
const DEV_VOLUMES = ['yori-pgdata', 'yori-node-modules', 'yori-npm-cache'];

// 本番composeの設定を満たす合成env。passwordは合成の固定64桁hexで、実秘密・実domainは使わない。
const PRODUCTION_ENV = {
  YORI_POSTGRES_USER: 'yori',
  YORI_POSTGRES_PASSWORD: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  YORI_POSTGRES_DB: 'yori',
  YORI_DOMAIN: 'example.invalid',
  JEV_API_KEY: 'jev-test-key',
  JEV_ACCOUNT_REF: 'jev-test-account',
  JEV_API_URL: 'https://api.typesafe.ai/v1/systemone',
  VOYAGE_API_KEY: 'voyage-test-key',
  VOYAGE_ACCOUNT_REF: 'voyage-test-account',
  VOYAGE_API_URL: 'https://api.voyageai.com/v1/embeddings',
};

// 本番必須の秘密値。production composeではrequired interpolationとして扱い、configのエラー出力へ値を出さない。
const PRODUCTION_SECRET_KEYS: (keyof typeof PRODUCTION_ENV)[] = [
  'YORI_POSTGRES_PASSWORD',
  'JEV_API_KEY',
  'VOYAGE_API_KEY',
];

// 本番設定検査script。Composeだけではpasswordの文字種を検証できないため、契約をこのpathで固定する。
const PRODUCTION_CONFIG_CHECK = path.join(REPO_ROOT, 'deployment', 'check-production-config.mjs');

// compose configの解決に影響する変数。ホストの値ではなく常にテスト指定のenvで隔離して実行する。
const CONFIG_ENV_KEYS = [
  'COMPOSE_FILE',
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_PROFILES',
  'YORI_POSTGRES_USER',
  'YORI_POSTGRES_PASSWORD',
  'YORI_POSTGRES_DB',
  'YORI_DOMAIN',
  'JEV_API_KEY',
  'JEV_ACCOUNT_REF',
  'JEV_API_URL',
  'VOYAGE_API_KEY',
  'VOYAGE_ACCOUNT_REF',
  'VOYAGE_API_URL',
  'YORI_API_PORT',
  'YORI_PGDATA_VOLUME',
  'YORI_NODE_MODULES_VOLUME',
  'YORI_NPM_CACHE_VOLUME',
  'YORI_TEST_PGDATA_VOLUME',
  'YORI_TEST_NODE_MODULES_VOLUME',
  'YORI_TEST_NPM_CACHE_VOLUME',
];

// 設計書の.env.exampleに記載された値だけを許容する。
const EXAMPLE_ENV: Record<string, string> = {
  YORI_POSTGRES_USER: 'yori',
  YORI_POSTGRES_PASSWORD: '<64-hex-secret>',
  YORI_POSTGRES_DB: 'yori',
  YORI_DOMAIN: 'example.invalid',
  JEV_API_KEY: '<secret>',
  JEV_ACCOUNT_REF: '<account-reference>',
  JEV_API_URL: 'https://api.typesafe.ai/v1/systemone',
  VOYAGE_API_KEY: '<secret>',
  VOYAGE_ACCOUNT_REF: '<account-reference>',
  VOYAGE_API_URL: 'https://api.voyageai.com/v1/embeddings',
};

interface ComposePort {
  host_ip?: string;
  published?: string;
  target?: number;
}

interface ComposeHealthcheck {
  test?: string[];
}

interface ComposeService {
  image?: string;
  ports?: ComposePort[];
  network_mode?: string;
  environment?: Record<string, string | number | boolean | null>;
  healthcheck?: ComposeHealthcheck;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string }>;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

// 継承envから本番設定を除き、テスト指定の値だけを重ねる。
function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of CONFIG_ENV_KEYS) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env });
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
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// compose configはdaemon不要で、テスト用project/volumeの環境変数に左右されないenvで実行する。
function composeConfigCommand(args: string[], overrides: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  return run('docker', ['compose', ...args, 'config', '--format', 'json'], cleanEnv(overrides));
}

async function composeConfig(args: string[], overrides: NodeJS.ProcessEnv = {}): Promise<ComposeConfig> {
  const result = await composeConfigCommand(args, overrides);
  if (result.code !== 0) {
    throw new Error(`docker compose configが失敗しました (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as ComposeConfig;
}

function volumeNames(config: ComposeConfig): string[] {
  return Object.values(config.volumes ?? {}).map((volume) => volume.name ?? '');
}

// 設定検査scriptを本番envと同じ環境変数契約で起動する。scriptが無い間は全ケースを契約違反として失敗させる。
function runProductionConfigCheck(overrides: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  assert.ok(existsSync(PRODUCTION_CONFIG_CHECK), `本番設定検査scriptが無い: ${PRODUCTION_CONFIG_CHECK}`);
  return run(process.execPath, [PRODUCTION_CONFIG_CHECK], cleanEnv(overrides));
}

function parseEnvExample(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    assert.ok(match, `.env.exampleの行がKEY=VALUE形式でない: ${line}`);
    entries.set(match[1], match[2]);
  }
  return entries;
}

function commandOutput(result: CommandResult): string {
  return `${result.stdout}${result.stderr}`;
}

describe('deploymentのテスト構成分離', () => {
  it('通常composeはtest serviceを持たず、開発用volume名を維持する', async () => {
    const defaultConfig = await composeConfig(['-f', 'deployment/compose.yaml'], PRODUCTION_ENV);
    assert.equal(
      Object.hasOwn(defaultConfig.services, 'test'),
      false,
      `通常composeのデフォルト起動にtest serviceが含まれる: ${Object.keys(defaultConfig.services).join(', ')}`,
    );
    assert.ok(
      Object.keys(defaultConfig.services).every((name) => ['api', 'db', 'migrate', 'worker'].includes(name)),
      `通常composeに想定外のserviceがある: ${Object.keys(defaultConfig.services).join(', ')}`,
    );
    assert.ok(
      Object.hasOwn(defaultConfig.services, 'worker'),
      `通常composeにworker serviceがない: ${Object.keys(defaultConfig.services).join(', ')}`,
    );
    assert.deepEqual(volumeNames(defaultConfig).sort(), [...DEV_VOLUMES].sort(), '通常composeの開発用volume名が変わっている');

    // profileで隠したtest serviceも残存として検出する。
    const allProfiles = await composeConfig(['--profile', '*', '-f', 'deployment/compose.yaml'], PRODUCTION_ENV);
    assert.equal(
      Object.hasOwn(allProfiles.services, 'test'),
      false,
      `通常composeにtest serviceが残っている: ${Object.keys(allProfiles.services).join(', ')}`,
    );
  });

  it('テスト専用composeはprojectごとに隔離したvolumeを使い、開発DBを公開しない', async () => {
    const testCompose = path.join(REPO_ROOT, 'deployment', 'compose.test.yaml');
    assert.ok(existsSync(testCompose), 'deployment/compose.test.yaml が未作成');

    // 本番secret (YORI_POSTGRES_*/JEV_*/VOYAGE_*) をenvから除いてもconfigできる = 本番secretを要求しない。
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

describe('production composeのDB資格情報', () => {
  it('dbのPOSTGRES_*とapi・worker・migrateのDATABASE_URLが同じYORI_POSTGRES_*を使う', async () => {
    const config = await composeConfig(['--profile', 'tools', '-f', 'deployment/compose.yaml'], PRODUCTION_ENV);
    const dbEnvironment = config.services.db?.environment ?? {};
    assert.equal(
      dbEnvironment.POSTGRES_USER,
      PRODUCTION_ENV.YORI_POSTGRES_USER,
      `dbのPOSTGRES_USERがYORI_POSTGRES_USERと違う: ${String(dbEnvironment.POSTGRES_USER)}`,
    );
    assert.equal(
      dbEnvironment.POSTGRES_PASSWORD,
      PRODUCTION_ENV.YORI_POSTGRES_PASSWORD,
      'dbのPOSTGRES_PASSWORDがYORI_POSTGRES_PASSWORDと違う',
    );
    assert.equal(
      dbEnvironment.POSTGRES_DB,
      PRODUCTION_ENV.YORI_POSTGRES_DB,
      `dbのPOSTGRES_DBがYORI_POSTGRES_DBと違う: ${String(dbEnvironment.POSTGRES_DB)}`,
    );

    const expectedUrl = `postgres://${PRODUCTION_ENV.YORI_POSTGRES_USER}:${PRODUCTION_ENV.YORI_POSTGRES_PASSWORD}@db:5432/${PRODUCTION_ENV.YORI_POSTGRES_DB}`;
    for (const service of ['api', 'worker', 'migrate']) {
      assert.equal(
        config.services[service]?.environment?.DATABASE_URL,
        expectedUrl,
        `${service}のDATABASE_URLがdbと同じYORI_POSTGRES_*を使っていない: ${String(config.services[service]?.environment?.DATABASE_URL)}`,
      );
    }

    assert.equal(JSON.stringify(config).includes('yori:yori'), false, 'production composeに固定資格情報yori:yoriが残っている');
  });

  it('db healthcheckはcontainer内のPOSTGRES_USER/POSTGRES_DBを参照する', async () => {
    const config = await composeConfig(['--profile', 'tools', '-f', 'deployment/compose.yaml'], PRODUCTION_ENV);
    const healthcheckTest = config.services.db?.healthcheck?.test;
    assert.ok(healthcheckTest && healthcheckTest.length > 0, 'dbのhealthcheck testがない');
    const command = healthcheckTest.join(' ').replaceAll('$$', '$');
    assert.match(command, /pg_isready/, `healthcheckがpg_isreadyでない: ${command}`);
    assert.match(command, /\$POSTGRES_USER(?![A-Z0-9_])/, `healthcheckがcontainer内のPOSTGRES_USERを参照していない: ${command}`);
    assert.match(command, /\$POSTGRES_DB(?![A-Z0-9_])/, `healthcheckがcontainer内のPOSTGRES_DBを参照していない: ${command}`);
    assert.equal(command.includes('yori'), false, `healthcheckに固定のyoriが残っている: ${command}`);
  });
});

describe('production composeの必須設定', () => {
  const PRODUCTION_CONFIG_ARGS = ['--profile', 'tools', '-f', 'deployment/compose.yaml'];

  it('YORI_POSTGRES_USER/DB/PASSWORDが未設定ならconfigが失敗する', async () => {
    const missingPostgres: NodeJS.ProcessEnv = { ...PRODUCTION_ENV };
    delete missingPostgres.YORI_POSTGRES_USER;
    delete missingPostgres.YORI_POSTGRES_PASSWORD;
    delete missingPostgres.YORI_POSTGRES_DB;
    const result = await composeConfigCommand(PRODUCTION_CONFIG_ARGS, missingPostgres);
    assert.notEqual(result.code, 0, 'YORI_POSTGRES_*未設定でもproduction composeのconfigが成功した');
    assert.match(result.stderr, /YORI_POSTGRES_/, `必須envの不足がYORI_POSTGRES_*として報告されていない: ${result.stderr.trim()}`);
  });

  it('YORI_POSTGRES_PASSWORDだけが未設定・空の場合もconfigが失敗する', async () => {
    const missing: NodeJS.ProcessEnv = { ...PRODUCTION_ENV };
    delete missing.YORI_POSTGRES_PASSWORD;
    const missingResult = await composeConfigCommand(PRODUCTION_CONFIG_ARGS, missing);
    assert.notEqual(missingResult.code, 0, 'YORI_POSTGRES_PASSWORD未設定でもconfigが成功した');
    assert.match(missingResult.stderr, /YORI_POSTGRES_PASSWORD/, `password不足が報告されていない: ${missingResult.stderr.trim()}`);

    const empty = await composeConfigCommand(PRODUCTION_CONFIG_ARGS, { ...PRODUCTION_ENV, YORI_POSTGRES_PASSWORD: '' });
    assert.notEqual(empty.code, 0, 'YORI_POSTGRES_PASSWORDが空でもconfigが成功した');
    assert.match(empty.stderr, /YORI_POSTGRES_PASSWORD/, `password空が報告されていない: ${empty.stderr.trim()}`);
  });

  it('secretの未設定・空はrequired interpolationでconfigが失敗し、値をエラー出力へ漏らさない', async () => {
    for (const key of PRODUCTION_SECRET_KEYS) {
      for (const [label, value] of [['未設定', undefined], ['空', '']] as const) {
        const env: NodeJS.ProcessEnv = { ...PRODUCTION_ENV };
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }

        const result = await composeConfigCommand(PRODUCTION_CONFIG_ARGS, env);
        assert.notEqual(result.code, 0, `${key}の${label}でもproduction composeのconfigが成功した`);
        assert.match(
          result.stderr,
          new RegExp(key),
          `${key}の${label}がrequired interpolationとして報告されていない: ${result.stderr.trim()}`,
        );

        const output = commandOutput(result);
        for (const secretKey of PRODUCTION_SECRET_KEYS) {
          assert.equal(
            output.includes(PRODUCTION_ENV[secretKey]),
            false,
            `${key}の${label}時のconfig出力に${secretKey}の値が漏れている`,
          );
        }
      }
    }
  });
});

describe('production設定検査script (deployment/check-production-config.mjs)', () => {
  it('合成した有効な本番envを受理し、password値を出力しない', async () => {
    const result = await runProductionConfigCheck(PRODUCTION_ENV);
    assert.equal(result.code, 0, `有効な本番envが拒否された (exit ${result.code}): ${result.stderr.trim()}`);
    assert.equal(
      commandOutput(result).includes(PRODUCTION_ENV.YORI_POSTGRES_PASSWORD),
      false,
      '設定検査の出力にYORI_POSTGRES_PASSWORDの値が漏れている',
    );
  });

  it('passwordの未設定・空・短い値・小文字64桁hex以外を拒否する', async () => {
    const invalidPasswords: [string, string | undefined][] = [
      ['未設定', undefined],
      ['空', ''],
      ['短い(16桁)', '0123456789abcdef'],
      ['長い(65桁)', '0'.repeat(65)],
      ['大文字hex', '0123456789ABCDEF'.repeat(4)],
      ['hex以外', `${'0'.repeat(63)}g`],
    ];
    for (const [label, password] of invalidPasswords) {
      const env: NodeJS.ProcessEnv = { ...PRODUCTION_ENV };
      if (password === undefined) {
        delete env.YORI_POSTGRES_PASSWORD;
      } else {
        env.YORI_POSTGRES_PASSWORD = password;
      }
      const result = await runProductionConfigCheck(env);
      assert.notEqual(result.code, 0, `passwordの${label}が拒否されなかった: ${commandOutput(result).trim()}`);
      if (password !== undefined && password !== '') {
        assert.equal(commandOutput(result).includes(password), false, `passwordの${label}が検査出力へ漏れている`);
      }
    }
  });

  it('passwordのURL予約文字を拒否する', async () => {
    for (const reserved of ['@', '/', ':', '#', '?', '%', '+', '=']) {
      const password = `${'0'.repeat(63)}${reserved}`;
      const result = await runProductionConfigCheck({ ...PRODUCTION_ENV, YORI_POSTGRES_PASSWORD: password });
      assert.notEqual(result.code, 0, `passwordのURL予約文字${reserved}が拒否されなかった`);
      assert.equal(commandOutput(result).includes(password), false, `URL予約文字${reserved}の検査でpasswordが出力へ漏れている`);
    }
  });

  it('YORI_POSTGRES_USER/DBが未設定なら拒否する', async () => {
    for (const key of ['YORI_POSTGRES_USER', 'YORI_POSTGRES_DB']) {
      const env: NodeJS.ProcessEnv = { ...PRODUCTION_ENV };
      delete env[key];
      const result = await runProductionConfigCheck(env);
      assert.notEqual(result.code, 0, `${key}未設定が拒否されなかった`);
    }
  });

  it('PRODUCTION_ENVの全10キーを1つずつ未設定または空にすると拒否する', async () => {
    assert.deepEqual(
      Object.keys(PRODUCTION_ENV).sort(),
      [
        'JEV_ACCOUNT_REF',
        'JEV_API_KEY',
        'JEV_API_URL',
        'VOYAGE_ACCOUNT_REF',
        'VOYAGE_API_KEY',
        'VOYAGE_API_URL',
        'YORI_DOMAIN',
        'YORI_POSTGRES_DB',
        'YORI_POSTGRES_PASSWORD',
        'YORI_POSTGRES_USER',
      ],
      'PRODUCTION_ENVの必須キーが設計書の10キーと違う',
    );

    for (const key of Object.keys(PRODUCTION_ENV)) {
      const missing: NodeJS.ProcessEnv = { ...PRODUCTION_ENV };
      delete missing[key];
      const missingResult = await runProductionConfigCheck(missing);
      assert.notEqual(
        missingResult.code,
        0,
        `${key}が未設定でも本番設定検査が成功した: ${commandOutput(missingResult).trim()}`,
      );

      const empty = await runProductionConfigCheck({ ...PRODUCTION_ENV, [key]: '' });
      assert.notEqual(empty.code, 0, `${key}が空でも本番設定検査が成功した: ${commandOutput(empty).trim()}`);
    }
  });
});

describe('本番envのGit除外と.env.example', () => {
  it('.gitignoreは.env・.env.*・*.envを除外し、.env.exampleだけを再包含する', async () => {
    const gitignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\s*!\s*\.env\.example\s*$/m, '.gitignoreに.env.exampleの再包含指定がない');

    for (const target of ['.env', '.env.production', 'deployment/.env.local', 'production.env', 'config/production.env']) {
      const result = await run('git', ['check-ignore', '-q', '--', target], cleanEnv());
      assert.equal(result.code, 0, `${target}がGitで無視されていない: ${result.stderr.trim()}`);
    }

    const example = await run('git', ['check-ignore', '-q', '--', '.env.example'], cleanEnv());
    assert.equal(example.code, 1, `.env.exampleがGitで無視されている: ${example.stdout.trim()}${example.stderr.trim()}`);
  });

  it('.env.exampleは設計書記載のplaceholderだけを持ち、実秘密らしい値を含まない', () => {
    const examplePath = path.join(REPO_ROOT, '.env.example');
    assert.ok(existsSync(examplePath), '.env.exampleが未作成');
    const entries = parseEnvExample(readFileSync(examplePath, 'utf8'));
    assert.deepEqual(
      [...entries.keys()].sort(),
      Object.keys(EXAMPLE_ENV).sort(),
      `.env.exampleのキーが設計書と違う: ${[...entries.keys()].join(', ')}`,
    );
    for (const [key, expected] of Object.entries(EXAMPLE_ENV)) {
      assert.equal(entries.get(key), expected, `${key}の値が設計書のplaceholderと違う: ${entries.get(key) ?? ''}`);
    }
    for (const key of ['YORI_POSTGRES_PASSWORD', 'JEV_API_KEY', 'JEV_ACCOUNT_REF', 'VOYAGE_API_KEY', 'VOYAGE_ACCOUNT_REF']) {
      assert.match(entries.get(key) ?? '', /^<[^>]+>$/, `${key}がplaceholderでない`);
    }
    for (const [key, value] of entries) {
      assert.equal(/^[0-9a-f]{32,}$/i.test(value), false, `${key}に実秘密らしいhex値がある`);
      assert.equal(/^(sk-|eyJ|AKIA|xox[baprs]-)/.test(value), false, `${key}に実API keyらしい値がある`);
    }
  });
});
