import { looksLikeSecret, maskSecrets } from '@ace/engine';
import { describe, expect, it } from 'vitest';

import { checkSecretLeak } from '../checks/text.js';
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_AWS_KEY_ID,
  FAKE_GITHUB_PAT,
  FAKE_GITHUB_TOKEN,
  FAKE_GOOGLE_KEY,
  FAKE_OPENAI_KEY,
  FAKE_PRIVATE_KEY_BLOCK,
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

/* -------------------------------------------------------------------------- */
/* Private keys and labelled values — the two rules kept in step by hand        */
/* -------------------------------------------------------------------------- */

/** Letters and digits, forty long: the shape of a key without being one. */
const VALUE = 'Zm9vYmFy'.repeat(5);

const marker = (edge: 'BEGIN' | 'END', kind: string): string =>
  ['-----', edge, ' ', kind, 'PRIVATE KEY', kind.startsWith('PGP') ? ' BLOCK' : '', '-----'].join(
    '',
  );

const PGP_BLOCK = [
  marker('BEGIN', 'PGP '),
  'Version: GnuPG v2',
  '',
  'lQOYBF4d3q4BCADqcJ8p0Ln2uW7r' + 'M'.repeat(36),
  '=aB3d',
  marker('END', 'PGP '),
].join('\n');

const TRUNCATED_BLOCK = [marker('BEGIN', 'EC '), 'MHcCAQEEIBkg4LVWM9nuwNSk' + 'V'.repeat(40)].join(
  '\n',
);

describe('FR-GRD-010 BR-07 D86 both lists agree on every private-key and labelled shape', () => {
  const secrets: readonly [name: string, text: string][] = [
    ['a PEM private key block', FAKE_PRIVATE_KEY_BLOCK],
    ['a PGP private key block', PGP_BLOCK],
    ['a private key cut off before its footer', TRUNCATED_BLOCK],
    ['a quoted key-like assignment', `api_key = "${VALUE}"`],
    ['an unquoted API_KEY', `API_KEY=${VALUE}`],
    ['OPENAI_API_KEY in an env file', `OPENAI_API_KEY=${VALUE}`],
    ['ANTHROPIC_API_KEY in an env file', `ANTHROPIC_API_KEY=${VALUE}`],
    ['AWS_SECRET_ACCESS_KEY in an env file', `AWS_SECRET_ACCESS_KEY=${VALUE}`],
    ['DB_PASSWORD in an env file', `DB_PASSWORD=${VALUE}`],
    ['GITHUB_TOKEN in an env file', `GITHUB_TOKEN=${VALUE}`],
    ['a client secret in YAML', `client_secret: ${VALUE}`],
    ['an access token in JSON', `"access_token": "${VALUE}"`],
    ['a refresh token', `refresh_token=${VALUE}`],
  ];

  it.each(secrets)('%s is caught by both', (_name, value) => {
    const text = `output: ${value} end`;

    expect(looksLikeSecret(text), 'engine storage guard').toBe(true);
    expect(checkSecretLeak(makeCheck('secret_leak'), text).passed, 'secret_leak check').toBe(false);
  });

  it.each(secrets)(
    '%s: what the guardrail masker leaves, storage accepts (D86)',
    (_name, value) => {
      const { sanitized } = checkSecretLeak(makeCheck('secret_leak'), `output: ${value} end`);

      expect(sanitized).toBeDefined();
      expect(looksLikeSecret(sanitized ?? '')).toBe(false);
    },
  );

  it.each(secrets)('%s: what the log redactor leaves, the check passes', (_name, value) => {
    const masked = maskSecrets(`output: ${value} end`);

    expect(checkSecretLeak(makeCheck('secret_leak'), masked).passed).toBe(true);
  });

  it.each([
    ['a call that fetches a key', 'const apiKey = getAnthropicApiKeyFromEnvironmentOrThrow();'],
    ['a call that makes a token', 'const token = createAuthenticationTokenForUserSession(user);'],
    [
      'a typed constructor parameter',
      'constructor(private readonly token: AuthenticationTokenProviderInterface) {}',
    ],
    ['a hashing call', 'password = hash_password_with_bcrypt_and_salt(raw_password)'],
    ['a form with a blank', `Password: ${'_'.repeat(32)}`],
    ['a heading over a rule', `Token:\n${'-'.repeat(40)}`],
    ['a README placeholder', 'API_KEY=your_api_key_here_replace_with_real_value'],
    ['a file path', 'secret: /etc/kubernetes/pki/apiserver-kubelet-client'],
    ['a slug', 'token: how-to-rotate-your-api-credentials-safely'],
  ])('both leave %s alone', (_name, text) => {
    expect(looksLikeSecret(text), 'engine storage guard').toBe(false);
    expect(checkSecretLeak(makeCheck('secret_leak'), text).passed, 'secret_leak check').toBe(true);
  });

  it('differs on one shape only, and in the safe direction: a bare key header', () => {
    // The check flags a header on its own in an output (a key may follow it in the next chunk);
    // storage accepts one, because a header with no key material after it holds nothing, and
    // instructions that *name* the header ("never print -----BEGIN …") must still save.
    const header = `Never print a line that starts with ${marker('BEGIN', '')} — refuse instead.`;

    expect(checkSecretLeak(makeCheck('secret_leak'), header).passed).toBe(false);
    expect(looksLikeSecret(header)).toBe(false);
  });
});
