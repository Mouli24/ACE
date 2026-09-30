import { createHash } from 'node:crypto';

import { API_BASE_PATH, ApiErrorSchema, SettingsSchema, type Settings } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { createArtifactService, type ArtifactService } from '../../artifacts/index.js';
import { createGraphService } from '../../graph/index.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  type Auth,
  type BlobRef,
  type BlobStore,
  type Scope,
} from '../../ports/index.js';
import { createEngineApp, queryTokenAllowed, type EngineApp } from '../index.js';

/**
 * FR-MM-009, round 4 §5 items 1 + 3 (D-066): `GET /artifacts/:id/content` also accepts the session
 * token as `?token=`, because `<img>`, `<audio>`, `<video>` and a download link cannot send an
 * `Authorization` header — `artifactContentUrl(id)` in `@ace/sdk` puts the token in the query for
 * exactly that reason. It is that one GET route only: every other route still needs the header
 * (FR-SYS-002), a wrong or missing token is still 401, the Origin guard is unchanged (FR-SYS-003),
 * and the token never reaches a log line (BR-07).
 */

const TOKEN = 'a1'.repeat(32);
const WRONG = 'b2'.repeat(32);
const SELF_ORIGIN = 'http://127.0.0.1:4747';

/** Constant-time like `SessionTokenAuth`; the gateway only decides *which* token it hands over. */
const auth: Auth = {
  verifyToken: async (_scope: Scope, token: string | undefined) => token === TOKEN,
};

class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, Uint8Array>();

  async put(_scope: Scope, bytes: Uint8Array): Promise<BlobRef> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.#blobs.set(hash, bytes);
    return { hash, size: bytes.byteLength };
  }

  async get(_scope: Scope, hash: string): Promise<Uint8Array | null> {
    return this.#blobs.get(hash) ?? null;
  }

  async has(_scope: Scope, hash: string): Promise<boolean> {
    return this.#blobs.has(hash);
  }

  async delete(_scope: Scope, hash: string): Promise<boolean> {
    return this.#blobs.delete(hash);
  }
}

const settings: Settings = SettingsSchema.parse({ dataDir: '/tmp/ace' });

let lines: string[];
let app: EngineApp;
let artifacts: ArtifactService;

beforeEach(() => {
  lines = [];
  const repository = new FakeRepository();
  const logger = createLogger({
    level: 'info',
    destination: { write: (line) => lines.push(line) },
  });
  artifacts = createArtifactService({
    scope: LOCAL_SCOPE,
    artifacts: repository.artifacts,
    blobs: new MemoryBlobStore(),
    settings: { get: async () => settings },
  });
  app = createEngineApp({
    repository,
    auth,
    logger,
    scope: LOCAL_SCOPE,
    version: '0.1.0',
    graph: createGraphService({ repository, scope: LOCAL_SCOPE, logger }),
    selfOrigins: [SELF_ORIGIN],
    artifacts,
  });
});

const bytes = new TextEncoder().encode('an mp3, as far as this test is concerned');
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

async function stored(): Promise<string> {
  return (await artifacts.upload(bytes, { mime: 'audio/mpeg', name: 'clip.mp3' })).id;
}

const contentPath = (id: string, query = ''): string =>
  `${API_BASE_PATH}/artifacts/${id}/content${query}`;

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
}

