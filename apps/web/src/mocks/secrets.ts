import type { Secret } from '@ace/contracts';

/**
 * The mock engine's secrets (ACE parity P1, D274). Rows and values are kept apart, as the real
 * engine keeps them: a row is what every handler answers; a value goes into its own map, the mock
 * keychain, and no handler ever reads it back out. In-memory only — not in the persisted mock
 * database — so a value typed in mock mode never lands in localStorage either.
 */

const rows = new Map<string, Secret>();
/** The mock keychain: name → value. Written on create and update, read only by tests. */
const keychain = new Map<string, string>();

export function listMockSecrets(): Secret[] {
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getMockSecret(name: string): Secret | undefined {
  return rows.get(name);
}

export function putMockSecret(secret: Secret, value?: string): Secret {
  rows.set(secret.name, secret);
  if (value !== undefined) keychain.set(secret.name, value);
  return secret;
}

export function deleteMockSecret(name: string): boolean {
  keychain.delete(name);
  return rows.delete(name);
}

/** Tests only: what the mock keychain holds for a name — never reachable through a handler. */
export function mockSecretValue(name: string): string | undefined {
  return keychain.get(name);
}

export function resetMockSecrets(): void {
  rows.clear();
  keychain.clear();
}
