import { defaultGuardrailChecks, type Id } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { checkSecretLeak } from '../checks/text.js';
import { evaluateCheck } from '../evaluate.js';
import { SECRET_RULES } from '../rule-packs/secrets.js';
import { makeCheck } from './fixtures.js';

/**
 * TC-GRD-010 / FR-GRD-007 / BR-07 — the generic, label-driven half of the secret pack.
 *
 * The key-prefix rules (`sk-`, `ghp_`, `AKIA`, …) are exact; the label rule is a judgement: a long
 * token behind a word like `token` or `password`. It was wrong both ways. `\b` never matches
 * between `_` and a letter, so every `.env` spelling (`OPENAI_API_KEY=…`, `DB_PASSWORD=…`) and every
 * snake_case JSON field (`"access_token": "…"`) went through; and any 32-character identifier after
 * a label — a function call, a type annotation, a README placeholder — failed the output of a node
 * that was only writing code.
 *
 * Every value here is assembled at runtime (CLAUDE.md §2): `'Zm9vYmFy'.repeat(5)` is 40 characters
 * of letters and digits, which is the shape of a key without being one.
 */

const VALUE = 'Zm9vYmFy'.repeat(5);

describe('TC-GRD-010 FR-GRD-007 a key behind an env-style or snake_case label is caught', () => {
  it.each([
    ['OPENAI_API_KEY=', ''],
    ['ANTHROPIC_API_KEY=', ''],
    ['AWS_SECRET_ACCESS_KEY=', ''],
    ['DB_PASSWORD=', ''],
    ['GITHUB_TOKEN=', ''],
    ['client_secret: ', ''],
    ['"access_token": "', '"'],
    ['refresh_token=', ''],
  ])('%s<key> is an api_key, and only the value is redacted', (label, close) => {
    const text = `before ${label}${VALUE}${close} after`;
    const result = checkSecretLeak(makeCheck('secret_leak'), text);

    expect(result.passed).toBe(false);
    expect(result.redactedTypes).toEqual(['api_key']);
    expect(result.sanitized).toBe(`before ${label}[api_key redacted]${close} after`);
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  it('still catches a long single-case token behind a plain label', () => {
    const result = checkSecretLeak(makeCheck('secret_leak'), `password: ${'q'.repeat(36)}`);
    expect(result.redactedTypes).toEqual(['api_key']);
  });
});

describe('FR-GRD-007 code, forms and prose that only look key-like pass the secret check', () => {
  const lookalikes: readonly [label: string, text: string][] = [
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
  ];

  it.each(lookalikes)('%s is not a credential', (_label, text) => {
    expect(checkSecretLeak(makeCheck('secret_leak'), text)).toEqual({
      passed: true,
      reason: 'No credential detected.',
    });
  });

  it('lets the default policy pass a node that writes ordinary code (D10)', () => {
    let sequence = 0;
    const newId = (): Id => `01${'D'.repeat(20)}${String((sequence += 1)).padStart(4, '0')}`;
    const check = defaultGuardrailChecks(newId).find(
      (candidate) => candidate.point === 'output' && candidate.type === 'secret_leak',
    );
    if (check === undefined) throw new Error('the default policy has no output secret_leak check');

    const output = [
      'import { Anthropic } from "@anthropic-ai/sdk";',
      'const apiKey = getAnthropicApiKeyFromEnvironmentOrThrow();',
      'const client = new Anthropic({ apiKey });',
    ].join('\n');

    expect(check.action).toBe('block');
    expect(evaluateCheck(check, { text: output })?.passed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Private keys                                                                */
/* -------------------------------------------------------------------------- */

const marker = (edge: 'BEGIN' | 'END', kind: string): string =>
  ['-----', edge, ' ', kind, 'PRIVATE KEY', kind.startsWith('PGP') ? ' BLOCK' : '', '-----'].join(
    '',
  );

const PGP_BLOCK = [
  marker('BEGIN', 'PGP '),
  'Version: GnuPG v2',
  '',
  'lQOYBF4d3q4BCADqcJ8p0Ln2uW7r' + 'M'.repeat(36),
  'N'.repeat(64),
  '=aB3d',
  marker('END', 'PGP '),
].join('\n');

describe('TC-GRD-010 a private key is caught in every armour', () => {
  it('catches a PGP private key block whole', () => {
    const result = checkSecretLeak(makeCheck('secret_leak'), `key:\n${PGP_BLOCK}\ndone`);

    expect(result.passed).toBe(false);
    expect(result.redactedTypes).toEqual(['private_key']);
    expect(result.sanitized).toBe('key:\n[private_key redacted]\ndone');
  });

  it('catches an OpenSSH key, whose header names two words', () => {
    const block = [
      marker('BEGIN', 'OPENSSH '),
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ' + 'P'.repeat(20),
      marker('END', 'OPENSSH '),
    ].join('\n');

    const result = checkSecretLeak(makeCheck('secret_leak'), block);
    expect(result.sanitized).toBe('[private_key redacted]');
  });

  it('redacts the key material of a block cut off before its footer, not just the header', () => {
    const material = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'Q'.repeat(64), 'R'.repeat(64)];
    const truncated = [marker('BEGIN', 'RSA '), ...material].join('\n');

    const result = checkSecretLeak(makeCheck('secret_leak'), `${truncated}\n(the rest was cut)`);

    expect(result.passed).toBe(false);
    expect(result.redactedTypes).toEqual(['private_key']);
    for (const line of material) expect(result.sanitized).not.toContain(line);
    expect(result.sanitized).toBe('[private_key redacted]\n(the rest was cut)');
  });
});

/* -------------------------------------------------------------------------- */
/* NFR-SAFE-01 — linear on hostile text                                         */
/* -------------------------------------------------------------------------- */

describe('NFR-SAFE-01 the secret pack stays linear on text built to make it backtrack', () => {
  const SIZE = 800_000;
  /** Generous for a linear scan of 800 KB; a quadratic one takes about a second. */
  const BUDGET_MS = 300;

  const fill = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length));

  /**
   * Every pattern of the pack walked over the whole text, the way `findSpans` walks it. The regexes
   * are what this pack owns; resolving overlaps between the spans they find is `spans.ts`'s job.
   */
  function scan(text: string): number {
    let matches = 0;
    for (const { pattern } of SECRET_RULES) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        matches += 1;
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      }
    }
    return matches;
  }

  it.each([
    ['private-key headers that never close', fill(`${marker('BEGIN', '')}\nMIIE `)],
    ['labels whose value is always a call', fill(`token=${'aB1'.repeat(12)}( `)],
    ['labels stacked on labels', fill('token=')],
    ['one endless value behind a label', `api_key=${'a1'.repeat(SIZE / 2)}(`],
    ['armour-header lines under a header', fill(`a: ${marker('BEGIN', '')}\n`)],
  ])('%s', (_label, text) => {
    const started = performance.now();
    scan(text);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
