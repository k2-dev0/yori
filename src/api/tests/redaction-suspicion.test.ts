import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as redactionModule from '../redaction.js';

// suspected-secret gate (detector_version initial-v1) の純粋関数契約。
// built-in/business置換の後にgateを適用し、observeは送信・blockはmessage全体を拒否する。
// 候補の長さ・除外形式はこのtestでdeterministicに固定する。

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

// 32 code pointsのbase64/token風候補。upper/lower/digitが揃い、同じ32文字を含む31文字は対象外。
const SUSPECTED_32 = 'kR8pQ2mX7vN4bT9wZ3cH6jL1sD5fG0aY';
const NOT_SUSPECTED_31 = 'kR8pQ2mX7vN4bT9wZ3cH6jL1sD5fG0a';
// 256 code pointsの上限候補。base64 alphabetの62文字を4周し、8文字を足して長さを揃える。
const SUSPECTED_256 = `${'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.repeat(4)}aB3xY7zQ`;
// 高entropyに見えるが非対象と確定した形式。
const GIT_SHA_40 = '8f3a2c9e1b7d4f6a0e5c8b3d9f2a7c4e1b6d8f3a';
const HEX_32 = '8f3a2c9e1b7d4f6a0e5c8b3d9f2a7c4e';
const HEX_64 = '8f3a2c9e1b7d4f6a0e5c8b3d9f2a7c4e1b6d8f3a0a1b2c3d4e5f6a7b8c9d0e1f';
const UUID_V4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const SEMVER = '4.17.21-alpha.beta.gamma.delta.12345';
const REPOSITORY_PATH = 'src/collector/tests/redaction-policy-ingest.test.ts';
const NORMAL_IDENTIFIERS = ['redactConversationTextWithPolicy', 'collector_policy_cache_encryption_v2'];
const KNOWN_PLACEHOLDERS = ['[REDACTED:business_term]', '[REDACTED:business_value]', '[REDACTED:known_secret]', '[REDACTED:aws_access_key]'];

const OBSERVED = 'suspected_secret_observed';

