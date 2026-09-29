import { LOCAL_SCOPE } from '@ace/engine';
import { afterEach, describe, expect, it } from 'vitest';

import { startHttpServer } from '../__tests__/helpers.js';
import {
  CannedSearchBackend,
  SearxngSearchBackend,
  createSearchBackend,
  defaultCannedResults,
} from './backends.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('TC-TOOL-006 CannedSearchBackend', () => {
  it('answers with results that carry URLs, without any network', async () => {
    const backend = new CannedSearchBackend();
    const results = await backend.search(LOCAL_SCOPE, 'quantum computing', 3);
    expect(results).toHaveLength(3);
    for (const result of results) expect(result.url).toMatch(/^https:\/\//);
  });

  it('prefers an exact-query entry, then `*`, then the fallback', async () => {
    const pinned = [{ title: 'Pinned', url: 'https://pinned.test/1', snippet: 's' }];
    const backend = new CannedSearchBackend({ hello: pinned }, () => [
      { title: 'fb', url: 'https://fb.test/1', snippet: 's' },
    ]);
    expect(await backend.search(LOCAL_SCOPE, 'hello', 5)).toEqual(pinned);
    expect((await backend.search(LOCAL_SCOPE, 'other', 5))[0]?.url).toBe('https://fb.test/1');
  });

  it('caps at k', async () => {
    expect(await new CannedSearchBackend().search(LOCAL_SCOPE, 'x', 2)).toHaveLength(2);
    expect(defaultCannedResults('some query', 1)).toHaveLength(1);
  });
});

describe('SearxngSearchBackend (D14) — never required, tested against a local stub', () => {
  it('maps SearXNG JSON to results and drops entries with no url', async () => {
    const server = await startHttpServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          results: [
            { title: 'A', url: 'https://a.test', content: 'about a' },
            { title: 'No URL', content: 'skip me' },
          ],
        }),
      );
    });
    close = server.close;

    const results = await new SearxngSearchBackend(server.url).search(LOCAL_SCOPE, 'q', 5);
    expect(results).toEqual([{ title: 'A', url: 'https://a.test', snippet: 'about a' }]);
  });

  it('reports a failure when SearXNG answers non-2xx', async () => {
    const server = await startHttpServer((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    close = server.close;
    await expect(new SearxngSearchBackend(server.url).search(LOCAL_SCOPE, 'q', 5)).rejects.toMatchObject({
      kind: 'failed',
    });
  });
});

describe('createSearchBackend', () => {
  it('picks SearXNG when a url is set, the fallback otherwise', () => {
    expect(createSearchBackend({ searxngUrl: 'http://searx.test' })).toBeInstanceOf(SearxngSearchBackend);
    const fallback = new CannedSearchBackend();
    expect(createSearchBackend({ fallback })).toBe(fallback);
    expect(createSearchBackend({})).toBeInstanceOf(CannedSearchBackend);
  });
});
