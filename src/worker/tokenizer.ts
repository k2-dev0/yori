import { readFile } from 'node:fs/promises';
import { Tokenizer } from '@huggingface/tokenizers';

// Voyage公式docsが案内するvoyage-4-liteの公開tokenizerを固定revisionのローカル資産として使う。
// 会話本文はtokenizer取得先へ送らない。assetはrepo rootのassets/配下にあり、src実行とbuild後のdist実行の
// どちらからも同じ相対位置で解決できる（src/worker/... と dist/worker/... はどちらもrootから2階層）。
const TOKENIZER_DIR = new URL('../../assets/voyage-4-lite/', import.meta.url);

let loaded: Promise<Tokenizer> | undefined;

// tokenizer JSONのparseは重いため、process内で1回だけ読み込んで共有する。
export function loadVoyageTokenizer(): Promise<Tokenizer> {
  loaded ??= (async () => {
    const [tokenizerJson, tokenizerConfig] = await Promise.all([
      readFile(new URL('tokenizer.json', TOKENIZER_DIR), 'utf8'),
      readFile(new URL('tokenizer_config.json', TOKENIZER_DIR), 'utf8'),
    ]);
    return new Tokenizer(JSON.parse(tokenizerJson), JSON.parse(tokenizerConfig));
  })();
  return loaded;
}