function policy(overrides: Partial<Policy> = {}): Policy {
  return { version: 1, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1', ...overrides };
}

function sanitize(text: string, value: Policy, knownSecrets?: readonly string[]): SanitizationResult {
  assert.equal(typeof sanitizeFunction, 'function', 'sanitizeConversationText が未実装');
  return sanitizeFunction!(text, value, knownSecrets);
}

function sentText(result: SanitizationResult): string {
  assert.equal(result.action, 'send', `sanitizeがblockした: ${JSON.stringify(result)}`);
  if (result.action !== 'send') {
    throw new Error('unreachable');
  }
  return result.text;
}

function findingsOf(result: SanitizationResult): string[] {
  assert.equal(result.action, 'send', `sanitizeがblockした: ${JSON.stringify(result)}`);
  if (result.action !== 'send') {
    throw new Error('unreachable');
  }
  return result.findings;
}

describe('suspected-secret gate', () => {
  it('observeは本文を変えず送信し、固定code suspected_secret_observedだけをfindingsへ残す', () => {
    const text = `設定値は ${SUSPECTED_32} です`;
    const result = sanitize(text, policy({ suspicion_mode: 'observe' }));
    assert.equal(result.action, 'send');
    assert.equal((result as { text: string }).text, text, 'observeで本文を変更している');
    assert.deepEqual((result as { findings: string[] }).findings, [OBSERVED], 'observeのfindingsが固定codeだけではない');
    assert.ok(!JSON.stringify(result).includes(SUSPECTED_32), 'findings/結果へ候補値が漏れている');
  });

  it('blockはmessage全体を拒否し、textを返さずcode suspected_secretだけを返す', () => {
    const result = sanitize(`先頭 ${SUSPECTED_32} 末尾`, policy({ suspicion_mode: 'block' }));
    assert.deepEqual(result, { action: 'block', code: 'suspected_secret' }, 'block結果が契約と異なる');
    assert.ok(!('text' in result), 'block結果へ本文を返している');
    assert.ok(!JSON.stringify(result).includes(SUSPECTED_32), 'block結果へ候補値が漏れている');
  });

  it('候補がなければblock policyでも送信し、本文とfindingsを変更しない', () => {
    assert.deepEqual(sanitize('通常の本文 12345', policy({ suspicion_mode: 'block' })), {
      action: 'send',
      text: '通常の本文 12345',
      findings: [],
    });
  });

  it('32/256 code pointsの候補を検出し、31 code pointsは検出しない', () => {
    for (const candidate of [SUSPECTED_32, SUSPECTED_256]) {
      assert.equal([...candidate].length <= 256, true);
      const result = sanitize(`x ${candidate} y`, policy({ suspicion_mode: 'observe' }));
      assert.deepEqual(findingsOf(result), [OBSERVED], `${candidate.length} code pointsの候補を検出していない`);
    }
    assert.deepEqual(sanitize(`x ${NOT_SUSPECTED_31} y`, policy({ suspicion_mode: 'observe' })), {
      action: 'send',
      text: `x ${NOT_SUSPECTED_31} y`,
      findings: [],
    });
  });

  it('UUID・hex/git SHA/checksum・semver・repository path・通常identifierを検出しない', () => {
    const excluded = [UUID_V4, HEX_32, GIT_SHA_40, HEX_64, SEMVER, REPOSITORY_PATH, ...NORMAL_IDENTIFIERS];
    for (const candidate of excluded) {
      const result = sanitize(`値は ${candidate} です`, policy({ suspicion_mode: 'observe' }));
      assert.deepEqual(result, { action: 'send', text: `値は ${candidate} です`, findings: [] }, `${candidate} をsuspectedにしている`);
    }
    for (const candidate of excluded) {
      assert.equal(sanitize(candidate, policy({ suspicion_mode: 'block' })).action, 'send', `${candidate} をblockしている`);
    }
  });

  it('既知placeholderは再検出せず、byte一致で送る', () => {
    for (const placeholder of KNOWN_PLACEHOLDERS) {
      assert.deepEqual(sanitize(placeholder, policy({ suspicion_mode: 'observe' })), {
        action: 'send',
        text: placeholder,
        findings: [],
      });
      assert.equal(sanitize(placeholder, policy({ suspicion_mode: 'block' })).action, 'send', `${placeholder} をblockしている`);
    }
  });

  it('built-in/business置換の後にgateを適用し、置換済み本文をsuspectedにしない', () => {
    const text = `PASSWORD=hunter2 と ${SUSPECTED_32}`;
    const result = sanitize(text, policy({ terms: ['hunter2'], suspicion_mode: 'observe' }));
    assert.equal(sentText(result), `PASSWORD=[REDACTED:env_value] と ${SUSPECTED_32}`);
    assert.ok(findingsOf(result).includes(OBSERVED), 'observeでcandidateをfindingsから落としている');

    // candidateそのものがbusiness term/field valueなら置換済みplaceholderを再検出しない。
    const termResult = sanitize(SUSPECTED_32, policy({ terms: [SUSPECTED_32], suspicion_mode: 'block' }));
    assert.equal(termResult.action, 'send', 'business置換後のplaceholderをsuspectedにしている');
    assert.equal((termResult as { text: string }).text, '[REDACTED:business_term]');
    assert.ok(!JSON.stringify(termResult).includes(OBSERVED), '置換済みtermをobserveしている');
    const fieldResult = sanitize(`deploy_key: ${SUSPECTED_32}`, policy({ fields: ['deploy_key'], suspicion_mode: 'block' }));
    assert.equal(fieldResult.action, 'send', 'field置換後のplaceholderをsuspectedにしている');
    assert.equal((fieldResult as { text: string }).text, 'deploy_key: [REDACTED:business_value]');
    assert.ok(!JSON.stringify(fieldResult).includes(OBSERVED), '置換済みfieldをobserveしている');
  });

  it('findingsは固定codeだけで、候補の周辺文字列も含まない', () => {
    const text = `前書き ${SUSPECTED_32} 後書き`;
    const findings = findingsOf(sanitize(text, policy({ suspicion_mode: 'observe' })));
    assert.deepEqual(findings, [OBSERVED]);
    for (const finding of findings) {
      assert.equal(typeof finding, 'string');
      for (const fragment of ['前書き', '後書き', SUSPECTED_32, '[REDACTED']) {
        assert.ok(!finding.includes(fragment), `findingsへ周辺文字列が漏れている: ${fragment}`);
      }
    }
  });

  it('NUL・サロゲート・長大本文でも例外を投げず、同じ入力へ同じ結果を返す', () => {
    for (const sample of ['', '\u0000', 'と\uD800', '😀'.repeat(10), `x ${SUSPECTED_32} ${'a'.repeat(70_000)}`]) {
      const once = sanitize(sample, policy({ suspicion_mode: 'observe' }));
      assert.equal(once.action, 'send');
      assert.deepEqual(sanitize(sample, policy({ suspicion_mode: 'observe' })), once, '同じ入力で結果が変わっている');
    }
  });
});
