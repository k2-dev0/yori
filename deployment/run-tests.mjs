#!/usr/bin/env node
// M1のテストを一括実行する。
// src配下はDB非公開のままNode container (compose test service) で、deploymentはホストからdockerを操作して実行する。
// dockerは標準のcontext/configを使い、このマシン固有のsocket・config・symlinkは指定しない。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'deployment', 'compose.yaml');
// 開発用compose (project yori / volume yori-*) と開発データを共有しないテスト専用のproject・volume。
const TEST_PROJECT_NAME = process.env.YORI_TEST_PROJECT ?? 'yori-test';
const TEST_ENV = {
  ...process.env,
  YORI_PGDATA_VOLUME: process.env.YORI_TEST_PGDATA_VOLUME ?? 'yori-test-pgdata',
  YORI_NODE_MODULES_VOLUME: process.env.YORI_TEST_NODE_MODULES_VOLUME ?? 'yori-test-node-modules',
  YORI_NPM_CACHE_VOLUME: process.env.YORI_TEST_NPM_CACHE_VOLUME ?? 'yori-test-npm-cache',
};

function run(command, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', env });
    child.on('error', (error) => {
      console.error(`[test] 起動失敗: ${command} ${args.join(' ')}: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const compose = (...args) => run('docker', ['compose', '-p', TEST_PROJECT_NAME, '--file', COMPOSE_FILE, ...args], TEST_ENV);

const steps = [];
steps.push(['compose up -d --wait db', await compose('up', '-d', '--wait', 'db')]);
steps.push(['compose run --rm test (src tests)', await compose('run', '--rm', 'test')]);
steps.push([
  'deployment tests (host)',
  await run(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'deployment/**/*.test.ts'], TEST_ENV),
]);

// 失敗時もcleanupを実行し、down自体の失敗もexit codeへ反映する。
const teardown = await compose('down', '--remove-orphans');
if (teardown !== 0) {
  console.error(
    `[test] compose down に失敗しました。docker compose -p ${TEST_PROJECT_NAME} -f deployment/compose.yaml down --remove-orphans を実行してください。`,
  );
}
steps.push(['compose down --remove-orphans', teardown]);

console.log('---- test summary ----');
for (const [name, code] of steps) {
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${name}`);
}
const failedCount = steps.filter(([, code]) => code !== 0).length;
if (failedCount > 0) {
  console.error(`${failedCount} ステップが失敗しました`);
  process.exit(1);
}
console.log('全ステップ成功');
