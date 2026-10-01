import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JevCallError, validateJevResponse } from '../jev.js';

// Jevは確率を小数2桁へ丸めて返す。丸めた値の合計は選択肢の数に比例して1からずれるため、
// 丸めで説明できる範囲は受理し、それを超えるずれだけを契約不正にする。

function criteria(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`choice-${index + 1}`, `選択肢${index + 1}`]));
}

function response(probabilities: readonly number[], confidence: number): unknown {
  const entries = probabilities.map((value, index) => [`choice-${index + 1}`, value]);
  return {
    model: 'jev-test',
    answers: { 'q#0': { type: 'choice', choice: 'choice-1', probabilities: Object.fromEntries(entries), confidence } },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function validate(probabilities: readonly number[], confidence = 0.8): unknown {
  return validateJevResponse(response(probabilities, confidence), {
    'q#0': { type: 'choice', instructions: '検証用の質問', criteria: criteria(probabilities.length) },
  });
}

function detailOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof JevCallError, `JevCallErrorでない: ${String(error)}`);
    assert.equal(error.code, 'provider_contract_invalid');
    return error.detail;
  }
  return assert.fail('契約不正にならなかった');
}

describe('Jev応答の確率合計とconfidenceの検証', () => {
  it('小数2桁へ丸めた確率の合計が、丸めで説明できる範囲なら受理する', () => {
    // 本番で実際に返った7択の応答。合計は0.99で、浮動小数点では1との差が0.01をわずかに超える。
    assert.doesNotThrow(() => validate([0.03, 0, 0, 0, 0.01, 0.28, 0.67]));
    // 8択では各値の丸めが最大0.005ずつ、合計で最大0.04ずれる。
    assert.doesNotThrow(() => validate([0.11, 0.13, 0.02, 0.02, 0.05, 0.11, 0.53, 0]));
    assert.doesNotThrow(() => validate([0.2, 0.2, 0.2, 0.2, 0.1, 0.05, 0.05, 0.04]));
  });

  it('丸めで説明できない合計のずれは、probability_sumの契約不正にする', () => {
    assert.equal(detailOf(() => validate([0.5, 0.4])), 'probability_sum');
    assert.equal(detailOf(() => validate([0.11, 0.13, 0.02, 0.02, 0.05, 0.11, 0.5, 0])), 'probability_sum');
  });

  it('confidenceの範囲外は、confidence_rangeの契約不正にする', () => {
    assert.equal(detailOf(() => validate([0.6, 0.4], 1.2)), 'confidence_range');
    assert.equal(detailOf(() => validate([0.6, 0.4], -0.1)), 'confidence_range');
  });
});
