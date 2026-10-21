import {
  API_BASE_PATH,
  ApiErrorSchema,
  BYTES_PER_MB,
  SettingsSchema,
  type Settings,
} from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { createArtifactService } from '../../artifacts/index.js';
import { createGraphService } from '../../graph/index.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type Auth, type BlobStore } from '../../ports/index.js';
import { BACKUP_IMPORT_MAX_BYTES, JSON_BODY_MAX_BYTES } from '../body-limit.js';
import { createEngineApp, type EngineApp } from '../index.js';

/**
 * [audit S-9]: a body over its limit is refused at its size, before any route reads it — a JSON
 * body at 10 MB, an upload at `maxUploadMb` (plus its multipart framing), a backup zip at 1 GB — as
 * 413 `upload_too_large` with the limit in `details.maxBytes`.
 */

const TOKEN = 'd4'.repeat(32);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const auth: Auth = { verifyToken: async (_scope, token) => token === TOKEN };

/** A blob store that must never be reached: every refusal here happens before the service. */
const untouchedBlobs: BlobStore = {
  put: async () => {
    throw new Error('the body reached the blob store');
  },
  get: async () => null,
  has: async () => false,
  delete: async () => false,
};

let app: EngineApp;
let repository: FakeRepository;

beforeEach(async () => {
  repository = new FakeRepository();
  await repository.settings.update(LOCAL_SCOPE, { maxUploadMb: 1 });
  const settings: Settings = SettingsSchema.parse({ dataDir: '/tmp/ace', maxUploadMb: 1 });
  const logger = createLogger({ level: 'silent' });
  app = createEngineApp({
    repository,
    auth,
    logger,
    scope: LOCAL_SCOPE,
    version: '0.1.0',
    graph: createGraphService({ repository, scope: LOCAL_SCOPE, logger }),
    artifacts: createArtifactService({
      scope: LOCAL_SCOPE,
      artifacts: repository.artifacts,
      blobs: untouchedBlobs,
      settings: { get: async () => settings },
    }),
  });
});

const url = (path: string): string => `http://127.0.0.1:4747${API_BASE_PATH}${path}`;

/** A body of `size` bytes sent chunked — no Content-Length, so the limit has to count as it reads. */
function chunked(size: number, chunk = 256 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const length = Math.min(chunk, size - sent);
      sent += length;
      controller.enqueue(new Uint8Array(length).fill(0x20));
    },
  });
}

async function expectTooLarge(response: Response, maxBytes: number): Promise<void> {
  expect(response.status).toBe(413);
  const { error } = ApiErrorSchema.parse(await response.json());
  expect(error.code).toBe('upload_too_large');
  expect(error.details).toEqual({ maxBytes });
}

describe('[audit S-9] JSON bodies stop at 10 MB', () => {
  it('refuses an oversized body by its Content-Length and by counting a chunked one', async () => {
    const big = `{"name":"${'x'.repeat(JSON_BODY_MAX_BYTES)}"}`;
    await expectTooLarge(
      await app.request(url('/projects'), {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: big,
      }),
      JSON_BODY_MAX_BYTES,
    );
    await expectTooLarge(
      await app.request(url('/projects'), {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: chunked(JSON_BODY_MAX_BYTES + 1),
        duplex: 'half',
      } as RequestInit),
      JSON_BODY_MAX_BYTES,
    );
  });

  it('still reads a body under the limit', async () => {
    const response = await app.request(url('/projects'), {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Small', folder: '/tmp/small' }),
    });
    expect(response.status).not.toBe(413);
  });
});

describe('[audit S-9] an upload stops at maxUploadMb before the multipart parse', () => {
  it('refuses a body over the setting, declared or chunked, and never stores a byte', async () => {
    const form = new FormData();
    form.set(
      'file',
      new File([new Uint8Array(2 * BYTES_PER_MB)], 'big.txt', { type: 'text/plain' }),
    );

    await expectTooLarge(
      await app.request(url('/artifacts'), { method: 'POST', headers: AUTH, body: form }),
      BYTES_PER_MB,
    );
    await expectTooLarge(
      await app.request(url('/artifacts'), {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'multipart/form-data; boundary=x' },
        body: chunked(2 * BYTES_PER_MB),
        duplex: 'half',
      } as RequestInit),
      BYTES_PER_MB,
    );
  });

  it('follows the setting as it changes', async () => {
    await repository.settings.update(LOCAL_SCOPE, { maxUploadMb: 3 });
    const response = await app.request(url('/artifacts'), {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(4 * BYTES_PER_MB),
      },
      body: 'x',
    });
    await expectTooLarge(response, 3 * BYTES_PER_MB);
  });
});

describe('[audit S-9] a backup import stops at 1 GB', () => {
  it('refuses a body that declares more, before the router reads it', async () => {
    const response = await app.request(url('/backup/import'), {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(BACKUP_IMPORT_MAX_BYTES + 128 * 1024),
      },
      body: 'x',
    });
    await expectTooLarge(response, BACKUP_IMPORT_MAX_BYTES);
  });
});
