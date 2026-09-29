import { maskSecrets } from './secret-patterns.js';

/**
 * Thrown by a storage adapter when a write would put a secret in the database (BR-07, NFR-SEC-02).
 *
 * It lives in the engine rather than in the adapter that throws it, so the gateway can answer it for
 * what it is — a value the user typed in the wrong place — with a 400 that names the field, without
 * importing an adapter (CLAUDE.md §3.4 rule 3). `packages/storage-local` throws this class.
 */

/**
 * Shared through the global symbol registry, so a refusal thrown by a second installed copy of this
 * package — whose class is a different object — is still recognised by `isSecretWriteRejectedError`.
 */
const BRAND: unique symbol = Symbol.for('@ace/engine/SecretWriteRejectedError');

export class SecretWriteRejectedError extends Error {
  override readonly name = 'SecretWriteRejectedError';
  readonly [BRAND] = true;
  /**
   * Where the secret was, e.g. `node(…).config.instructions`. Masked on the way in: an object key
   * can itself be a key, and this path goes into a response and a log line.
   */
  readonly path: string;

  constructor(path: string, reason: string) {
    const masked = maskSecrets(path);
    super(
      `Refusing to write a secret to the database at "${masked}": ${reason}. ` +
        'Secrets belong in the OS keychain through SecretStore (BR-07, NFR-SEC-02).',
    );
    this.path = masked;
  }
}

/** True for a `SecretWriteRejectedError` from this copy of the engine or any other. */
export function isSecretWriteRejectedError(error: unknown): error is SecretWriteRejectedError {
  if (error instanceof SecretWriteRejectedError) return true;
  if (!(error instanceof Error)) return false;
  const branded = error as Error & { [BRAND]?: unknown; path?: unknown };
  return branded[BRAND] === true && typeof branded.path === 'string';
}
