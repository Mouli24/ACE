import { SecretSchema, type Project } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { HttpError } from '../../gateway/errors.js';
import { newId } from '../../ids.js';
import { LOCAL_SCOPE, SecretStoreUnavailableError, type SecretStore } from '../../ports/index.js';
import { looksLikeSecret } from '../../security/secret-patterns.js';
import {
  SCRUB_MIN_LENGTH,
  createSecretService,
  eventScrubber,
  scrubDeep,
  scrubMarker,
  secretStoreKey,
  type SecretService,
} from '../index.js';

/*
 * ACE parity P1 (D274): a secret's row is in the repository, its value only in the SecretStore, and
 * nothing the service answers carries the value. Values reach a project's environment by scope and
 * are scrubbed, exactly, out of everything that is kept.
 */

const scope = LOCAL_SCOPE;
const NOW = '2026-10-07T10:00:00.000Z';
/** Obviously fake: no real key is ever written in this repository. */
const VALUE = 'fake-value-not-a-real-key-0001';

/** An in-memory keychain that records every key it was asked to write. */
function memoryStore(options: { unavailable?: boolean } = {}) {
  const entries = new Map<string, string>();
  const unavailable = (): never => {
    throw new SecretStoreUnavailableError('no keychain in this test');
  };
  const store: SecretStore = {
    isAvailable: async () => options.unavailable !== true,
    get: async (_scope, key) =>
      options.unavailable === true ? unavailable() : (entries.get(key) ?? null),
    set: async (_scope, key, value) => {
      if (options.unavailable === true) unavailable();
      entries.set(key, value);
    },
    delete: async (_scope, key) =>
      options.unavailable === true ? unavailable() : entries.delete(key),
  };
  return { store, entries };
}

