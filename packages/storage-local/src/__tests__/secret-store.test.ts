import { LOCAL_SCOPE, SecretStoreUnavailableError } from '@ace/engine';
import { describe, expect, it } from 'vitest';

import { KeychainSecretStore, type EntryLoader } from '../secret-store.js';

const scope = LOCAL_SCOPE;

/**
 * An in-memory stand-in for the OS keychain, shaped like `@napi-rs/keyring`'s `Entry`.
 *
 * The real keychain is unavailable on a headless CI box and would leave residue on a desktop, so
 * the store takes its backend as a loader. This exercises every branch of the adapter without
 * touching the machine's credential store.
 */
function fakeKeyring() {
  const store = new Map<string, string>();

  class FakeEntry {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}

    #key(): string {
      return `${this.service}::${this.account}`;
    }

    getPassword(): string {
      const value = store.get(this.#key());
      // The native binding throws rather than returning null when nothing is stored.
      if (value === undefined) throw new Error('No matching entry found in secure storage');
      return value;
    }

    setPassword(value: string): void {
      store.set(this.#key(), value);
    }

    deletePassword(): boolean {
      return store.delete(this.#key());
    }
  }

  return { store, FakeEntry };
}

function storeWith(loader: EntryLoader): KeychainSecretStore {
  return new KeychainSecretStore('ace-test', loader);
}

describe('BR-07 keychain is the only home for a secret', () => {
  it('round-trips a secret without it ever touching the database', async () => {
    const { FakeEntry, store } = fakeKeyring();
    const secrets = storeWith(async () => FakeEntry as never);

    await secrets.set(scope, 'anthropic', 'a-provider-key');

    expect(await secrets.get(scope, 'anthropic')).toBe('a-provider-key');
    expect([...store.keys()]).toEqual(['ace-test::local:anthropic']);
  });

  it('scopes an account by workspace, so one tenant cannot read another key', async () => {
    const { FakeEntry } = fakeKeyring();
    const secrets = storeWith(async () => FakeEntry as never);

    await secrets.set(scope, 'anthropic', 'local-key');

    expect(await secrets.get({ workspaceId: 'other' }, 'anthropic')).toBeNull();
  });

  it('returns null rather than throwing when nothing is stored', async () => {
    const { FakeEntry } = fakeKeyring();
    const secrets = storeWith(async () => FakeEntry as never);

    expect(await secrets.get(scope, 'missing')).toBeNull();
  });

  it('reports whether a delete removed anything', async () => {
    const { FakeEntry } = fakeKeyring();
    const secrets = storeWith(async () => FakeEntry as never);

    await secrets.set(scope, 'anthropic', 'k');

    expect(await secrets.delete(scope, 'anthropic')).toBe(true);
    expect(await secrets.delete(scope, 'anthropic')).toBe(false);
  });
});

describe('FR-PRV-002 keychain unavailable', () => {
  it('reports unavailable instead of throwing when the backend will not load', async () => {
    const secrets = storeWith(async () => undefined);

    expect(await secrets.isAvailable()).toBe(false);
  });

  it('reports unavailable when loading the backend throws', async () => {
    const secrets = storeWith(async () => {
      throw new Error('no dbus session');
    });

    expect(await secrets.isAvailable()).toBe(false);
  });

  it('throws a typed error when a caller actually needs a secret', async () => {
    const secrets = storeWith(async () => undefined);

    await expect(secrets.get(scope, 'anthropic')).rejects.toThrow(SecretStoreUnavailableError);
    await expect(secrets.set(scope, 'anthropic', 'k')).rejects.toThrow(SecretStoreUnavailableError);
    await expect(secrets.delete(scope, 'anthropic')).rejects.toThrow(SecretStoreUnavailableError);
  });

  it('probes the backend once and remembers the answer', async () => {
    let loads = 0;
    const secrets = storeWith(async () => {
      loads += 1;
      return undefined;
    });

    await secrets.isAvailable();
    await secrets.isAvailable();

    expect(loads).toBe(1);
  });

  it('reports availability from the real backend without crashing on a host that has none', async () => {
    // No loader: this exercises the real `@napi-rs/keyring` path. Either answer is valid — what
    // matters is that asking never throws, because `pnpm test` must pass on a headless CI box.
    await expect(new KeychainSecretStore('ace-test-real').isAvailable()).resolves.toBeTypeOf(
      'boolean',
    );
  });
});
