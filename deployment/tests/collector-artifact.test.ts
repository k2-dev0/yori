import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 配布用collector artifactの契約。Node >= 24だけで、repositoryやnode_modulesを持たない端末から実行できる
// 単一fileと、version・checksumを検証できるmanifestをbuildが生成する。hosting方式とnpm公開は対象外。
// Redは生成物のself-contained実行とmanifest/checksum一致までに限定する。

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACT_PATH = path.join(REPO_ROOT, 'dist', 'collector', 'yori-collector.mjs');
const MANIFEST_PATH = path.join(REPO_ROOT, 'dist', 'collector', 'collector-manifest.json');

let buildStatus = 0;
let buildStderr = '';

before(() => {
  const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, encoding: 'utf8' });
  buildStatus = build.status ?? 1;
  buildStderr = build.stderr ?? '';
});

test('buildが単一file artifactとversion/checksum付きmanifestを生成する', () => {
  assert.equal(buildStatus, 0, `npm run build に失敗: ${buildStderr}`);
  assert.ok(existsSync(ARTIFACT_PATH), `単一file artifactがない: ${ARTIFACT_PATH}`);
  assert.ok(existsSync(MANIFEST_PATH), `artifact manifestがない: ${MANIFEST_PATH}`);

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    version?: unknown;
    file?: unknown;
    checksum?: unknown;
    git_sha?: unknown;
  };
  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src', 'collector', 'package.json'), 'utf8')) as { version?: string };
  assert.equal(typeof manifest.version, 'string', 'manifest.versionがない');
  assert.ok((manifest.version as string).length > 0, 'manifest.versionが空');
  assert.notEqual(manifest.version, '0.0.0', 'collector versionがyori本体のplaceholder versionを使っている');
  assert.equal(manifest.version, packageJson.version, 'manifest.versionがcollector package.jsonと一致しない');
  assert.equal(manifest.file, path.basename(ARTIFACT_PATH), 'manifest.fileがartifact名と一致しない');

  const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(git.status, 0, `Git SHAを取得できない: ${git.stderr}`);
  assert.match(String(manifest.git_sha), /^[0-9a-f]{40}$/, 'manifest.git_shaが40桁Git SHAでない');
  assert.equal(manifest.git_sha, git.stdout.trim(), 'manifest.git_shaがbuild対象HEADと一致しない');

  const checksum = createHash('sha256').update(readFileSync(ARTIFACT_PATH)).digest('hex');
  assert.equal(manifest.checksum, checksum, 'manifest.checksumがartifact内容と一致しない');

  const source = readFileSync(ARTIFACT_PATH, 'utf8');
  assert.ok(!source.includes(REPO_ROOT), 'artifactがrepository絶対pathへ依存している');
  assert.ok(!source.includes('node_modules'), 'artifactがnode_modules pathへ依存している');
  assert.ok(!/\bfrom\s*['"]\.\.?\//.test(source), 'artifactが相対importで他fileへ依存している');
});

test('repository外のtmp cwdからnodeでdiagnosticsを実行できる', () => {
  assert.equal(buildStatus, 0, `npm run build に失敗: ${buildStderr}`);
  assert.ok(existsSync(ARTIFACT_PATH), `単一file artifactがない: ${ARTIFACT_PATH}`);

  const workDir = mkdtempSync(path.join(tmpdir(), 'yori-artifact-'));
  try {
    const stateDir = path.join(workDir, 'state');
    const configPath = path.join(workDir, 'collector.json');
    writeFileSync(
      configPath,
      JSON.stringify({ api_url: 'https://api.example.test', token_env: 'YORI_ARTIFACT_TOKEN', state_dir: stateDir }),
      'utf8',
    );
    const emptyBinDir = path.join(workDir, 'bin');
    mkdirSync(emptyBinDir);

    const run = spawnSync(process.execPath, [ARTIFACT_PATH, 'diagnostics', '--config', configPath], {
      cwd: workDir,
      encoding: 'utf8',
      env: { PATH: emptyBinDir, HOME: workDir, YORI_ARTIFACT_TOKEN: 'artifact-token' },
    });

    assert.equal(run.status, 0, `artifact実行に失敗: ${run.status} ${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), [], 'diagnosticsがJSON配列を返していない');
    assert.equal(run.stderr, '', 'diagnosticsがstderrへ出力している');

    // 既存CLI契約の固定codeもartifactで維持する。不正なhook入力は本文を読まず非0で終わる。
    const invalidHook = spawnSync(process.execPath, [ARTIFACT_PATH, 'collect', '--source', 'codex', '--config', configPath], {
      cwd: workDir,
      encoding: 'utf8',
      env: { PATH: emptyBinDir, HOME: workDir, YORI_ARTIFACT_TOKEN: 'artifact-token' },
      input: '',
    });
    assert.equal(invalidHook.status, 1, `不正hook入力が非0で終わらない: ${invalidHook.status}`);
    assert.ok(invalidHook.stderr.includes('collector: invalid_hook_input'), `固定codeが出ていない: ${invalidHook.stderr}`);
    assert.equal(invalidHook.stdout, '', 'collectがstdoutへ出力している');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
