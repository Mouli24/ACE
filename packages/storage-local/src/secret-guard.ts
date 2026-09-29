import { SecretWriteRejectedError, isSecretFieldName, looksLikeSecret } from '@ace/engine';

/**
 * BR-07 / NFR-SEC-02: secrets never reach the database.
 *
 * The keychain is the only place a secret lives. This guard runs on every JSON value the repository
 * is about to write, so the rule is enforced by the storage layer rather than trusted to each
 * caller — a node config, an event payload or a settings blob carrying a key is refused, loudly,
 * before it can be persisted.
 *
 * What counts as a secret comes from `@ace/engine`, shared with the log redactor, so the database
 * and the logs can never disagree about it.
 */

/**
 * Thrown when a write would put a secret in a SQLite table (BR-07). The class is the engine's, so
 * the gateway can answer it 400 naming the field (NFR-USE-03) without importing this package; it is
 * re-exported here for the callers that already import it from storage.
 */
export { SecretWriteRejectedError };

function describeValuePattern(value: string): string | undefined {
  return looksLikeSecret(value) ? 'the value looks like a credential' : undefined;
}

/**
 * Walks a JSON-serialisable value and throws on the first secret it finds — in a value, in a field
 * a secret by name, or in a field *name*: `{ [key]: true }` stores the key as surely as
 * `{ apiKey: key }` does. `path` is carried through so the error names where the secret was; the
 * error masks it, so a key-shaped field name never reaches the refusal either.
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

      if (looksLikeSecret(key)) {
        throw new SecretWriteRejectedError(childPath, 'a field name looks like a credential');
      }

      if (isSecretFieldName(key) && typeof child === 'string' && child !== '') {
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
