import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// collector CLIのlocal input YORI_KNOWN_SECRETS_JSONはstrict JSON string array。
// 未設定は空配列、設定済みの不正はfail-closedにし、成功時はparse後process.envから削除する。
// min/max/件数/重複はこのtestで固定する: 8〜4096 code points、最大100件、exact重複拒否。
// 未実装moduleは動的importで検出し、Red理由を「parse境界未実装」に固定する。

const ENV_KEY = 'YORI_KNOWN_SECRETS_JSON';
const KNOWN_SECRETS_MODULE_URL = new URL('../known-secrets.ts', import.meta.url).href;

interface KnownSecretsModule {
  parseKnownSecretsEnv?: (env: NodeJS.ProcessEnv) => string[];
}

async function loadParseKnownSecretsEnv(): Promise<(env: NodeJS.ProcessEnv) => string[]> {
  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = (await import(KNOWN_SECRETS_MODULE_URL)) as Record<string, unknown>;
  } catch (error) {
    assert.fail(
      `src/collector/known-secrets.ts のparseKnownSecretsEnv が未実装です: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parseKnownSecretsEnv = (moduleExports as KnownSecretsModule).parseKnownSecretsEnv;
  assert.equal(typeof parseKnownSecretsEnv, 'function', 'parseKnownSecretsEnv が未実装');
  return parseKnownSecretsEnv!;
}

function envWith(value: string): NodeJS.ProcessEnv {
  return { [ENV_KEY]: value };
}

describe('YORI_KNOWN_SECRETS_JSONのparse境界', () => {
  it('未設定は空配列を返し、envへkeyを追加しない', async () => {
    const parseKnownSecretsEnv = await loadParseKnownSecretsEnv();
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(parseKnownSecretsEnv(env), []);
    assert.equal(ENV_KEY in env, false, '未設定なのにenvへkeyを追加している');
  });

  it('strict JSON string arrayを順序どおり受理し、parse後envからkeyを削除する', async () => {
    const parseKnownSecretsEnv = await loadParseKnownSecretsEnv();
    const secrets = ['abcd1234', 'KnownSecret1234', 'あいうえおかきく'];
    const env = envWith(JSON.stringify(secrets));
    assert.deepEqual(parseKnownSecretsEnv(env), secrets);
    assert.equal(ENV_KEY in env, false, 'parse後もenvへ生値が残っている');

    const emptyEnv = envWith('[]');
    assert.deepEqual(parseKnownSecretsEnv(emptyEnv), []);
    assert.equal(ENV_KEY in emptyEnv, false, '空配列のparse後もenvへkeyが残っている');
  });

  it('8〜4096 code pointsの境界を受理し、7 code points以下と4097 code points以上を拒否する', async () => {
    const parseKnownSecretsEnv = await loadParseKnownSecretsEnv();
    assert.deepEqual(parseKnownSecretsEnv(envWith(JSON.stringify(['a'.repeat(8)]))), ['a'.repeat(8)]);
    assert.deepEqual(parseKnownSecretsEnv(envWith(JSON.stringify(['あ'.repeat(8)]))), ['あ'.repeat(8)]);
    assert.deepEqual(parseKnownSecretsEnv(envWith(JSON.stringify(['z'.repeat(4096)]))), ['z'.repeat(4096)]);
    for (const value of ['a'.repeat(7), 'あ'.repeat(7), 'z'.repeat(4097)]) {
      assert.throws(
        () => parseKnownSecretsEnv(envWith(JSON.stringify([value]))),
        `長さ${[...value].length}のknown secretを受理している`,
      );
    }
  });

  it('最大100件を受理し、101件とexact重複を拒否する', async () => {
    const parseKnownSecretsEnv = await loadParseKnownSecretsEnv();
    const hundred = Array.from({ length: 100 }, (_, index) => `secret-${String(index).padStart(3, '0')}`);
    assert.deepEqual(parseKnownSecretsEnv(envWith(JSON.stringify(hundred))), hundred);
    assert.throws(() => parseKnownSecretsEnv(envWith(JSON.stringify([...hundred, 'secret-101']))), '101件を受理している');
    assert.throws(() => parseKnownSecretsEnv(envWith(JSON.stringify(['abcd1234', 'abcd1234']))), 'exact重複を受理している');
    assert.deepEqual(
      parseKnownSecretsEnv(envWith(JSON.stringify(['Abcd1234', 'abcd1234']))),
      ['Abcd1234', 'abcd1234'],
      'case-sensitive重複を誤って拒否している',
    );
  });

  it('不正JSON・非array・非string要素をfail-closedで拒否する', async () => {
    const parseKnownSecretsEnv = await loadParseKnownSecretsEnv();
    for (const value of [
      'not json',
      '{',
      '"single"',
      '{"a":"b"}',
      '[1, 2]',
      '[null]',
      '[["nested"]]',
      '["abcd1234", 1]',
      '[{"value":"abcd1234"}]',
    ]) {
      assert.throws(() => parseKnownSecretsEnv(envWith(value)), `不正なYORI_KNOWN_SECRETS_JSONを受理している: ${value}`);
    }
  });
});
