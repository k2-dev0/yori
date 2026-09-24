# voyage-4-lite tokenizer asset

- 出典: https://huggingface.co/voyageai/voyage-4-lite
- 固定revision: `0335ddf7698395712e3220733b4079006951cfef`（2026-01-08時点のmain）
- 取得file: `tokenizer.json`（sha256 `c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539`）、`tokenizer_config.json`（sha256 `58c4abbc36eeccd8b3c8453f262225e8f2803855c88790760b618f4cd9e43be9`）
- 取得方法: Hugging Face Hubの`resolve/<revision>`から取得し、実行時に会話本文を配信元へ送らない。
- ライセンス: Apache-2.0（Hugging Face model cardの表示による）。
- 実行library: `@huggingface/tokenizers`をexact `0.2.0`へ固定する（package.json）。
- 用途: VoyageEmbeddingProviderのtokenizer。世代の`tokenizer_version`へ`voyageai/voyage-4-lite@0335ddf7698395712e3220733b4079006951cfef+@huggingface/tokenizers@0.2.0`として記録する。
