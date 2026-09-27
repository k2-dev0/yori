import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateOpenApiJson } from './openapi.js';

// openapi.jsonの生成CLI。--checkでは書き換えず、追跡済み成果物とのbyte driftだけを検出する。

const OUTPUT_PATH = fileURLToPath(new URL('../../openapi.json', import.meta.url));
const checkOnly = process.argv.includes('--check');
const generated = generateOpenApiJson();

if (checkOnly) {
  let committed: string;
  try {
    committed = readFileSync(OUTPUT_PATH, 'utf8');
  } catch {
    console.error('openapi.json がありません。npm run api:contract で生成してください');
    process.exit(1);
  }
  if (committed !== generated) {
    console.error('openapi.json が生成結果と一致しません。npm run api:contract で再生成してください');
    process.exit(1);
  }
  console.log('openapi.json は生成結果と一致しています');
} else {
  writeFileSync(OUTPUT_PATH, generated, 'utf8');
  console.log('openapi.json を生成しました');
}
