import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as redactionModule from '../redaction.js';

// 会社単位のbusiness伏せ字policy。fields/termsを純粋関数で適用し、APIとcollectorが同じ関数を使う。
// 未実装exportはundefinedのままassertで失敗させ、Red理由を「sanitize API未実装」に固定する。
// 上限値は本testで固定する: term 512 code points、field 128 code points、合算100件。

type Policy = {
  version: number;
  fields: readonly string[];
  terms: readonly string[];
  suspicion_mode: 'observe' | 'block';
  detector_version: 'initial-v1';
};

type SanitizationResult =
  | { action: 'send'; text: string; findings: string[] }
  | { action: 'block'; code: 'suspected_secret' };

interface RedactionModule {
  sanitizeConversationText?: (text: string, policy: Policy, knownSecrets?: readonly string[]) => SanitizationResult;
}

const sanitizeFunction = (redactionModule as unknown as RedactionModule).sanitizeConversationText;

const MAX_TERM_CODE_POINTS = 512;
const MAX_FIELD_CODE_POINTS = 128;
const MAX_CUSTOM_RULES = 100;

function policy(overrides: Partial<Policy> = {}): Policy {
  return { version: 1, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1', ...overrides };
}

function sanitize(text: string, value: Policy, knownSecrets?: readonly string[]): SanitizationResult {
  assert.equal(typeof sanitizeFunction, 'function', 'sanitizeConversationText が未実装');
  return sanitizeFunction!(text, value, knownSecrets);
}

// send結果の本文を取り出す。blockされた場合は本文が存在しないことを明示して失敗させる。
function sentText(result: SanitizationResult): string {
  assert.equal(result.action, 'send', `sanitizeがblockした: ${JSON.stringify(result)}`);
  if (result.action !== 'send') {
    throw new Error('unreachable');
  }
  return result.text;
}

describe('business伏せ字policyの純粋関数', () => {
  it('termはexact・case-sensitiveでregex特殊文字もliteralとして扱い、longest-firstで置換する', () => {
    assert.equal(sentText(sanitize('AcmeSecret と acmesecret', policy({ terms: ['AcmeSecret'] }))), '[REDACTED:business_term] と acmesecret');
    assert.equal(sentText(sanitize('前AcmeSecret後', policy({ terms: ['AcmeSecret'] }))), '前[REDACTED:business_term]後');
    assert.equal(sentText(sanitize('abc a.c', policy({ terms: ['a.c'] }))), 'abc [REDACTED:business_term]', 'regexとして解釈されている');
    assert.equal(sentText(sanitize('対象なし', policy({ terms: ['AcmeSecret'] }))), '対象なし');

    const terms = ['secret', 'super-secret'];
    const once = sentText(sanitize('super-secret と secret', policy({ terms })));
    assert.equal(once, '[REDACTED:business_term] と [REDACTED:business_term]');
    assert.equal(sentText(sanitize('aab', policy({ terms: ['ab', 'aab'] }))), '[REDACTED:business_term]', '短いtermを先に採用している');
    assert.equal(sentText(sanitize('super-secret と secret', policy({ terms: [...terms].reverse() }))), once, 'termsの並び順で結果が変わる');
    assert.equal(sentText(sanitize(once, policy({ terms }))), once, '再適用で結果が変わっている');
  });

  it('置換済みbuilt-in/business placeholderを再適用してもbyte一致を維持する', () => {
    const placeholders =
      '[REDACTED:business_term] と [REDACTED:business_value] と [REDACTED:known_secret] と [REDACTED:aws_access_key] と [REDACTED:env_value] と [REDACTED:authorization] と [REDACTED:private_key]';
    const value = policy({ terms: ['AcmeSecret'] });
    assert.equal(sentText(sanitize(placeholders, value)), placeholders, 'placeholder自体を置換している');

    const once = sentText(sanitize(`AcmeSecret と ${placeholders}`, value));
    assert.equal(sentText(sanitize(once, value)), once, 'placeholderを含む置換済み本文が再適用で変化している');
    assert.equal(sentText(sanitize(sentText(sanitize(once, value)), value)), once, '2回目以降の再適用で変化している');

    const builtIn = sentText(sanitize('PASSWORD=hunter2 と AKIAIOSFODNN7EXAMPLE', policy({ terms: ['hunter2'] })));
    assert.equal(builtIn, 'PASSWORD=[REDACTED:env_value] と [REDACTED:aws_access_key]', 'built-in置換がterm適用で壊れている');
    assert.equal(sentText(sanitize(builtIn, policy({ terms: ['hunter2'] }))), builtIn, 'built-in placeholderが再適用で壊れている');
  });

  it('fieldはkeyの表記・空白・区切りを保持してvalueだけbusiness_valueへ置換する', () => {
    const value = policy({ fields: ['pass'] });
    assert.equal(sentText(sanitize('pass: hogehoge', value)), 'pass: [REDACTED:business_value]');
    assert.equal(sentText(sanitize('PASS: hogehoge', value)), 'PASS: [REDACTED:business_value]', 'case-insensitiveでない、またはkey表記が変わっている');
    assert.equal(sentText(sanitize('Pass = hogehoge', value)), 'Pass = [REDACTED:business_value]', '空白・区切り・key表記を保持していない');
    assert.equal(sentText(sanitize('PASS=hogehoge', value)), 'PASS=[REDACTED:business_value]', 'equals区切りの大文字keyへ反応していない');
    assert.equal(sentText(sanitize('pass : hogehoge', value)), 'pass : [REDACTED:business_value]');
    assert.equal(sentText(sanitize('pass：hogehoge', value)), 'pass：[REDACTED:business_value]', '全角colonを代入として扱っていない');
    assert.equal(sentText(sanitize('PASS：hogehoge', value)), 'PASS：[REDACTED:business_value]', '大文字keyの全角colonへ反応していない');
    assert.equal(sentText(sanitize('pass ： hogehoge', value)), 'pass ： [REDACTED:business_value]');
    assert.equal(sentText(sanitize('pass: "hoge hoge"', value)), 'pass: [REDACTED:business_value]', 'quoted valueを置換していない');
    assert.equal(sentText(sanitize("pass: 'hoge hoge'", value)), 'pass: [REDACTED:business_value]', 'single quoted valueを置換していない');
    assert.equal(sentText(sanitize('pass: a-b_c.1', value)), 'pass: [REDACTED:business_value]');
    assert.equal(sentText(sanitize('pass: hoge\nnext', value)), 'pass: [REDACTED:business_value]\nnext');
    const maxValue = 'v'.repeat(4096);
    assert.equal(sentText(sanitize(`pass: ${maxValue}`, value)), 'pass: [REDACTED:business_value]', '上限4096のvalueを置換していない');
    assert.equal(sentText(sanitize(`pass: "${maxValue}"`, value)), 'pass: [REDACTED:business_value]', '上限4096のquoted valueを置換していない');
  });

  it('fieldはkeyだけ・空value・改行越境・比較・名前空間・別identifierを変更しない', () => {
    const value = policy({ fields: ['pass'] });
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
      'DB_PASS: hogehoge',
    ]) {
      assert.equal(sentText(sanitize(unchanged, value)), unchanged, `変更してはいけない入力: ${JSON.stringify(unchanged)}`);
    }
    // passkeyはcustom rule `pass`とは別identifierのためfield置換は起きない。KEY suffixとしての
    // built-in置換だけが従来どおりvalueを伏せる。
    assert.equal(sentText(sanitize('passkey: hogehoge', value)), 'passkey: [REDACTED:env_value]');
  });

  it('field/termはenvironment variable参照とplaceholderを変更せず、再適用してもbyte一致する', () => {
    const value = policy({ fields: ['my_var'], terms: ['AcmeSecret'] });
    for (const unchanged of [
      'my_var: $MY_VAR',
      'my_var: ${MY_VAR}',
      'my_var: [REDACTED:business_value]',
      'my_var: [REDACTED:env_value]',
      '[REDACTED:known_secret]',
    ]) {
      assert.equal(sentText(sanitize(unchanged, value)), unchanged, `変更してはいけない入力: ${JSON.stringify(unchanged)}`);
    }

    const text = 'my_var: hogehoge と AcmeSecret と my_var: $MY_VAR';
    const once = sentText(sanitize(text, value));
    assert.equal(once, 'my_var: [REDACTED:business_value] と [REDACTED:business_term] と my_var: $MY_VAR');
    assert.equal(sentText(sanitize(once, value)), once, '再適用でplaceholderやenv参照が変化している');
    assert.equal(sentText(sanitize(sentText(sanitize(once, value)), value)), once, '3回目の再適用で変化している');
  });

  it('fieldとbuilt-inを併用し、termはbuilt-in適用後の本文へ適用する', () => {
    assert.equal(
      sentText(sanitize('pass: hogehoge と my_var: other', policy({ fields: ['my_var'] }))),
      'pass: [REDACTED:env_value] と my_var: [REDACTED:business_value]',
      'fieldとbuilt-in PASSの優先順位が確定契約と異なる',
    );
    assert.equal(
      sentText(sanitize('PASSWORD=hunter2 と hunter2 と AcmeSecret と AKIAIOSFODNN7EXAMPLE', policy({ terms: ['hunter2', 'AcmeSecret'] }))),
      'PASSWORD=[REDACTED:env_value] と [REDACTED:business_term] と [REDACTED:business_term] と [REDACTED:aws_access_key]',
    );
    assert.equal(
      sentText(sanitize('PASSWORD=hunter2', policy())),
      sentText(sanitize('PASSWORD=hunter2', policy({ terms: ['unknown'] }))),
      'policy無しでbuilt-inが弱まっている',
    );
  });

  it('作用のない本文ではfindingsを値なしで返し、空policyはbyte一致で送る', () => {
    const result = sanitize('変更対象のない本文', policy());
    assert.deepEqual(result, { action: 'send', text: '変更対象のない本文', findings: [] }, '空policyのsend結果が契約と異なる');
  });

  it('invalid policyを拒否し、field/termの境界値と重複規則を受理する', () => {
    for (const invalid of [
      { version: -1 },
      { version: 1.5 },
      { fields: 'AcmeSecret' },
      { terms: 'AcmeSecret' },
      { suspicion_mode: 'warn' },
      { detector_version: 'latest' },
      { fields: [1] },
      { terms: [null] },
    ]) {
      assert.throws(
        () => sanitize('x', policy(invalid as Partial<Policy>)),
        `不正policyを拒否していない: ${JSON.stringify(invalid)}`,
      );
    }

    assert.throws(() => sanitize('x', policy({ terms: [''] })), '空termを拒否していない');
    assert.throws(() => sanitize('x', policy({ terms: ['[REDACTED:business_term]'] })), 'placeholderそのものを拒否していない');
    for (const fragment of ['REDACTED', 'business_term', 'business_value', 'known_secret', '[REDACTED', 'env_value', 'authorization', ':']) {
      assert.throws(() => sanitize('x', policy({ terms: [fragment] })), `termのplaceholder部分文字列 ${fragment} を受理している`);
    }
    assert.throws(() => sanitize('x', policy({ terms: ['dup', 'dup'] })), '重複termを拒否していない');
    assert.throws(() => sanitize('x', policy({ terms: ['x'.repeat(MAX_TERM_CODE_POINTS + 1)] })), '上限超過termを拒否していない');

    for (const invalidField of ['1pass', '-pass', '.pass', 'pass key', 'pass:key', 'ぱす', 'pass!', 'REDACTED', 'redacted', 'Redacted']) {
      assert.throws(
        () => sanitize('x', policy({ fields: [invalidField] })),
        `不正なfieldを受理している: ${JSON.stringify(invalidField)}`,
      );
    }
    assert.throws(() => sanitize('x', policy({ fields: ['a'.repeat(MAX_FIELD_CODE_POINTS + 1)] })), '上限超過fieldを拒否していない');
    assert.doesNotThrow(() => sanitize('x', policy({ fields: ['pass'] })), '妥当なfieldを拒否している');
    assert.throws(
      () => sanitize('x', policy({ fields: ['pass', 'PASS'] })),
      'fieldの大文字小文字違い重複を拒否していない',
    );

    const maxTerm = 'y'.repeat(MAX_TERM_CODE_POINTS);
    assert.equal(sentText(sanitize(maxTerm, policy({ terms: [maxTerm] }))), '[REDACTED:business_term]');
    const maxField = 'a'.repeat(MAX_FIELD_CODE_POINTS);
    assert.equal(
      sentText(sanitize(`${'A'.repeat(MAX_FIELD_CODE_POINTS)}: v`, policy({ fields: [maxField] }))),
      `${'A'.repeat(MAX_FIELD_CODE_POINTS)}: [REDACTED:business_value]`,
      '128 code pointsのfieldを照合していない',
    );
    assert.doesNotThrow(
      () => sanitize('x', policy({ terms: ['shared'], fields: ['shared'] })),
      'typeが異なる同名ruleを拒否している',
    );
    const mixedCaseTerms = ['Pass', 'pass'];
    assert.equal(
      sentText(sanitize('Pass pass', policy({ terms: mixedCaseTerms }))),
      '[REDACTED:business_term] [REDACTED:business_term]',
      'termのcase-sensitive重複を誤って拒否している',
    );
    assert.equal(
      sentText(sanitize('shared_term と shared_field: v', policy({ terms: ['shared_term'], fields: ['shared_field'] }))),
      '[REDACTED:business_term] と shared_field: [REDACTED:business_value]',
      'typeが異なるruleを併用できていない、またはfieldがterm適用で壊れている',
    );
    const keyedValue = policy({ fields: ['deploy.pass-1_2'] });
    assert.equal(
      sentText(sanitize('DEPLOY.PASS-1_2: value', keyedValue)),
      'DEPLOY.PASS-1_2: [REDACTED:business_value]',
      '許容文字を含むfieldを照合していない',
    );
    assert.equal(
      sentText(sanitize('_pass: value', policy({ fields: ['_pass'] }))),
      '_pass: [REDACTED:business_value]',
      '先頭underscoreのfieldを照合していない',
    );
  });

  it('fieldとtermを合算したrule総数は100件まで、101件を拒否する', () => {
    const hundred = policy({
      fields: ['pass'],
      terms: Array.from({ length: 99 }, (_, index) => `rule-${index}`),
    });
    assert.equal(
      sentText(sanitize('rule-0 と pass: hogehoge', hundred)),
      '[REDACTED:business_term] と pass: [REDACTED:business_value]',
    );

    const hundredOne = policy({
      fields: ['pass'],
      terms: Array.from({ length: 100 }, (_, index) => `rule-${index}`),
    });
    assert.throws(() => sanitize('x', hundredOne), 'field/term合算101件を拒否していない');

    const fiftyFifty = policy({
      terms: Array.from({ length: 50 }, (_, index) => `lit-${index}`),
      fields: Array.from({ length: 50 }, (_, index) => `key_${index}`),
    });
    assert.equal(fiftyFifty.fields.length + fiftyFifty.terms.length, MAX_CUSTOM_RULES);
    assert.equal(
      sentText(sanitize('lit-0 と key_0: v', fiftyFifty)),
      '[REDACTED:business_term] と key_0: [REDACTED:business_value]',
    );
    assert.throws(
      () => sanitize('x', policy({ ...fiftyFifty, terms: [...fiftyFifty.terms, 'over'] })),
      'field/term合算101件を拒否していない',
    );
  });
});
