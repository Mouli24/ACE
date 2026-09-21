import type { Scope } from './scope.js';

/**
 * Provider keys and other secrets (Arch §7: OS keychain locally, a secret manager when hosted).
 *
 * BR-07 and NFR-SEC-02: a secret lives here and nowhere else — never in the database, the logs or
 * an export. Nothing in this interface returns a secret to an API response; the API answers with
 * `keySet: true/false`.
 */
export interface SecretStore {
  /** False when the host has no usable keychain, so callers can report it instead of crashing. */
  isAvailable(): Promise<boolean>;
  get(scope: Scope, key: string): Promise<string | null>;
  set(scope: Scope, key: string, value: string): Promise<void>;
  delete(scope: Scope, key: string): Promise<boolean>;
}

/** Thrown when the OS keychain cannot be reached (FR-PRV-002). */
export class SecretStoreUnavailableError extends Error {
  override readonly name = 'SecretStoreUnavailableError';

  constructor(reason: string) {
    super(`The OS keychain is unavailable: ${reason}`);
  }
}
