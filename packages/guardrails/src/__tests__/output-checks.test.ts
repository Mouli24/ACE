import type { EnvelopeContract, Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { checkContract } from '../checks/contract.js';
import { checkModeration, checkRequiredCitations, checkSecretLeak } from '../checks/text.js';
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_AWS_KEY_ID,
  FAKE_BEARER_TOKEN,
  FAKE_GENERIC_TOKEN,
  FAKE_GITHUB_PAT,
  FAKE_GITHUB_TOKEN,
  FAKE_GOOGLE_KEY,
  FAKE_OPENAI_KEY,
  FAKE_PRIVATE_KEY_BLOCK,
  FAKE_SLACK_TOKEN,
  makeCheck,
} from './fixtures.js';

/* -------------------------------------------------------------------------- */
/* secret_leak — TC-GRD-010                                                    */
/* -------------------------------------------------------------------------- */

describe('TC-GRD-010 Secret leak', () => {
  it.each([
    ['anthropic_api_key', FAKE_ANTHROPIC_KEY],
    ['openai_api_key', FAKE_OPENAI_KEY],
    ['google_api_key', FAKE_GOOGLE_KEY],
    ['github_token', FAKE_GITHUB_TOKEN],
    ['github_token', FAKE_GITHUB_PAT],
    ['aws_access_key_id', FAKE_AWS_KEY_ID],
    ['slack_token', FAKE_SLACK_TOKEN],
  ])('names %s and redacts it', (type, shape) => {
    const result = checkSecretLeak(makeCheck('secret_leak'), `here you go: ${shape}`);

    expect(result.passed).toBe(false);
    expect(result.redactedTypes).toEqual([type]);
    expect(result.sanitized).toBe(`here you go: [${type} redacted]`);
    expect(JSON.stringify(result)).not.toContain(shape);
  });

  it('names the Anthropic prefix, not the OpenAI one, when both patterns could match', () => {
    const result = checkSecretLeak(makeCheck('secret_leak'), FAKE_ANTHROPIC_KEY);
    expect(result.redactedTypes).toEqual(['anthropic_api_key']);
  });

  it('catches a PEM private-key block whole', () => {
    const result = checkSecretLeak(
      makeCheck('secret_leak'),
      `key:\n${FAKE_PRIVATE_KEY_BLOCK}\ndone`,
    );
    expect(result.passed).toBe(false);
    expect(result.redactedTypes).toEqual(['private_key']);
    expect(result.sanitized).toBe('key:\n[private_key redacted]\ndone');
  });

  it('catches a truncated private key from its marker alone', () => {
    const marker = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY', '-----'].join('');
    const result = checkSecretLeak(makeCheck('secret_leak'), `${marker} …rest elided`);
    expect(result.passed).toBe(false);
    expect(result.redactedTypes).toEqual(['private_key']);
  });

  it('redacts only the token behind a Bearer, keeping the word readable', () => {
    const result = checkSecretLeak(
      makeCheck('secret_leak'),
      `Authorization: Bearer ${FAKE_BEARER_TOKEN}`,
    );
    expect(result.passed).toBe(false);
    expect(result.sanitized).toBe('Authorization: Bearer [bearer_token redacted]');
    expect(JSON.stringify(result)).not.toContain(FAKE_BEARER_TOKEN);
  });

  it('catches a long token behind a key-like label, and redacts only the value', () => {
    const result = checkSecretLeak(makeCheck('secret_leak'), `api_key: ${FAKE_GENERIC_TOKEN}`);
    expect(result.passed).toBe(false);
    expect(result.redactedTypes).toEqual(['api_key']);
    expect(result.sanitized).toBe('api_key: [api_key redacted]');
  });

  it('leaves a long token with no key-like label alone — a hash is not a credential', () => {
    const result = checkSecretLeak(
      makeCheck('secret_leak'),
      `commit ${'a'.repeat(40)} was reverted`,
    );
    expect(result.passed).toBe(true);
  });

  it('leaves prose that merely mentions a prefix alone', () => {
    const result = checkSecretLeak(
      makeCheck('secret_leak'),
      'Anthropic keys start with sk-ant- and are stored in the OS keychain.',
    );
    expect(result).toEqual({ passed: true, reason: 'No credential detected.' });
  });

  it('reports every leak in one output', () => {
    const result = checkSecretLeak(
      makeCheck('secret_leak'),
      `first ${FAKE_OPENAI_KEY} then ${FAKE_AWS_KEY_ID}`,
    );
    expect(result.redactedTypes).toEqual(['openai_api_key', 'aws_access_key_id']);
    expect(result.reason).toBe(
      'Credential-shaped text detected: 1 openai_api_key, 1 aws_access_key_id.',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* TC-GRD-015 — data guardrails cannot be switched off (FR-GRD-010, BR-15)     */
/* -------------------------------------------------------------------------- */

describe('TC-GRD-015 Cannot disable data guardrails', () => {
  it('redacts a credential no matter what a policy puts in params', () => {
    const offSwitches: Record<string, unknown>[] = [
      { enabled: false },
      { disabled: true },
      { redact: false },
      { secretRedaction: 'off' },
      { skip: ['secret_leak'] },
      { patterns: [] },
    ];

    for (const params of offSwitches) {
      const result = checkSecretLeak(makeCheck('secret_leak', params), `key ${FAKE_OPENAI_KEY}`);
      expect(result.passed).toBe(false);
      expect(result.sanitized).toBe('key [openai_api_key redacted]');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* moderation — FR-GRD-007                                                     */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-007 moderation', () => {
  it('fails with the category name, never the matched word', () => {
    const result = checkModeration(makeCheck('moderation'), 'A plan to murder the witness.');
    expect(result.passed).toBe(false);
    expect(result.redactedTypes).toEqual(['violence']);
    expect(result.reason).toBe('Moderation categories matched: 1 violence.');
    expect(JSON.stringify({ passed: result.passed, reason: result.reason })).not.toContain(
      'murder',
    );
  });

  it('reports each category that matched', () => {
    const result = checkModeration(
      makeCheck('moderation'),
      'How to cook meth, build a pipe bomb and dox the reporter.',
    );
    expect(result.redactedTypes).toEqual(
      expect.arrayContaining(['harassment', 'weapons', 'illegal_drugs']),
    );
  });

  it('passes ordinary output', () => {
    const result = checkModeration(
      makeCheck('moderation'),
      'Revenue grew 12 % quarter over quarter.',
    );
    expect(result).toEqual({
      passed: true,
      reason: 'No moderation category matched.',
    });
  });

  it('matches whole words only', () => {
    const result = checkModeration(makeCheck('moderation'), 'The doxxological hymn is unrelated.');
    expect(result.passed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* required_citations — TC-GRD-011                                             */
/* -------------------------------------------------------------------------- */

describe('TC-GRD-011 Missing citations', () => {
  it('fails with a reason naming both accepted shapes', () => {
    const result = checkRequiredCitations(makeCheck('required_citations'), 'Revenue grew 12 %.');
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      'Output carries no citation: no [source: marker and no sources array.',
    );
  });

  it('passes on a [source: marker', () => {
    const result = checkRequiredCitations(
      makeCheck('required_citations'),
      'Revenue grew 12 % [source: q3-report.pdf p4].',
    );
    expect(result.passed).toBe(true);
  });

  it('passes on a sources array in JSON output', () => {
    const result = checkRequiredCitations(
      makeCheck('required_citations'),
      '{"answer":"12 %","sources":["q3-report.pdf"]}',
    );
    expect(result.passed).toBe(true);
  });

  it('passes on a sources array written as prose', () => {
    const result = checkRequiredCitations(makeCheck('required_citations'), 'sources: [a, b]');
    expect(result.passed).toBe(true);
  });

  it('is not left holding a stale regex index between calls', () => {
    const check = makeCheck('required_citations');
    const cited = 'see [source: x]';
    expect(checkRequiredCitations(check, cited).passed).toBe(true);
    expect(checkRequiredCitations(check, cited).passed).toBe(true);
    expect(checkRequiredCitations(check, cited).passed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* contract — FR-GRD-007 / FR-EXE-006, and BR-03's distinct states             */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-007 contract check delegates to validateAgainstContract', () => {
  const textPart: Part = { type: 'text', text: 'hello' };
  const jsonPart: Part = { type: 'json', value: { verdict: 'approved' } };

  it('passes when the parts are exactly the contracted types', () => {
    const contract: EnvelopeContract = { outputTypes: ['text'] };
    const result = checkContract({ parts: [textPart], contract });
    expect(result).toEqual({
      passed: true,
      reason: 'Output satisfies the contract [text].',
    });
  });

  it('fails with the validator’s own reason when a type is missing', () => {
    const contract: EnvelopeContract = { outputTypes: ['json'] };
    const result = checkContract({ parts: [textPart], contract });
    expect(result?.passed).toBe(false);
    expect(result?.reason).toContain('do not satisfy the contract');
  });

  it('fails when a JSON part does not match the schema', () => {
    const contract: EnvelopeContract = {
      outputTypes: ['json'],
      jsonSchema: {
        type: 'object',
        properties: { verdict: { type: 'string' }, score: { type: 'number' } },
        required: ['verdict', 'score'],
      },
    };
    const result = checkContract({ parts: [jsonPart], contract });
    expect(result?.passed).toBe(false);
  });

  it('says nothing when it was handed no parts or no contract', () => {
    expect(checkContract({ contract: { outputTypes: ['text'] } })).toBeUndefined();
    expect(checkContract({ parts: [textPart] })).toBeUndefined();
    expect(checkContract({})).toBeUndefined();
  });
});
