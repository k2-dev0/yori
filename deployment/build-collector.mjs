#!/usr/bin/env node
// 配布用single-file collector artifactとmanifest（version/checksum）を生成する。
// esbuildはdevDependencyとして直接固定し、transitive依存へ暗黙依存しない。
// Node >= 24のnode:ビルトインだけをexternalにし、zod・uuid等は1ファイルへbundleする。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'dist', 'collector');
const ARTIFACT_NAME = 'yori-collector.mjs';
const ARTIFACT_PATH = path.join(OUT_DIR, ARTIFACT_NAME);
const MANIFEST_PATH = path.join(OUT_DIR, 'collector-manifest.json');

await build({
  entryPoints: [path.join(REPO_ROOT, 'src', 'collector', 'cli.ts')],
  outfile: ARTIFACT_PATH,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // 配布物へsource path・法務コメントを残さず、repositoryやnode_modulesへの依存を持たせない。
  minify: true,
  legalComments: 'none',
  logLevel: 'silent',
});

const bytes = readFileSync(ARTIFACT_PATH);
const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const manifest = {
  version,
  file: ARTIFACT_NAME,
  checksum: createHash('sha256').update(bytes).digest('hex'),
};
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`collector artifact: ${path.relative(REPO_ROOT, ARTIFACT_PATH)} v${version}`);
