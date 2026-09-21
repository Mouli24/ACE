import { SecretStoreUnavailableError, type Scope, type SecretStore } from '@ace/engine';
// Type-only: erased at build time, so the native module is still loaded lazily below.
import type { Entry as KeyringEntry } from '@napi-rs/keyring';

type EntryClass = typeof KeyringEntry;

/**
 * The OS keychain (Arch §7 local adapter; a secret manager when hosted).
 *
 * BR-07 and NFR-SEC-02: this is the only place a provider key is ever stored — never the database,
 * the logs or an export. `@napi-rs/keyring` is the maintained keytar-compatible library CLAUDE.md
 * §2 calls for.
 *
 * The native module is loaded lazily and probed once, so a host without a keychain reports itself
 * unavailable instead of throwing at import time. That is what lets `pnpm test` pass on a headless
 * CI box with no env vars and no desktop session.
 */
export class KeychainSecretStore implements SecretStore {
  #entryClass: EntryClass | undefined;
  #probed = false;

  constructor(private readonly service = 'ace-engine') {}

  async isAvailable(): Promise<boolean> {
    return (await this.#load()) !== undefined;
  }

  async get(scope: Scope, key: string): Promise<string | null> {
    const Entry = await this.#require();
    try {
      return new Entry(this.service, this.#account(scope, key)).getPassword() ?? null;
    } catch {
      // No stored value for this account — not an error.
      return null;
    }
  }

  async set(scope: Scope, key: string, value: string): Promise<void> {
    const Entry = await this.#require();
    new Entry(this.service, this.#account(scope, key)).setPassword(value);
  }

  async delete(scope: Scope, key: string): Promise<boolean> {
    const Entry = await this.#require();
    try {
      return new Entry(this.service, this.#account(scope, key)).deletePassword();
    } catch {
      return false;
    }
  }

  async #require(): Promise<EntryClass> {
    const Entry = await this.#load();
    if (Entry === undefined) {
      throw new SecretStoreUnavailableError('no OS keychain could be loaded on this host');
    }
    return Entry;
  }

  async #load(): Promise<EntryClass | undefined> {
    if (this.#probed) return this.#entryClass;
    this.#probed = true;

    try {
      const { Entry } = await import('@napi-rs/keyring');
      // Constructing an entry is the cheapest way to find out whether the native backend loads.
      new Entry(this.service, '__ace_probe__');
      this.#entryClass = Entry;
    } catch {
      this.#entryClass = undefined;
    }

    return this.#entryClass;
  }

  /** Scoped so one workspace's keys can never be read as another's (BR-18). */
  #account(scope: Scope, key: string): string {
    return `${scope.workspaceId}:${key}`;
  }
}
