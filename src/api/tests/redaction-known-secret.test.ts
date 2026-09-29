import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as redactionModule from '../redaction.js';

// known secretはcollector processだけが受け取り、sanitize純粋関数ではbuilt-inの次・business置換の前へ適用する。
// 照合はcase-sensitive exact・longest-first、placeholderは[REDACTED:known_secret]。値は結果へ残さない。

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

const KNOWN_SECRET = 'abcd1234efgh5678';
const KNOWN_PREFIX = 'abcd1234';
const KNOWN_MIXED_CASE = 'KnownSecret1234';
const KNOWN_CANDIDATE = 'kR8pQ2mX7vN4bT9wZ3cH6jL1sD5fG0aY';
const KNOWN_PLACEHOLDER = '[REDACTED:known_secret]';

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

describe('known secretのexact置換', () => {
  it('case-sensitive exactで[REDACTED:known_secret]へ置換し、大文字小文字違いを変えない', () => {
    assert.equal(sentText(sanitize(`値は ${KNOWN_MIXED_CASE} です`, policy(), [KNOWN_MIXED_CASE])), `値は ${KNOWN_PLACEHOLDER} です`);
    assert.equal(
      sentText(sanitize(`値は ${KNOWN_MIXED_CASE.toLowerCase()} です`, policy(), [KNOWN_MIXED_CASE])),
      `値は ${KNOWN_MIXED_CASE.toLowerCase()} です`,
      'known secretをcase-insensitiveに照合している',
    );
    assert.equal(sentText(sanitize(`値は ${KNOWN_SECRET} です`, policy(), [KNOWN_SECRET, KNOWN_PREFIX])), `値は ${KNOWN_PLACEHOLDER} です`);
  });

  it('longest-firstで置換し、knownSecretsの並び順で結果が変わらない', () => {
    const text = `${KNOWN_SECRET} と ${KNOWN_PREFIX}`;
    const longestFirst = [KNOWN_SECRET, KNOWN_PREFIX];
    assert.equal(sentText(sanitize(text, policy(), longestFirst)), `${KNOWN_PLACEHOLDER} と ${KNOWN_PLACEHOLDER}`);
    assert.equal(
      sentText(sanitize(text, policy(), [...longestFirst].reverse())),
      `${KNOWN_PLACEHOLDER} と ${KNOWN_PLACEHOLDER}`,
      'knownSecretsの並び順で結果が変わる',
    );
    assert.equal(
      sentText(sanitize(KNOWN_SECRET, policy(), longestFirst)),
      KNOWN_PLACEHOLDER,
      '短いknown secretを先に採用している',
    );
  });

  it('適用順はbuilt-in → known → field → termで、置換済みplaceholderを再置換しない', () => {
    // built-inが先: 代入値はenv_valueとして伏せられ、knownは元値を照合しない。
    assert.equal(
      sentText(sanitize(`PASSWORD=${KNOWN_SECRET}`, policy(), [KNOWN_SECRET])),
      'PASSWORD=[REDACTED:env_value]',
      'built-inよりknownが先に適用されている',
    );
    // knownがfieldより先: fieldは値がplaceholderのため変更しない。
    assert.equal(
      sentText(sanitize(`pass: ${KNOWN_SECRET}`, policy({ fields: ['pass'] }), [KNOWN_SECRET])),
      `pass: ${KNOWN_PLACEHOLDER}`,
      'fieldがknownより先に適用されている',
    );
    // knownがtermより先: 長いknown全体だけがknown placeholderになる。
    assert.equal(
      sentText(sanitize(`${KNOWN_SECRET}-tail`, policy({ terms: [KNOWN_PREFIX] }), [KNOWN_SECRET])),
      `${KNOWN_PLACEHOLDER}-tail`,
      'termがknownより先に適用されている',
    );
    assert.equal(
      sentText(sanitize(`${KNOWN_SECRET} と ${KNOWN_PLACEHOLDER}`, policy(), [KNOWN_SECRET])),
      `${KNOWN_PLACEHOLDER} と ${KNOWN_PLACEHOLDER}`,
      '置換済みknown placeholderを再置換している',
    );
  });

  it('known置換後の本文へsuspicion gateを適用し、known値自体をsuspectedにしない', () => {
    const result = sanitize(KNOWN_CANDIDATE, policy({ suspicion_mode: 'block' }), [KNOWN_CANDIDATE]);
    assert.equal(result.action, 'send', 'known secretをgateがblockしている');
    assert.equal((result as { text: string }).text, KNOWN_PLACEHOLDER);
    const observed = sanitize(KNOWN_CANDIDATE, policy({ suspicion_mode: 'observe' }), [KNOWN_CANDIDATE]);
    assert.equal(observed.action, 'send');
    assert.ok(!JSON.stringify(observed).includes('suspected_secret_observed'), 'known placeholderをobserveしている');
  });

  it('findingsへknown値・周辺文字列を残さない', () => {
    const result = sanitize(`前書き ${KNOWN_SECRET} 後書き`, policy(), [KNOWN_SECRET]);
    assert.equal(sentText(result), `前書き ${KNOWN_PLACEHOLDER} 後書き`);
    assert.equal(result.action, 'send');
    const findings = (result as { findings: string[] }).findings;
    const serialized = JSON.stringify(findings);
    assert.ok(!serialized.includes(KNOWN_SECRET), 'findingsへknown値が漏れている');
    assert.ok(!serialized.includes('前書き') && !serialized.includes('後書き'), 'findingsへ周辺文字列が漏れている');
  });
});
