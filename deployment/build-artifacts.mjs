#!/usr/bin/env node
// 配布用single-file artifact（collectorとMCP）と各manifest（version/Git SHA/checksum）を生成する。
// esbuildはdevDependencyとして直接固定し、transitive依存へ暗黙依存しない。
// Node >= 24のnode:ビルトインだけをexternalにし、zod・MCP SDK等は1ファイルへbundleする。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
// 配布物の一覧。versionとGit SHAは下で1回だけ解決し、全対象のmanifestへ同じ値を書く。
const ARTIFACTS = [
  { name: 'collector', entry: 'src/collector/cli.ts', file: 'yori-collector.mjs', manifest: 'collector-manifest.json' },
  { name: 'mcp', entry: 'src/mcp/server.ts', file: 'yori-mcp.mjs', manifest: 'mcp-manifest.json' },
];

// yori-cliは両manifestのversionを自身のversionと照合するため、出どころをこの1 fileに限定する。
const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src', 'collector', 'package.json'), 'utf8'));
const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' });
if (git.status !== 0 || !/^[0-9a-f]{40}$/.test(git.stdout.trim())) {
  throw new Error('artifact: Git SHAを解決できません');
}
const gitSha = git.stdout.trim();

async function buildArtifact(artifact) {
  const outDir = path.join(DIST_DIR, artifact.name);
  const artifactPath = path.join(outDir, artifact.file);
  await build({
    entryPoints: [path.join(REPO_ROOT, artifact.entry)],
    outfile: artifactPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // 配布物へsource path・法務コメントを残さず、repositoryやnode_modulesへの依存を持たせない。
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const manifest = {
    version,
    file: artifact.file,
    git_sha: gitSha,
    checksum: createHash('sha256').update(readFileSync(artifactPath)).digest('hex'),
  };
  writeFileSync(path.join(outDir, artifact.manifest), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`${artifact.name} artifact: ${path.relative(REPO_ROOT, artifactPath)} v${version}`);
}

for (const artifact of ARTIFACTS) {
  await buildArtifact(artifact);
}
