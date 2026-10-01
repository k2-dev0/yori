import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 配布用MCP artifactの契約。yori-cliのlauncherは引数なしの `node yori-mcp.mjs` をstdioで起動し、
// YORI_MCP_CONFIGが指す設定JSONの環境変数名から接続先とtokenを読む。社員端末にyoriのcheckoutは無いため、
// 生成物はnode_modulesを持たない場所で起動でき、bundle後も接続先制約とstdoutのprotocol専用性を保つ。

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACT_NAME = 'yori-mcp.mjs';
const ARTIFACT_PATH = path.join(REPO_ROOT, 'dist', 'mcp', ARTIFACT_NAME);
const MANIFEST_PATH = path.join(REPO_ROOT, 'dist', 'mcp', 'mcp-manifest.json');
const COLLECTOR_MANIFEST_PATH = path.join(REPO_ROOT, 'dist', 'collector', 'collector-manifest.json');

const API_URL_ENV = 'YORI_ARTIFACT_API_URL';
const API_TOKEN_ENV = 'YORI_ARTIFACT_API_TOKEN';
const TOKEN = 'artifact-mcp-token';
const LOOPBACK_API_URL = 'http://127.0.0.1:39120';
// RFC 5737の文書用address。接続せず、起動時の接続先検証だけで拒否されることを確認する。
const NON_LOOPBACK_HTTP_API_URL = 'http://192.0.2.10:39120';
const EXPECTED_TOOL_NAMES = ['get_evidence', 'get_search_result', 'link_session', 'record_case', 'search_history'];
const INITIALIZE_REQUEST_ID = 1;
const LIST_TOOLS_REQUEST_ID = 2;
const RESPONSE_TIMEOUT_MS = 8_000;
const CONFIG_ERROR_EXIT_CODE = 1;

let buildStatus = 0;
let buildStderr = '';

before(() => {
  const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, encoding: 'utf8' });
  buildStatus = build.status ?? 1;
  buildStderr = build.stderr ?? '';
});

interface WorkDir {
  dir: string;
  artifactPath: string;
  configPath: string;
  baseEnv: Record<string, string>;
}

// repositoryとnode_modulesを辿れない一時directoryへ生成物だけをcopyする。
function prepareWorkDir(): WorkDir {
  assert.equal(buildStatus, 0, `npm run build に失敗: ${buildStderr}`);
  assert.ok(existsSync(ARTIFACT_PATH), `MCP artifactがない: ${ARTIFACT_PATH}`);
  const dir = mkdtempSync(path.join(tmpdir(), 'yori-mcp-artifact-'));
  const artifactPath = path.join(dir, ARTIFACT_NAME);
  copyFileSync(ARTIFACT_PATH, artifactPath);
  const configPath = path.join(dir, 'yori-mcp.json');
  writeFileSync(configPath, JSON.stringify({ api_url_env: API_URL_ENV, api_token_env: API_TOKEN_ENV }), 'utf8');
  const emptyBinDir = path.join(dir, 'bin');
  mkdirSync(emptyBinDir);
  return { dir, artifactPath, configPath, baseEnv: { PATH: emptyBinDir, HOME: dir } };
}

interface StdioExchange {
  stdoutLines: string[];
  stderr: string;
  toolNames: string[];
}

// initializeとtools/listだけを送り、tools/listの応答までのstdout全行とstderrを返す。
function listToolsOverStdio(work: WorkDir, env: Record<string, string>): Promise<StdioExchange> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ARTIFACT_NAME], { cwd: work.dir, env });
    const stdoutLines: string[] = [];
    let stdoutBuffer = '';
    let stderr = '';
    const finish = (error: Error | null, toolNames: string[] = []): void => {
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) {
        reject(new Error(`${error.message} / stderr: ${stderr}`));
        return;
      }
      resolve({ stdoutLines, stderr, toolNames });
    };
    const timer = setTimeout(() => finish(new Error('tools/listの応答がtimeoutしました')), RESPONSE_TIMEOUT_MS);
    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(new Error(`MCP artifactが応答前に終了しました: code=${code ?? 'null'}`)));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');
        if (line.trim().length === 0) {
          continue;
        }
        stdoutLines.push(line);
        let message: { id?: unknown; result?: { tools?: Array<{ name?: unknown }> } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          // protocol以外の行は呼出側がstdoutLinesから検出する。
          continue;
        }
        if (message.id === INITIALIZE_REQUEST_ID) {
          send({ method: 'notifications/initialized', params: {} });
          send({ id: LIST_TOOLS_REQUEST_ID, method: 'tools/list', params: {} });
        } else if (message.id === LIST_TOOLS_REQUEST_ID) {
          finish(null, (message.result?.tools ?? []).map((tool) => String(tool.name)));
        }
      }
    });
    send({
      id: INITIALIZE_REQUEST_ID,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'yori-mcp-artifact-tests', version: '0.0.0' },
      },
    });
  });
}

