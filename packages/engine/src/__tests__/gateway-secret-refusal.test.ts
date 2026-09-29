import { ApiErrorSchema } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createEngineApp, type EngineApp } from '../gateway/index.js';
import { toApiError } from '../gateway/errors.js';
import { createGraphService } from '../graph/index.js';
import { createLogger } from '../logging/index.js';
import { LOCAL_SCOPE, type Auth, type Scope } from '../ports/index.js';
import { REDACTED } from '../security/secret-patterns.js';
import {
  SecretWriteRejectedError,
  isSecretWriteRejectedError,
} from '../security/secret-write-rejected.js';
import { FakeRepository } from './fake-repository.js';

/**
 * BR-07 / NFR-USE-03 — a key typed where the database refuses it is the user's to fix.
 *
 * `packages/storage-local` refuses any write that holds a credential; it throws the engine's
 * `SecretWriteRejectedError`, because the gateway may not import a storage adapter (CLAUDE.md §3.4),
 * and the gateway answers it 400 `validation_failed`, naming the field. It never echoes the value,
 * and it masks the path too, since an object key can itself be a key.
 */

const TOKEN = 'a'.repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const auth: Auth = {
  verifyToken: async (_scope: Scope, token: string | undefined) => token === TOKEN,
};

/** Assembled at runtime (CLAUDE.md §2). */
const KEY = ['ghp', '_', 'a1B2'.repeat(9)].join('');

function build(repository: FakeRepository): EngineApp {
  const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
  return createEngineApp({
    repository,
    auth,
    logger,
    scope: LOCAL_SCOPE,
    version: '0.1.0',
    graph: createGraphService({ repository, scope: LOCAL_SCOPE, logger }),
    selfOrigins: ['http://127.0.0.1:4747'],
  });
}

/** A repository whose settings write is refused the way storage-local refuses it. */
function refusingSettings(path: string): FakeRepository {
  const repository = new FakeRepository();
  repository.settings.update = async () => {
    throw new SecretWriteRejectedError(path, 'the value looks like a credential');
  };
  return repository;
}

async function patchSettings(repository: FakeRepository): Promise<{ status: number; raw: string }> {
  const response = await build(repository).request('/api/v1/settings', {
    method: 'PATCH',
    headers: AUTH,
    body: JSON.stringify({ allowedOrigins: ['http://localhost:5173'] }),
  });
  return { status: response.status, raw: await response.text() };
}

describe('BR-07 NFR-USE-03 a refused secret write answers 400 and says where', () => {
  it('answers validation_failed, naming the field and carrying the path', async () => {
    const { status, raw } = await patchSettings(refusingSettings('settings.allowedOrigins[1]'));

    expect(status).toBe(400);
    const { error } = ApiErrorSchema.parse(JSON.parse(raw));
    expect(error.code).toBe('validation_failed');
    expect(error.kind).toBe('invalid_config');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('"allowedOrigins"');
    expect(error.message).toMatch(/nothing was saved/i);
    expect(error.message).toMatch(/provider settings/);
    expect(error.details).toEqual({ path: 'settings.allowedOrigins[1]' });
  });

  it('masks a path whose field name is itself a key, in the message and in details', async () => {
    const { status, raw } = await patchSettings(refusingSettings(`settings.extra.${KEY}`));

    expect(status).toBe(400);
    expect(raw).not.toContain(KEY);
    const { error } = ApiErrorSchema.parse(JSON.parse(raw));
    expect(error.details).toEqual({ path: `settings.extra.${REDACTED}` });
  });

  it('keeps the value out of the error it throws, and masks its path at the source', () => {
    const error = new SecretWriteRejectedError(`$.params.${KEY}`, 'a field name looks like a key');

    expect(error.path).toBe(`$.params.${REDACTED}`);
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain('OS keychain');
  });

  it('recognises the refusal from another copy of this module by its brand', () => {
    // Two installed copies of @ace/engine would each have their own class; the brand is shared.
    const foreign = Object.assign(new Error('refused'), {
      name: 'SecretWriteRejectedError',
      path: `node.config.${KEY}`,
      [Symbol.for('@ace/engine/SecretWriteRejectedError')]: true,
    });

    expect(isSecretWriteRejectedError(foreign)).toBe(true);
    expect(isSecretWriteRejectedError(new Error('something else'))).toBe(false);
    expect(isSecretWriteRejectedError('a string')).toBe(false);

    const { status, body } = toApiError(foreign);
    expect(status).toBe(400);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('still answers anything else 500, with fixed text', () => {
    const { status, body } = toApiError(new Error(`boom ${KEY}`));

    expect(status).toBe(500);
    expect(body.error.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});
