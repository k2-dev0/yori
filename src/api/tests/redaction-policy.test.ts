import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as redactionModule from '../redaction.js';
import { redactConversationText } from '../redaction.js';

// 会社単位のcustom伏せ字policy。ruleはliteral/assignment_keyのdiscriminated unionで、
// APIとcollectorが同じ純粋関数でbuilt-inとcustomを併用する。
// 未実装exportはundefinedのままassertで失敗させ、Red理由を「policy関数未実装」に固定する。
// 上限値は本testで固定する: literal 512 code points、assignment_key 128 code points、会社ごとに100件。

type CustomRedactionRule =
  | { type: 'literal'; value: string }
  | { type: 'assignment_key'; value: string };

interface PolicyRedactionModule {
  redactConversationTextWithPolicy?: (text: string, policy: { version: number; rules: readonly CustomRedactionRule[] }) => string;
}

const policyFunction = (redactionModule as unknown as PolicyRedactionModule).redactConversationTextWithPolicy;

const MAX_LITERAL_CODE_POINTS = 512;
const MAX_ASSIGNMENT_KEY_CODE_POINTS = 128;
const MAX_CUSTOM_RULES = 100;

function literal(value: string): CustomRedactionRule {
  return { type: 'literal', value };
}

function assignmentKey(value: string): CustomRedactionRule {
  return { type: 'assignment_key', value };
}

function applyPolicy(text: string, rules: readonly CustomRedactionRule[]): string {
  assert.equal(typeof policyFunction, 'function', 'redactConversationTextWithPolicy が未実装');
  return policyFunction!(text, { version: 1, rules });
}