test('buildがMCPの単一file artifactとcollectorと同じversionのmanifestを生成する', () => {
  assert.equal(buildStatus, 0, `npm run build に失敗: ${buildStderr}`);
  assert.ok(existsSync(ARTIFACT_PATH), `MCP artifactがない: ${ARTIFACT_PATH}`);
  assert.ok(existsSync(MANIFEST_PATH), `MCP manifestがない: ${MANIFEST_PATH}`);

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
  const collectorManifest = JSON.parse(readFileSync(COLLECTOR_MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest).sort(), ['checksum', 'file', 'git_sha', 'version'], 'manifestのfieldがcollectorと同じ形でない');
  assert.equal(typeof manifest.version, 'string', 'manifest.versionがない');
  assert.notEqual(manifest.version, '0.0.0', 'MCP versionがyori本体のplaceholder versionを使っている');
  assert.equal(manifest.version, collectorManifest.version, 'MCPとcollectorのmanifest.versionが一致しない');
  assert.equal(manifest.file, ARTIFACT_NAME, 'manifest.fileがartifact名と一致しない');

  const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(git.status, 0, `Git SHAを取得できない: ${git.stderr}`);
  assert.match(String(manifest.git_sha), /^[0-9a-f]{40}$/, 'manifest.git_shaが40桁Git SHAでない');
  assert.equal(manifest.git_sha, git.stdout.trim(), 'manifest.git_shaがbuild対象HEADと一致しない');
  assert.equal(manifest.git_sha, collectorManifest.git_sha, 'MCPとcollectorのmanifest.git_shaが一致しない');

  const checksum = createHash('sha256').update(readFileSync(ARTIFACT_PATH)).digest('hex');
  assert.equal(manifest.checksum, checksum, 'manifest.checksumがartifact内容と一致しない');

  const source = readFileSync(ARTIFACT_PATH, 'utf8');
  assert.ok(!source.includes(REPO_ROOT), 'artifactがrepository絶対pathへ依存している');
  assert.ok(!/\bfrom\s*['"]\.\.?\//.test(source), 'artifactが相対importで他fileへ依存している');
});

test('node_modulesの無い一時directoryで起動し、tools/listが5 toolだけをprotocol出力で返す', async () => {
  const work = prepareWorkDir();
  try {
    const exchange = await listToolsOverStdio(work, {
      ...work.baseEnv,
      YORI_MCP_CONFIG: work.configPath,
      [API_URL_ENV]: LOOPBACK_API_URL,
      [API_TOKEN_ENV]: TOKEN,
    });

    assert.deepEqual([...exchange.toolNames].sort(), EXPECTED_TOOL_NAMES, 'tools/listが5 toolを返していない');
    for (const line of exchange.stdoutLines) {
      const message = JSON.parse(line) as { jsonrpc?: unknown };
      assert.equal(message.jsonrpc, '2.0', `stdoutにprotocol以外の出力が混ざっている: ${line}`);
    }
    assert.ok(!exchange.stdoutLines.join('\n').includes(TOKEN), 'stdoutへtokenが出ている');
    assert.ok(!exchange.stderr.includes(TOKEN), 'stderrへtokenが出ている');
  } finally {
    rmSync(work.dir, { recursive: true, force: true });
  }
});

test('YORI_MCP_CONFIG未設定では起動を拒否し、stdoutへ何も出さない', () => {
  const work = prepareWorkDir();
  try {
    const run = spawnSync(process.execPath, [ARTIFACT_NAME], {
      cwd: work.dir,
      encoding: 'utf8',
      env: { ...work.baseEnv, [API_URL_ENV]: LOOPBACK_API_URL, [API_TOKEN_ENV]: TOKEN },
      input: '',
    });

    assert.equal(run.status, CONFIG_ERROR_EXIT_CODE, `設定なしで起動を拒否していない: ${run.status} ${run.stderr}`);
    assert.ok(run.stderr.includes('YORI_MCP_CONFIGが未設定です'), `拒否理由がstderrにない: ${run.stderr}`);
    assert.equal(run.stdout, '', '設定エラーがstdoutへ出ている');
    assert.ok(!run.stderr.includes(TOKEN), 'stderrへtokenが出ている');
  } finally {
    rmSync(work.dir, { recursive: true, force: true });
  }
});

test('非loopbackのHTTP接続先では起動を拒否し、tokenを出力しない', () => {
  const work = prepareWorkDir();
  try {
    const run = spawnSync(process.execPath, [ARTIFACT_NAME], {
      cwd: work.dir,
      encoding: 'utf8',
      env: {
        ...work.baseEnv,
        YORI_MCP_CONFIG: work.configPath,
        [API_URL_ENV]: NON_LOOPBACK_HTTP_API_URL,
        [API_TOKEN_ENV]: TOKEN,
      },
      input: '',
    });

    assert.equal(run.status, CONFIG_ERROR_EXIT_CODE, `非loopback HTTPで起動を拒否していない: ${run.status} ${run.stderr}`);
    assert.ok(
      run.stderr.includes('MCPの接続先はHTTPSまたはloopback HTTPだけを許可します'),
      `拒否理由がstderrにない: ${run.stderr}`,
    );
    assert.equal(run.stdout, '', '設定エラーがstdoutへ出ている');
    assert.ok(!run.stderr.includes(TOKEN), 'stderrへtokenが出ている');
  } finally {
    rmSync(work.dir, { recursive: true, force: true });
  }
});
