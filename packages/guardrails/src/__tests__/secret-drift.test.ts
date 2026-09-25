import { looksLikeSecret } from '@ace/engine';
import { describe, expect, it } from 'vitest';

import { checkSecretLeak } from '../checks/text.js';
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_AWS_KEY_ID,
  FAKE_GITHUB_PAT,
  FAKE_GITHUB_TOKEN,
  FAKE_GOOGLE_KEY,
  FAKE_OPENAI_KEY,
  FAKE_SLACK_TOKEN,
  makeCheck,
} from './fixtures.js';

/**
 * FR-GRD-010 / BR-07 — the drift guard.
 *
 * There are two answers in this repository to "is this a secret":
 * `packages/engine/src/security/secret-patterns.ts`, which is what SQLite refuses to store and what
 * the logger masks, and this package's `SECRET_RULES`, which is what the `secret_leak` guardrail
 * fails a node for. A shape one of them catches and the other does not is precisely the leak BR-07
 * exists to prevent — an output the guardrail waves through and the database then refuses to write,
 * or worse, the reverse.
 *
 * So: every credential shape either side knows about has to be caught by both.
 */
describe('FR-GRD-010 the guardrail and the storage guard agree on what a secret is', () => {
  const shapes: readonly [name: string, value: string][] = [
    ['an OpenAI-style key', FAKE_OPENAI_KEY],
    ['an Anthropic key', FAKE_ANTHROPIC_KEY],
    ['a Google API key', FAKE_GOOGLE_KEY],
    ['a GitHub token', FAKE_GITHUB_TOKEN],
    ['a GitHub fine-grained token', FAKE_GITHUB_PAT],
    ['an AWS access key id', FAKE_AWS_KEY_ID],
    ['a Slack token', FAKE_SLACK_TOKEN],
  ];

  it.each(shapes)('%s is caught by both', (_name, value) => {
    expect(looksLikeSecret(value), 'engine storage guard').toBe(true);
    expect(checkSecretLeak(makeCheck('secret_leak'), `output: ${value}`).passed).toBe(false);
  });

  it('agrees that ordinary prose is not a secret', () => {
    const prose = 'The key lives in the OS keychain and the API returns keySet: true.';
    expect(looksLikeSecret(prose)).toBe(false);
    expect(checkSecretLeak(makeCheck('secret_leak'), prose).passed).toBe(true);
  });
});
