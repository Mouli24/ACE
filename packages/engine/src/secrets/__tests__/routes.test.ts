import { SecretListResponseSchema, SecretSchema } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { newId } from '../../ids.js';
import { LOCAL_SCOPE, type SecretStore } from '../../ports/index.js';
import { createSecretService, secretStoreKey } from '../index.js';
import { createSecretRoutes } from '../routes.js';

/* ACE parity P1 (D274): `/secrets` in the contract shapes, and never a value in any answer. */

const VALUE = 'fake-route-value-0001';

function setUp() {
  const repository = new FakeRepository();
  const entries = new Map<string, string>();
  const store: SecretStore = {
    isAvailable: async () => true,
    get: async (_s, key) => entries.get(key) ?? null,
    set: async (_s, key, value) => {
      entries.set(key, value);
    },
    delete: async (_s, key) => entries.delete(key),
  };
  const service = createSecretService({ repository, scope: LOCAL_SCOPE, store });
  return { repository, entries, app: routeApp(createSecretRoutes(service)) };
}

describe('D274 /secrets routes', () => {
  it('answers 501 when the engine was built without secrets', async () => {
    const app = routeApp(createSecretRoutes(undefined));
    expect((await send(app, 'GET', '/secrets')).status).toBe(501);
    expect((await send(app, 'POST', '/secrets', { name: 'A', value: VALUE })).status).toBe(501);
  });

  it('creates 201, lists, updates and deletes 204 — and no answer carries the value', async () => {
    const { entries, app } = setUp();
    const created = await send(app, 'POST', '/secrets', {
      name: 'DEPLOY_TOKEN',
      value: VALUE,
      description: 'Staging',
    });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain(VALUE);
    expect(SecretSchema.parse(JSON.parse(createdText)).name).toBe('DEPLOY_TOKEN');
    expect(entries.get(secretStoreKey('DEPLOY_TOKEN'))).toBe(VALUE);

    const listed = await send(app, 'GET', '/secrets');
    const listedText = await listed.text();
    expect(listedText).not.toContain(VALUE);
    expect(SecretListResponseSchema.parse(JSON.parse(listedText)).items).toHaveLength(1);

    const patched = await send(app, 'PATCH', '/secrets/DEPLOY_TOKEN', {
      value: 'fake-route-value-0002',
      description: 'Production',
    });
    expect(patched.status).toBe(200);
    const patchedText = await patched.text();
    expect(patchedText).not.toContain('fake-route-value-0002');
    expect(SecretSchema.parse(JSON.parse(patchedText)).description).toBe('Production');
    expect(entries.get(secretStoreKey('DEPLOY_TOKEN'))).toBe('fake-route-value-0002');

    const deleted = await send(app, 'DELETE', '/secrets/DEPLOY_TOKEN');
    expect(deleted.status).toBe(204);
    expect(entries.size).toBe(0);
    expect(
      SecretListResponseSchema.parse(await (await send(app, 'GET', '/secrets')).json()),
    ).toEqual({ items: [] });
  });

  it('refuses a taken name 409, a reserved or ill-formed name 400, and an unknown one 404', async () => {
    const { app } = setUp();
    await send(app, 'POST', '/secrets', { name: 'API_TOKEN', value: VALUE });

    const taken = await send(app, 'POST', '/secrets', { name: 'API_TOKEN', value: 'other-value' });
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe('name_taken');

    const reserved = await send(app, 'POST', '/secrets', { name: 'PATH', value: VALUE });
    expect(reserved.status).toBe(400);
    const reservedText = await reserved.text();
    expect(reservedText).toContain('validation_failed');
    // A refusal never echoes the value it was sent.
    expect(reservedText).not.toContain(VALUE);

    const lower = await send(app, 'POST', '/secrets', { name: 'api_token', value: VALUE });
    expect(lower.status).toBe(400);
    expect(await lower.text()).not.toContain(VALUE);

    const missing = await send(app, 'PATCH', '/secrets/NOPE', { description: 'x' });
    expect(missing.status).toBe(404);
    expect((await send(app, 'DELETE', '/secrets/NOPE')).status).toBe(404);

    const unknownProject = await send(app, 'PATCH', '/secrets/API_TOKEN', {
      projectIds: [newId()],
    });
    expect(unknownProject.status).toBe(400);
  });
});