describe('FR-MM-009 the content route accepts the session token as ?token= (D-066)', () => {
  it('serves the bytes to a URL that carries the token in its query, as a media element sends it', async () => {
    const id = await stored();

    const response = await app.request(contentPath(id, `?token=${TOKEN}`));

    expect(response.status).toBe(200);
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(bytes));
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
  });

  it('answers a byte range the same way, so a player can seek (§2.1)', async () => {
    const id = await stored();

    const response = await app.request(contentPath(id, `?token=${TOKEN}`), {
      headers: { Range: 'bytes=3-7' },
    });

    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(3, 8));
  });

  it('still serves a request that carries the token in the Authorization header', async () => {
    const id = await stored();

    const response = await app.request(contentPath(id), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
  });

  it('refuses a wrong query token, an empty one and none at all with 401', async () => {
    const id = await stored();

    await expectUnauthorized(await app.request(contentPath(id, `?token=${WRONG}`)));
    await expectUnauthorized(await app.request(contentPath(id, '?token=')));
    await expectUnauthorized(await app.request(contentPath(id)));
  });

  it('lets a present Authorization header decide: a wrong header is 401 whatever the query says', async () => {
    const id = await stored();

    await expectUnauthorized(
      await app.request(contentPath(id, `?token=${TOKEN}`), {
        headers: { Authorization: `Bearer ${WRONG}` },
      }),
    );
  });

  it('keeps the Origin rules: a foreign page is 403 even with the right query token (FR-SYS-003)', async () => {
    const id = await stored();

    const foreign = await app.request(contentPath(id, `?token=${TOKEN}`), {
      headers: { Origin: 'http://evil.example' },
    });
    const own = await app.request(contentPath(id, `?token=${TOKEN}`), {
      headers: { Origin: SELF_ORIGIN },
    });

    expect(foreign.status).toBe(403);
    expect(own.status).toBe(200);
  });

  it('answers 404 for a missing artifact once the query token is accepted', async () => {
    const response = await app.request(
      contentPath('01JBXQ8Z9KQ4R7N2VWXYZ0MISS', `?token=${TOKEN}`),
    );

    expect(response.status).toBe(404);
  });
});

describe('FR-SYS-002 the query token opens that one route and nothing else', () => {
  it('refuses ?token= on the artifact row, on the settings and on a non-GET content request', async () => {
    const id = await stored();

    await expectUnauthorized(await app.request(`${API_BASE_PATH}/artifacts/${id}?token=${TOKEN}`));
    await expectUnauthorized(await app.request(`${API_BASE_PATH}/settings?token=${TOKEN}`));
    await expectUnauthorized(await app.request(`${API_BASE_PATH}/health?token=${TOKEN}`));
    await expectUnauthorized(
      await app.request(contentPath(id, `?token=${TOKEN}`), { method: 'DELETE' }),
    );
  });

  it('names exactly the GET content route as the one that may carry the token in its query', () => {
    expect(queryTokenAllowed('GET', contentPath('01JBXQ8Z9KQ4R7N2VWXYZ0ARTF'))).toBe(true);
    expect(queryTokenAllowed('POST', contentPath('01JBXQ8Z9KQ4R7N2VWXYZ0ARTF'))).toBe(false);
    expect(queryTokenAllowed('GET', `${API_BASE_PATH}/artifacts/01JBXQ8Z9KQ4R7N2VWXYZ0ARTF`)).toBe(
      false,
    );
    expect(queryTokenAllowed('GET', `${API_BASE_PATH}/artifacts/a/b/content`)).toBe(false);
    expect(queryTokenAllowed('GET', `/artifacts/01JBXQ8Z9KQ4R7N2VWXYZ0ARTF/content`)).toBe(false);
    expect(queryTokenAllowed('GET', `${API_BASE_PATH}/workflows/x/content`)).toBe(false);
  });
});

describe('BR-07 the query token never reaches the log', () => {
  it('logs neither the right nor a wrong token when a query-token request fails', async () => {
    await app.request(contentPath('01JBXQ8Z9KQ4R7N2VWXYZ0MISS', `?token=${TOKEN}`));
    await app.request(contentPath('01JBXQ8Z9KQ4R7N2VWXYZ0MISS', `?token=${WRONG}`));
    await app.request(`${API_BASE_PATH}/settings?token=${TOKEN}`);

    // The three failures were logged (404, 401, 401) — and none of them carries a token.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const log = lines.join('');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(WRONG);
  });

  it('masks the token even where a whole URL with its query is logged (defence in depth)', () => {
    const logger = createLogger({
      level: 'info',
      destination: { write: (line) => lines.push(line) },
    });

    logger.info(
      {
        url: `http://127.0.0.1:4747${contentPath('01JBXQ8Z9KQ4R7N2VWXYZ0ARTF', `?token=${TOKEN}`)}`,
      },
      'request',
    );

    expect(lines.join('')).not.toContain(TOKEN);
  });
});