async function project(repository: FakeRepository, name: string): Promise<Project> {
  return repository.projects.create(scope, {
    id: newId(),
    name,
    folderPath: `/projects/${name}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function setUp(options: { unavailable?: boolean } = {}) {
  const repository = new FakeRepository();
  const { store, entries } = memoryStore(options);
  let tick = 0;
  const service: SecretService = createSecretService({
    repository,
    scope,
    store,
    now: () => new Date(Date.parse(NOW) + 1000 * tick++).toISOString(),
  });
  return { repository, store, entries, service };
}

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('D274 secrets: the row in the database, the value in the keychain', () => {
  it('creates a secret whose value goes only to the store, under secret:env:<NAME>', async () => {
    const { repository, entries, service } = setUp();
    const created = await service.create({
      name: 'DEPLOY_TOKEN',
      value: VALUE,
      description: 'Deploys staging',
    });

    expect(SecretSchema.parse(created)).toEqual({
      name: 'DEPLOY_TOKEN',
      description: 'Deploys staging',
      projectIds: [],
      createdAt: created.createdAt,
      updatedAt: created.createdAt,
    });
    expect(entries.get(secretStoreKey('DEPLOY_TOKEN'))).toBe(VALUE);
    expect(secretStoreKey('DEPLOY_TOKEN')).toBe('secret:env:DEPLOY_TOKEN');
    // Neither the answer nor the stored row nor the listing holds the value.
    expect(JSON.stringify(created)).not.toContain(VALUE);
    expect(JSON.stringify(await repository.secrets.list(scope))).not.toContain(VALUE);
    expect(JSON.stringify(await service.list())).not.toContain(VALUE);
    expect(await service.list()).toEqual([created]);
  });

  it('refuses a name that is taken with 409 name_taken, and keeps the first value', async () => {
    const { entries, service } = setUp();
    await service.create({ name: 'API_TOKEN', value: VALUE });
    const error = await refusal(service.create({ name: 'API_TOKEN', value: 'another-value' }));
    expect(error.code).toBe('name_taken');
    expect(error.status).toBe(409);
    expect(entries.get(secretStoreKey('API_TOKEN'))).toBe(VALUE);
  });

  it('refuses a project scope naming a project that does not exist', async () => {
    const { entries, service } = setUp();
    const error = await refusal(
      service.create({ name: 'API_TOKEN', value: VALUE, projectIds: [newId()] }),
    );
    expect(error.code).toBe('validation_failed');
    expect(entries.size).toBe(0);
  });

  it('takes the value back out of the store when the row cannot be written', async () => {
    const { repository, entries, service } = setUp();
    repository.secrets.create = async () => {
      throw new Error('disk full');
    };
    await expect(service.create({ name: 'API_TOKEN', value: VALUE })).rejects.toThrow('disk full');
    expect(entries.size).toBe(0);
    expect(service.scrubber()(`token ${VALUE}`)).toBe(`token ${VALUE}`);
  });

  it('answers name_taken when a racing create wrote the row first', async () => {
    const { repository, service } = setUp();
    const original = repository.secrets.create.bind(repository.secrets);
    let raced = false;
    repository.secrets.create = async (s, secret) => {
      if (!raced) {
        raced = true;
        await original(s, { ...secret, description: 'the other one' });
      }
      return original(s, secret);
    };
    const error = await refusal(service.create({ name: 'API_TOKEN', value: VALUE }));
    expect(error.code).toBe('name_taken');
  });

  it('updates the description and scope, and a new value replaces the stored one', async () => {
    const { repository, entries, service } = setUp();
    const shop = await project(repository, 'shop');
    const created = await service.create({ name: 'API_TOKEN', value: VALUE });

    const described = await service.update('API_TOKEN', { description: 'Shop API' });
    expect(described.description).toBe('Shop API');
    expect(described.projectIds).toEqual([]);
    expect(entries.get(secretStoreKey('API_TOKEN'))).toBe(VALUE);

    const replaced = await service.update('API_TOKEN', {
      value: 'replacement-value-0002',
      projectIds: [shop.id, shop.id],
    });
    expect(replaced.projectIds).toEqual([shop.id]);
    expect(replaced.createdAt).toBe(created.createdAt);
    expect(replaced.updatedAt > created.updatedAt).toBe(true);
    expect(entries.get(secretStoreKey('API_TOKEN'))).toBe('replacement-value-0002');
    expect(JSON.stringify(replaced)).not.toContain('replacement-value-0002');

    const scrub = service.scrubber();
    expect(scrub(`old ${VALUE} new replacement-value-0002`)).toBe(
      `old ${VALUE} new [SECRET:API_TOKEN]`,
    );
  });

  it('answers 404 for a secret that does not exist, and refuses an unknown project on update', async () => {
    const { service } = setUp();
    expect((await refusal(service.update('NOPE', { description: 'x' }))).code).toBe('not_found');
    expect((await refusal(service.remove('NOPE'))).code).toBe('not_found');
    await service.create({ name: 'API_TOKEN', value: VALUE });
    expect((await refusal(service.update('API_TOKEN', { projectIds: [newId()] }))).code).toBe(
      'validation_failed',
    );
  });

  it('removes the keychain entry with the row, and stops scrubbing the value', async () => {
    const { repository, entries, service } = setUp();
    await service.create({ name: 'API_TOKEN', value: VALUE });
    const scrub = service.scrubber();
    expect(scrub(VALUE)).toBe('[SECRET:API_TOKEN]');

    await service.remove('API_TOKEN');
    expect(entries.size).toBe(0);
    expect(await repository.secrets.get(scope, 'API_TOKEN')).toBeNull();
    expect(scrub(VALUE)).toBe(VALUE);
  });

  it('keeps the row when the keychain entry cannot be removed', async () => {
    const { repository, store, service } = setUp();
    await service.create({ name: 'API_TOKEN', value: VALUE });
    store.delete = async () => {
      throw new SecretStoreUnavailableError('locked');
    };
    await expect(service.remove('API_TOKEN')).rejects.toThrow(SecretStoreUnavailableError);
    expect(await repository.secrets.get(scope, 'API_TOKEN')).not.toBeNull();
  });

  it('answers 501 when the repository has no secrets table', async () => {
    const repository = new FakeRepository();
    Object.defineProperty(repository, 'secrets', { value: undefined });
    const service = createSecretService({ repository, scope, store: memoryStore().store });
    expect((await refusal(service.list())).code).toBe('not_implemented');
    await service.load();
    expect(await service.envFor(newId()).catch((error: unknown) => error)).toBeInstanceOf(
      HttpError,
    );
  });
});

describe('D274 envFor: the secrets in a project scope, by name', () => {
  it('gives a project every all-projects secret and the ones naming it, and no others', async () => {
    const { repository, service } = setUp();
    const shop = await project(repository, 'shop');
    const blog = await project(repository, 'blog');
    await service.create({ name: 'GLOBAL_TOKEN', value: 'global-value-1' });
    await service.create({ name: 'SHOP_TOKEN', value: 'shop-value-1', projectIds: [shop.id] });
    await service.create({ name: 'BLOG_TOKEN', value: 'blog-value-1', projectIds: [blog.id] });
    await service.create({
      name: 'BOTH_TOKEN',
      value: 'both-value-1',
      projectIds: [shop.id, blog.id],
    });

    expect(await service.envFor(shop.id)).toEqual({
      BOTH_TOKEN: 'both-value-1',
      GLOBAL_TOKEN: 'global-value-1',
      SHOP_TOKEN: 'shop-value-1',
    });
    expect(Object.keys(await service.envFor(blog.id)).sort()).toEqual([
      'BLOG_TOKEN',
      'BOTH_TOKEN',
      'GLOBAL_TOKEN',
    ]);
    expect(await service.envFor(newId())).toEqual({ GLOBAL_TOKEN: 'global-value-1' });
  });

  it('reads a value the cache does not hold from the store, and skips one that is missing', async () => {
    const { repository, entries, store } = setUp();
    const at = NOW;
    await repository.secrets.create(scope, {
      name: 'STORED',
      description: '',
      projectIds: [],
      createdAt: at,
      updatedAt: at,
    });
    await repository.secrets.create(scope, {
      name: 'LOST',
      description: '',
      projectIds: [],
      createdAt: at,
      updatedAt: at,
    });
    entries.set(secretStoreKey('STORED'), 'stored-value-1');
    // A fresh service that never loaded: the first use reads the keychain.
    const service = createSecretService({ repository, scope, store });
    expect(await service.envFor(newId())).toEqual({ STORED: 'stored-value-1' });
    expect(service.scrubber()('stored-value-1')).toBe('[SECRET:STORED]');
  });
});

describe('D274 the exact-value scrubber', () => {
  it('replaces every exact value of four or more characters with [SECRET:<NAME>]', async () => {
    const { service } = setUp();
    await service.create({ name: 'API_TOKEN', value: VALUE });
    await service.create({ name: 'PIN', value: '123' });
    const scrub = service.scrubber();

    expect(SCRUB_MIN_LENGTH).toBe(4);
    expect(scrubMarker('API_TOKEN')).toBe('[SECRET:API_TOKEN]');
    expect(scrub(`curl -H "x: ${VALUE}" && echo ${VALUE}`)).toBe(
      'curl -H "x: [SECRET:API_TOKEN]" && echo [SECRET:API_TOKEN]',
    );
    // Three characters would rewrite ordinary text, so it is left alone.
    expect(scrub('PIN is 123')).toBe('PIN is 123');
    expect(scrub('abc')).toBe('abc');
    expect(scrub('nothing to see')).toBe('nothing to see');
  });

  it('shortens a marker the store’s secret guard would itself refuse', async () => {
    const long = 'S3_UPLOAD_ACCESS_KEY_FOR_PRODUCTION_2026';
    expect(looksLikeSecret(`[SECRET:${long}]`)).toBe(true);
    expect(scrubMarker(long)).toBe(`[SECRET:${long.slice(0, 31)}…]`);
    expect(looksLikeSecret(scrubMarker(long))).toBe(false);

    const { service } = setUp();
    await service.create({ name: long, value: VALUE });
    const scrubbed = service.scrubber()(`token ${VALUE}`);
    expect(scrubbed).toBe(`token ${scrubMarker(long)}`);
    expect(looksLikeSecret(scrubbed)).toBe(false);
  });

  it('replaces a longer value whole before a shorter one it contains', async () => {
    const { service } = setUp();
    await service.create({ name: 'SHORT', value: 'abcd' });
    await service.create({ name: 'LONG', value: 'abcd-efgh' });
    expect(service.scrubber()('abcd-efgh then abcd')).toBe('[SECRET:LONG] then [SECRET:SHORT]');
  });

  it('is loaded at start from every stored value', async () => {
    const { repository, store, service } = setUp();
    await service.create({ name: 'API_TOKEN', value: VALUE });

    const restarted = createSecretService({ repository, scope, store });
    expect(restarted.scrubber()(VALUE)).toBe(VALUE);
    await restarted.load();
    expect(restarted.scrubber()(VALUE)).toBe('[SECRET:API_TOKEN]');
  });

  it('starts with nothing to scrub when the keychain is unavailable, without throwing', async () => {
    const { repository, service } = setUp();
    await service.create({ name: 'API_TOKEN', value: VALUE });
    const offline = createSecretService({
      repository,
      scope,
      store: memoryStore({ unavailable: true }).store,
    });
    await expect(offline.load()).resolves.toBeUndefined();
    expect(offline.scrubber()(VALUE)).toBe(VALUE);
    expect(await offline.envFor(newId())).toEqual({});
    await expect(offline.create({ name: 'OTHER', value: VALUE })).rejects.toThrow(
      SecretStoreUnavailableError,
    );
    expect(await repository.secrets.get(scope, 'OTHER')).toBeNull();
  });
});

describe('D274 scrubbing structured values', () => {
  const scrub = (text: string): string => text.split('fake-secret').join('[SECRET:X]');

  it('scrubs every string, keys included, and keeps what did not change as the same object', () => {
    const untouched = { a: 1, b: ['x', { c: true }], d: null };
    expect(scrubDeep(untouched, scrub)).toBe(untouched);

    const payload = {
      output: [{ type: 'text', text: 'printed fake-secret here' }],
      count: 2,
      nested: { 'fake-secret': 'key', keep: ['ok'] },
    };
    const scrubbed = scrubDeep(payload, scrub);
    expect(scrubbed).toEqual({
      output: [{ type: 'text', text: 'printed [SECRET:X] here' }],
      count: 2,
      nested: { '[SECRET:X]': 'key', keep: ['ok'] },
    });
    expect(scrubbed.nested.keep).toBe(payload.nested.keep);
    expect(payload.output[0]?.text).toBe('printed fake-secret here');
  });

  it('leaves a class instance as it is', () => {
    const date = new Date(0);
    expect(scrubDeep(date, scrub)).toBe(date);
  });

  it('turns into an event scrubber that answers the same event when nothing changed', () => {
    const scrubEvent = eventScrubber(scrub);
    const clean = { type: 'node.output', runId: newId(), payload: { text: 'fine' } };
    expect(scrubEvent(clean)).toBe(clean);
    const dirty = { type: 'tool.call', payload: { args: { command: 'echo fake-secret' } } };
    expect(scrubEvent(dirty)).toEqual({
      type: 'tool.call',
      payload: { args: { command: 'echo [SECRET:X]' } },
    });
  });
});
