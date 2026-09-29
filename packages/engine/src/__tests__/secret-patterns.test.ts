import { describe, expect, it } from 'vitest';

import { createLogger, redactSecrets } from '../logging/index.js';
import {
  REDACTED,
  SECRET_PATTERNS,
  looksLikeSecret,
  maskSecrets,
} from '../security/secret-patterns.js';

/**
 * BR-07 / FR-GRD-010 — what storage refuses and the logger masks.
 *
 * `packages/storage-local` refuses to write any string `looksLikeSecret` accepts, and the engine
 * logger masks it with `maskSecrets`, so a shape missing here reaches SQLite and the log file, and
 * a shape matched too widely turns a node that holds ordinary code into a refused save.
 *
 * Every key-shaped value is assembled at runtime (CLAUDE.md §2). `'Zm9vYmFy'.repeat(5)` is forty
 * characters of letters and digits — the shape of a key without being one.
 */

const VALUE = 'Zm9vYmFy'.repeat(5);

const marker = (edge: 'BEGIN' | 'END', kind: string): string =>
  ['-----', edge, ' ', kind, 'PRIVATE KEY', kind.startsWith('PGP') ? ' BLOCK' : '', '-----'].join(
    '',
  );

const PEM_BLOCK = [
  marker('BEGIN', 'RSA '),
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + 'S'.repeat(32),
  'T'.repeat(64),
  marker('END', 'RSA '),
].join('\n');

const PGP_BLOCK = [
  marker('BEGIN', 'PGP '),
  'Version: GnuPG v2',
  '',
  'lQOYBF4d3q4BCADqcJ8p0Ln2uW7r' + 'M'.repeat(36),
  '=aB3d',
  marker('END', 'PGP '),
].join('\n');

const TRUNCATED_BLOCK = [
  marker('BEGIN', ''),
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  'U'.repeat(64),
].join('\n');

describe('BR-07 FR-GRD-010 the storage guard knows every shape the secret check does', () => {
  it.each([
    ['a PEM private key block', PEM_BLOCK],
    ['a PGP private key block', PGP_BLOCK],
    ['a private key cut off before its footer', TRUNCATED_BLOCK],
    ['a quoted key-like assignment', `api_key = "${VALUE}"`],
    ['an unquoted API_KEY', `API_KEY=${VALUE}`],
    ['an OpenAI key in an env file', `OPENAI_API_KEY=${VALUE}`],
    ['an Anthropic key in an env file', `ANTHROPIC_API_KEY=${VALUE}`],
    ['an AWS secret access key', `AWS_SECRET_ACCESS_KEY=${VALUE}`],
    ['a database password', `DB_PASSWORD=${VALUE}`],
    ['a GitHub token', `GITHUB_TOKEN=${VALUE}`],
    ['a client secret in YAML', `client_secret: ${VALUE}`],
    ['an access token in JSON', `"access_token": "${VALUE}"`],
    ['a refresh token', `refresh_token=${VALUE}`],
  ])('recognises %s', (_label, value) => {
    const text = `before ${value} after`;

    expect(looksLikeSecret(text)).toBe(true);
    expect(maskSecrets(text)).not.toContain(VALUE);
    expect(looksLikeSecret(maskSecrets(text))).toBe(false);
  });

  it('masks a whole private key block, body included', () => {
    expect(maskSecrets(`before\n${PEM_BLOCK}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
    expect(maskSecrets(`before\n${PGP_BLOCK}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
  });

  it('masks only the value behind a label, so the log still says what was there', () => {
    expect(maskSecrets(`OPENAI_API_KEY=${VALUE}`)).toBe(`OPENAI_API_KEY=${REDACTED}`);
    expect(maskSecrets(`"access_token": "${VALUE}"`)).toBe(`"access_token": "${REDACTED}"`);
  });
});

describe('BR-07 code, forms and prose that only look key-like are stored and logged as written', () => {
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
    [
      'instructions that name a key header but hold no key',
      `Never print a line that starts with ${marker('BEGIN', '')} — refuse instead.`,
    ],
  ])('leaves %s alone', (_label, text) => {
    expect(looksLikeSecret(text)).toBe(false);
    expect(maskSecrets(text)).toBe(text);
  });
});

describe('FR-SYS-007 masking one credential never uncovers another', () => {
  it('masks a key that shares its label with the Bearer token in front of it', () => {
    const text = `Authorization: Bearer ${'abcdefghijklmnopqrstuvwx'}.token=${VALUE} end`;
    const masked = maskSecrets(text);

    expect(masked).not.toContain(VALUE);
    expect(masked).toBe(`Authorization: ${REDACTED}=${REDACTED} end`);
    expect(looksLikeSecret(masked)).toBe(false);
  });

  it('masks the same line on its way into a log', () => {
    const line = `Authorization: Bearer ${'abcdefghijklmnopqrstuvwx'}.token=${VALUE} end`;

    expect(JSON.stringify(redactSecrets({ header: line }))).not.toContain(VALUE);
  });
});

describe('NFR-SAFE-01 the storage guard stays linear on text built to make it backtrack', () => {
  const SIZE = 800_000;
  /** Generous for a linear scan of 800 KB; a quadratic one takes seconds. */
  const BUDGET_MS = 300;

  const fill = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length));

  it('declares every pattern global, so a scan walks the text once', () => {
    for (const { pattern } of SECRET_PATTERNS) expect(pattern.global).toBe(true);
  });

  it.each([
    ['private-key headers that never close', fill(`${marker('BEGIN', '')}\n${'M'.repeat(20)} `)],
    ['armour-header lines under a header', fill(`a: ${marker('BEGIN', '')}\n`)],
    ['labels whose value is always a call', fill(`token=${'aB1'.repeat(12)}( `)],
    ['labels stacked on labels', fill('token=')],
    ['one endless value behind a label', `api_key=${'a1'.repeat(SIZE / 2)}(`],
  ])('%s', (_label, text) => {
    const started = performance.now();
    looksLikeSecret(text);
    maskSecrets(text);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});

describe('FR-SYS-007 BR-07 a key used as a field name is masked in logs', () => {
  const KEY = ['ghp', '_', 'a1B2'.repeat(9)].join('');

  it('masks the field name as it would a value, keeping the structure', () => {
    const redacted = redactSecrets({ params: { [KEY]: true, maxChars: 10 } });

    expect(JSON.stringify(redacted)).not.toContain(KEY);
    expect(redacted).toEqual({ params: { [REDACTED]: true, maxChars: 10 } });
  });

  it('masks it however deep it sits, and still redacts its value by name', () => {
    const redacted = redactSecrets({ a: [{ [`x ${KEY}`]: { password: 'hunter2' } }] });

    expect(JSON.stringify(redacted)).not.toContain(KEY);
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
    expect(redacted).toEqual({ a: [{ [`x ${REDACTED}`]: { password: REDACTED } }] });
  });

  it('masks it on the way into a log line', () => {
    const lines: string[] = [];
    const log = createLogger({ destination: { write: (line: string) => lines.push(line) } });

    log.info({ check: { params: { [KEY]: true } } }, 'policy saved');

    expect(lines.join('')).not.toContain(KEY);
  });
});