describe('custom伏せ字policyの純粋関数', () => {
  it('literalはexact・case-sensitiveでregex特殊文字もliteralとして扱い、longest-firstで置換する', () => {
    assert.equal(applyPolicy('AcmeSecret と acmesecret', [literal('AcmeSecret')]), '[REDACTED:custom] と acmesecret');
    assert.equal(applyPolicy('前AcmeSecret後', [literal('AcmeSecret')]), '前[REDACTED:custom]後');
    assert.equal(applyPolicy('abc a.c', [literal('a.c')]), 'abc [REDACTED:custom]', 'regexとして解釈されている');
    assert.equal(applyPolicy('対象なし', [literal('AcmeSecret')]), '対象なし');

    const rules = [literal('secret'), literal('super-secret')];
    const once = applyPolicy('super-secret と secret', rules);
    assert.equal(once, '[REDACTED:custom] と [REDACTED:custom]');
    assert.equal(applyPolicy('aab', [literal('ab'), literal('aab')]), '[REDACTED:custom]', '短いliteralを先に採用している');
    assert.equal(applyPolicy('super-secret と secret', [...rules].reverse()), once, 'rulesの並び順で結果が変わる');
    assert.equal(applyPolicy(once, rules), once, '再適用で結果が変わっている');
  });

  it('置換済みbuilt-in/custom placeholderを再適用してもbyte一致を維持する', () => {
    const placeholders =
      '[REDACTED:custom] と [REDACTED:aws_access_key] と [REDACTED:env_value] と [REDACTED:authorization] と [REDACTED:private_key]';
    const rules = [literal('AcmeSecret')];
    assert.equal(applyPolicy(placeholders, rules), placeholders, 'placeholder自体を置換している');

    const once = applyPolicy(`AcmeSecret と ${placeholders}`, rules);
    assert.equal(applyPolicy(once, rules), once, 'placeholderを含む置換済み本文が再適用で変化している');
    assert.equal(applyPolicy(applyPolicy(once, rules), rules), once, '2回目以降の再適用で変化している');

    const builtIn = applyPolicy('PASSWORD=hunter2 と AKIAIOSFODNN7EXAMPLE', [literal('hunter2')]);
    assert.equal(applyPolicy(builtIn, [literal('hunter2')]), builtIn, 'built-in placeholderが再適用で壊れている');
  });

  it('assignment_keyはkeyの表記・空白・区切りを保持してvalueだけをplaceholderへ置換する', () => {
    const rules = [assignmentKey('pass')];
    assert.equal(applyPolicy('pass: hogehoge', rules), 'pass: [REDACTED:custom]');
    assert.equal(applyPolicy('PASS: hogehoge', rules), 'PASS: [REDACTED:custom]', 'case-insensitiveでない、またはkey表記が変わっている');
    assert.equal(applyPolicy('Pass = hogehoge', rules), 'Pass = [REDACTED:custom]', '空白・区切り・key表記を保持していない');
    assert.equal(applyPolicy('PASS=hogehoge', rules), 'PASS=[REDACTED:custom]', 'equals区切りの大文字keyへ反応していない');
    assert.equal(applyPolicy('pass : hogehoge', rules), 'pass : [REDACTED:custom]');
    assert.equal(applyPolicy('pass：hogehoge', rules), 'pass：[REDACTED:custom]', '全角colonを代入として扱っていない');
    assert.equal(applyPolicy('PASS：hogehoge', rules), 'PASS：[REDACTED:custom]', '大文字keyの全角colonへ反応していない');
    assert.equal(applyPolicy('pass ： hogehoge', rules), 'pass ： [REDACTED:custom]');
    assert.equal(applyPolicy('pass: "hoge hoge"', rules), 'pass: [REDACTED:custom]', 'quoted valueを置換していない');
    assert.equal(applyPolicy("pass: 'hoge hoge'", rules), 'pass: [REDACTED:custom]', 'single quoted valueを置換していない');
    assert.equal(applyPolicy('pass: a-b_c.1', rules), 'pass: [REDACTED:custom]');
    assert.equal(applyPolicy('pass: hoge\nnext', rules), 'pass: [REDACTED:custom]\nnext');
    const maxValue = 'v'.repeat(4096);
    assert.equal(applyPolicy(`pass: ${maxValue}`, rules), 'pass: [REDACTED:custom]', '上限4096のvalueを置換していない');
    assert.equal(applyPolicy(`pass: "${maxValue}"`, rules), 'pass: [REDACTED:custom]', '上限4096のquoted valueを置換していない');
  });

  it('assignment_keyはkeyだけ・空value・改行越境・比較・名前空間・別identifierを変更しない', () => {
    const rules = [assignmentKey('pass')];
    for (const unchanged of [
      'pass',
      'pass:',
      'pass:   ',
      'pass:\nhogehoge',
      'pass == hogehoge',
      'pass => hogehoge',
      'pass::hogehoge',
      'compass: hogehoge',
      'bypass=hogehoge',
      'passkey: hogehoge',
      'DB_PASS: hogehoge',
    ]) {
      assert.equal(applyPolicy(unchanged, rules), unchanged, `変更してはいけない入力: ${JSON.stringify(unchanged)}`);
    }
  });

  it('assignment_keyはenvironment variable参照とplaceholderを変更せず、再適用してもbyte一致する', () => {
    const rules = [assignmentKey('my_var'), literal('AcmeSecret')];
    for (const unchanged of [
      'my_var: $MY_VAR',
      'my_var: ${MY_VAR}',
      'my_var: [REDACTED:custom]',
      'my_var: [REDACTED:env_value]',
    ]) {
      assert.equal(applyPolicy(unchanged, rules), unchanged, `変更してはいけない入力: ${JSON.stringify(unchanged)}`);
    }

    const text = 'my_var: hogehoge と AcmeSecret と my_var: $MY_VAR';
    const once = applyPolicy(text, rules);
    assert.equal(once, 'my_var: [REDACTED:custom] と [REDACTED:custom] と my_var: $MY_VAR');
    assert.equal(applyPolicy(once, rules), once, '再適用でplaceholderやenv参照が変化している');
    assert.equal(applyPolicy(applyPolicy(once, rules), rules), once, '3回目の再適用で変化している');
  });

  it('custom assignment_keyはbuilt-in置換と併用し、literalはbuilt-in適用後の本文へ適用する', () => {
    const rules = [assignmentKey('my_var')];
    assert.equal(
      applyPolicy('pass: hogehoge と my_var: other', rules),
      'pass: [REDACTED:env_value] と my_var: [REDACTED:custom]',
      'custom assignment_keyとbuilt-in PASSの優先順位が確定契約と異なる',
    );
    const literalRules = [literal('hunter2'), literal('AcmeSecret')];
    assert.equal(
      applyPolicy('PASSWORD=hunter2 と hunter2 と AcmeSecret と AKIAIOSFODNN7EXAMPLE', literalRules),
      'PASSWORD=[REDACTED:env_value] と [REDACTED:custom] と [REDACTED:custom] と [REDACTED:aws_access_key]',
    );
    assert.equal(applyPolicy('PASSWORD=hunter2', []), redactConversationText('PASSWORD=hunter2'), 'rule無しでbuilt-inが弱まっている');
  });

  it('invalid ruleを拒否し、literal/assignment_keyの境界値とtype別の重複規則を受理する', () => {
    for (const invalid of [
      { type: 'regex', value: 'x' },
      { type: 'literal' },
      { value: 'x' },
      { type: 'literal', value: 'x', extra: true },
      { type: 'literal', value: 42 },
      { type: 'assignment_key', value: '' },
      'AcmeSecret',
      42,
      null,
    ]) {
      assert.throws(
        () => applyPolicy('x', [invalid as unknown as CustomRedactionRule]),
        `不正ruleを拒否していない: ${JSON.stringify(invalid)}`,
      );
    }

    assert.throws(() => applyPolicy('x', [literal('')]), '空literalを拒否していない');
    assert.throws(() => applyPolicy('x', [literal('[REDACTED:custom]')]), 'placeholderそのものを拒否していない');
    for (const fragment of ['REDACTED', 'custom', '[REDACTED', 'ED:custom]', 'env_value', 'authorization', ':']) {
      assert.throws(() => applyPolicy('x', [literal(fragment)]), `literalのplaceholder部分文字列 ${fragment} を受理している`);
    }
    assert.throws(() => applyPolicy('x', [literal('dup'), literal('dup')]), '重複literalを拒否していない');
    assert.throws(() => applyPolicy('x', [literal('x'.repeat(MAX_LITERAL_CODE_POINTS + 1))]), '上限超過literalを拒否していない');

    for (const invalidKey of ['1pass', '-pass', '.pass', 'pass key', 'pass:key', 'ぱす', 'pass!', 'REDACTED', 'redacted', 'Redacted']) {
      assert.throws(
        () => applyPolicy('x', [assignmentKey(invalidKey)]),
        `不正なassignment_keyを受理している: ${JSON.stringify(invalidKey)}`,
      );
    }
    assert.throws(
      () => applyPolicy('x', [assignmentKey('a'.repeat(MAX_ASSIGNMENT_KEY_CODE_POINTS + 1))]),
      '上限超過assignment_keyを拒否していない',
    );
    assert.throws(
      () => applyPolicy('x', [assignmentKey('pass'), assignmentKey('PASS')]),
      'assignment_keyの大文字小文字違い重複を拒否していない',
    );

    const maxLiteral = 'y'.repeat(MAX_LITERAL_CODE_POINTS);
    assert.equal(applyPolicy(maxLiteral, [literal(maxLiteral)]), '[REDACTED:custom]');
    const maxKey = 'a'.repeat(MAX_ASSIGNMENT_KEY_CODE_POINTS);
    assert.equal(
      applyPolicy(`${'A'.repeat(MAX_ASSIGNMENT_KEY_CODE_POINTS)}: v`, [assignmentKey(maxKey)]),
      `${'A'.repeat(MAX_ASSIGNMENT_KEY_CODE_POINTS)}: [REDACTED:custom]`,
      '128 code pointsのassignment_keyを照合していない',
    );
    const mixedCaseLiterals = [literal('Pass'), literal('pass')];
    assert.equal(applyPolicy('Pass pass', mixedCaseLiterals), '[REDACTED:custom] [REDACTED:custom]', 'literalのcase-sensitive重複を誤って拒否している');
    assert.doesNotThrow(() => applyPolicy('x', [literal('shared'), assignmentKey('shared')]), 'typeが異なる同名ruleを拒否している');
    const keyedRules = [assignmentKey('deploy.pass-1_2')];
    assert.equal(
      applyPolicy('DEPLOY.PASS-1_2: value', keyedRules),
      'DEPLOY.PASS-1_2: [REDACTED:custom]',
      '許容文字を含むassignment_keyを照合していない',
    );
    const underscoreKeyRules = [assignmentKey('_pass')];
    assert.equal(applyPolicy('_pass: value', underscoreKeyRules), '_pass: [REDACTED:custom]', '先頭underscoreのassignment_keyを照合していない');
  });

  it('literalとassignment_keyを合算したrule総数は100件まで、101件を拒否する', () => {
    const hundred = [...Array.from({ length: 99 }, (_, index) => literal(`rule-${index}`)), assignmentKey('pass')];
    assert.equal(applyPolicy('rule-0 と pass: hogehoge', hundred), '[REDACTED:custom] と pass: [REDACTED:custom]');
    assert.throws(() => applyPolicy('x', [...hundred, literal('extra')]), '101件目を拒否していない');

    const fiftyFifty = [
      ...Array.from({ length: 50 }, (_, index) => literal(`lit-${index}`)),
      ...Array.from({ length: 50 }, (_, index) => assignmentKey(`key_${index}`)),
    ];
    assert.equal(fiftyFifty.length, MAX_CUSTOM_RULES);
    assert.equal(applyPolicy('lit-0 と key_0: v', fiftyFifty), '[REDACTED:custom] と key_0: [REDACTED:custom]');
    assert.throws(() => applyPolicy('x', [...fiftyFifty, literal('over')]), 'literal/assignment_key合算101件を拒否していない');
  });
});
