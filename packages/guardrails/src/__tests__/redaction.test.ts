import { RedactedTypeSchema } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { evaluateCheck } from '../evaluate.js';
import { INJECTION_TYPES } from '../rule-packs/injection.js';
import { MODERATION_CATEGORIES } from '../rule-packs/moderation.js';
import { PII_TYPES } from '../rule-packs/pii.js';
import { SECRET_TYPES } from '../rule-packs/secrets.js';
import type { CheckResult } from '../types.js';
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_AWS_KEY_ID,
  FAKE_GITHUB_TOKEN,
  FAKE_GOOGLE_KEY,
  FAKE_OPENAI_KEY,
  FAKE_PRIVATE_KEY_BLOCK,
  HIDDEN_MARKERS,
  makeCheck,
  SAMPLE_CARD,
  SAMPLE_EMAIL,
  SAMPLE_IBAN,
  SAMPLE_PAN,
  SAMPLE_PHONE_INTL,
  SAMPLE_SSN,
} from './fixtures.js';

/**
 * FR-GRD-014 — "Redaction records what type was removed, never the value" (TC-GRD-018).
 *
 * This is the single most important test in the package, and it is written as a *property* rather
 * than a list of assertions: for every sensitive value, run the check that finds it and assert the
 * value is absent from `JSON.stringify(result)`. A well-meaning "let me put the match in the reason
 * so the user can see what happened" fails here, which is the point — `reason` and `redactedTypes`
 * are stored on a `Verdict` and shown in the inspector, so anything in them is a value on screen and
 * in the database (BR-07).
 */

const SENSITIVE: readonly [checkType: 'pii' | 'secret_leak' | 'prompt_injection', value: string][] =
  [
    ['pii', SAMPLE_EMAIL],
    ['pii', SAMPLE_PHONE_INTL],
    ['pii', SAMPLE_CARD],
    ['pii', SAMPLE_IBAN],
    ['pii', SAMPLE_SSN],
    ['pii', SAMPLE_PAN],
    ['secret_leak', FAKE_OPENAI_KEY],
    ['secret_leak', FAKE_ANTHROPIC_KEY],
    ['secret_leak', FAKE_GOOGLE_KEY],
    ['secret_leak', FAKE_GITHUB_TOKEN],
    ['secret_leak', FAKE_AWS_KEY_ID],
    ['secret_leak', FAKE_PRIVATE_KEY_BLOCK],
    ['prompt_injection', HIDDEN_MARKERS],
  ];

describe('TC-GRD-018 Redaction record — the value never appears in the result', () => {
  it.each(SENSITIVE)(
    '%s: the whole result, stringified, does not contain the value',
    (type, value) => {
      const result = evaluateCheck(makeCheck(type, {}, { action: 'redact' }), {
        text: `before ${value} after`,
      });

      expect(result).toBeDefined();
      expect(result?.passed).toBe(false);
      expect(JSON.stringify(result)).not.toContain(value);
    },
  );

  it('shows the type, not the email — the inspector line of TC-GRD-018', () => {
    const result = evaluateCheck(makeCheck('pii', {}, { action: 'redact' }), {
      text: `mail me at ${SAMPLE_EMAIL}`,
    });

    expect(result?.redactedTypes).toEqual(['email']);
    expect(result?.sanitized).toBe('mail me at [email redacted]');
    expect(result?.reason).toBe('Personal data detected: 1 email.');
    expect(result?.reason).not.toContain('@');
  });

  it('keeps the rest of the text intact, so a redact action still has something to send on', () => {
    const result = evaluateCheck(makeCheck('pii', {}, { action: 'redact' }), {
      text: `Q3 grew 12 %. Ask ${SAMPLE_EMAIL} for the deck.`,
    });
    expect(result?.sanitized).toBe('Q3 grew 12 %. Ask [email redacted] for the deck.');
  });
});

describe('FR-GRD-014 every type name a check can report is a name, not a value', () => {
  const everyType = [
    ...PII_TYPES,
    ...SECRET_TYPES,
    ...INJECTION_TYPES,
    ...MODERATION_CATEGORIES,
    'blocked_topic',
  ];

  it.each(everyType)('%s satisfies RedactedTypeSchema', (type) => {
    expect(RedactedTypeSchema.parse(type)).toBe(type);
  });

  it('rejects a would-be type that is actually a value', () => {
    for (const notAType of [SAMPLE_EMAIL, SAMPLE_PHONE_INTL, FAKE_OPENAI_KEY, 'Email']) {
      expect(RedactedTypeSchema.safeParse(notAType).success).toBe(false);
    }
  });
});

describe('FR-GRD-014 a passing check reports no redactions at all', () => {
  it.each(['pii', 'secret_leak', 'prompt_injection', 'moderation'] as const)(
    '%s on clean text',
    (type) => {
      const result = evaluateCheck(makeCheck(type), {
        text: 'Summarise the quarterly report.',
      });
      const clean: CheckResult = { passed: true, reason: result?.reason ?? '' };
      expect(result).toEqual(clean);
    },
  );
});
