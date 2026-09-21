/**
 * BR-07 / NFR-SEC-02: secrets never reach the database.
 *
 * The keychain is the only place a secret lives. This guard runs on every JSON value the repository
 * is about to write, so the rule is enforced by the storage layer rather than trusted to each
 * caller — a node config, an event payload or a settings blob carrying a key is refused, loudly,
 * before it can be persisted.
 */

/** Field names whose value is a secret by definition. */
const SECRET_FIELD_NAMES = new Set([
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'privatekey',
  'private_key',
  'clientsecret',
  'client_secret',
  'password',
  'secret',
  'token',
  'authorization',
]);

/**
 * Value shapes that are a credential wherever they appear. Each needs a long tail so ordinary prose
 * mentioning "sk-" or "Bearer" does not trip the guard.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}/,
  /\bBearer\s+[A-Za-z0-9._-]{24,}/,
];

/** Thrown when a write would put a secret in a SQLite table (BR-07). */
export class SecretWriteRejectedError extends Error {
  override readonly name = 'SecretWriteRejectedError';

  constructor(readonly path: string, reason: string) {
    super(
      `Refusing to write a secret to the database at "${path}": ${reason}. ` +
        'Secrets belong in the OS keychain through SecretStore (BR-07, NFR-SEC-02).',
    );
  }
}

function describeValuePattern(value: string): string | undefined {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    ? 'the value looks like a credential'
    : undefined;
}

/**
 * Walks a JSON-serialisable value and throws on the first secret it finds.
 * `path` is carried through so the error names where the secret was.
 */
export function assertNoSecrets(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    const reason = describeValuePattern(value);
    if (reason !== undefined) throw new SecretWriteRejectedError(path, reason);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;

      if (SECRET_FIELD_NAMES.has(key.toLowerCase()) && typeof child === 'string' && child !== '') {
        throw new SecretWriteRejectedError(childPath, `"${key}" holds a secret by definition`);
      }

      assertNoSecrets(child, childPath);
    }
  }
}

/** Serialise for a JSON column, refusing anything that carries a secret. */
export function toJsonColumn(value: unknown, path = '$'): string {
  assertNoSecrets(value, path);
  return JSON.stringify(value);
}
