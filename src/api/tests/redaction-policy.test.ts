import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as redactionModule from '../redaction.js';
import { redactConversationText } from '../redaction.js';

// 会社単位のcustom伏せ字policy。APIとcollectorが同じ純粋関数でbuilt-inとcustomを併用する。
// 未実装exportはundefinedのままassertで失敗させ、Red理由を「policy関数未実装」に固定する。
// 上限値は本testで固定する: custom literalは4096コードポイント、会社ごとに100件。

interface PolicyRedactionModule {
  redactConversationTextWithPolicy?: (text: string, policy: { version: number; rules: readonly string[] }) => string;
}

const policyFunction = (redactionModule as unknown as PolicyRedactionModule).redactConversationTextWithPolicy;

const MAX_LITERAL_CODE_POINTS = 4096;
const MAX_CUSTOM_RULES = 100;

function applyPolicy(text: string, rules: readonly string[]): string {
  assert.equal(typeof policyFunction, 'function', 'redactConversationTextWithPolicy が未実装');
  return policyFunction!(text, { version: 1, rules });
}

describe('custom伏せ字policyの純粋関数', () => {
  it('置換済みbuilt-in/custom placeholderを再適用してもbyte一致を維持する', () => {
    const placeholders =
      '[REDACTED:custom] と [REDACTED:aws_access_key] と [REDACTED:env_value] と [REDACTED:authorization] と [REDACTED:private_key]';
    const rules = ['AcmeSecret'];
    assert.equal(applyPolicy(placeholders, rules), placeholders, 'placeholder自体を置換している');

    const once = applyPolicy(`AcmeSecret と ${placeholders}`, rules);
    assert.equal(applyPolicy(once, rules), once, 'placeholderを含む置換済み本文が再適用で変化している');
    assert.equal(applyPolicy(applyPolicy(once, rules), rules), once, '2回目以降の再適用で変化している');

    const builtIn = applyPolicy('PASSWORD=hunter2 と AKIAIOSFODNN7EXAMPLE', ['hunter2']);
    assert.equal(applyPolicy(builtIn, ['hunter2']), builtIn, 'built-in placeholderが再適用で壊れている');
  });

  it('exact literalだけをcase-sensitiveに置換し、regex特殊文字もliteralとして扱う', () => {
    assert.equal(applyPolicy('AcmeSecret と acmesecret', ['AcmeSecret']), '[REDACTED:custom] と acmesecret');
    assert.equal(applyPolicy('前AcmeSecret後', ['AcmeSecret']), '前[REDACTED:custom]後');
    assert.equal(applyPolicy('abc a.c', ['a.c']), 'abc [REDACTED:custom]', 'regexとして解釈されている');
    assert.equal(applyPolicy('対象なし', ['AcmeSecret']), '対象なし');
  });

  it('overlapping candidateはlongest-firstで決定的に解決し、rules順や再適用で結果を変えない', () => {
    const rules = ['secret', 'super-secret'];
    const once = applyPolicy('super-secret と secret', rules);
    assert.equal(once, '[REDACTED:custom] と [REDACTED:custom]');
    assert.equal(applyPolicy('aab', ['ab', 'aab']), '[REDACTED:custom]', '短いliteralを先に採用している');
    assert.equal(applyPolicy('super-secret と secret', [...rules].reverse()), once, 'rulesの並び順で結果が変わる');
    assert.equal(applyPolicy(once, rules), once, '再適用で結果が変わっている');
  });

  it('built-in置換を常に適用し、custom ruleは残りの本文へ併用する', () => {
    const text = 'PASSWORD=hunter2 と hunter2 と AcmeSecret と AKIAIOSFODNN7EXAMPLE';
    const expected =
      'PASSWORD=[REDACTED:env_value] と [REDACTED:custom] と [REDACTED:custom] と [REDACTED:aws_access_key]';
    assert.equal(applyPolicy(text, ['hunter2', 'AcmeSecret']), expected);
    assert.equal(applyPolicy('PASSWORD=hunter2', []), redactConversationText('PASSWORD=hunter2'), 'rule無しでbuilt-inが弱まっている');
  });

  it('空・placeholder・上限超過・重複・件数超過・非文字列のruleを拒否し、境界値は受理する', () => {
    assert.throws(() => applyPolicy('x', ['']), '空literalを拒否していない');
    assert.throws(() => applyPolicy('x', ['[REDACTED:custom]']), 'placeholderそのものを拒否していない');
    assert.throws(() => applyPolicy('x', ['x'.repeat(MAX_LITERAL_CODE_POINTS + 1)]), '上限超過literalを拒否していない');
    assert.throws(() => applyPolicy('x', ['dup', 'dup']), '重複literalを拒否していない');
    for (const fragment of ['REDACTED', 'custom', '[REDACTED', 'ED:custom]', 'env_value', 'authorization', ':']) {
      assert.throws(
        () => applyPolicy('x', [fragment]),
        `placeholderの部分文字列 ${fragment} を受理している`,
      );
    }
    assert.throws(() => applyPolicy('x', Array.from({ length: MAX_CUSTOM_RULES + 1 }, (_, index) => `rule-${index}`)), '件数超過を拒否していない');
    assert.throws(() => applyPolicy('x', ['ok', 42 as unknown as string]), '非文字列ruleを拒否していない');

    const boundaryLiteral = 'y'.repeat(MAX_LITERAL_CODE_POINTS);
    assert.equal(applyPolicy(boundaryLiteral, [boundaryLiteral]), '[REDACTED:custom]');
    const boundaryRules = Array.from({ length: MAX_CUSTOM_RULES }, (_, index) => `rule-${index}`);
    assert.equal(applyPolicy('rule-99', boundaryRules), '[REDACTED:custom]');
    const once = applyPolicy(boundaryLiteral, [boundaryLiteral]);
    assert.equal(applyPolicy(once, [boundaryLiteral]), once, '上限literalで再適用が安定しない');
  });
});
