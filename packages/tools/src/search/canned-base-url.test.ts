import { LOCAL_SCOPE } from '@ace/engine';
import { afterEach, describe, expect, it } from 'vitest';

import { startHttpServer } from '../__tests__/helpers.js';
import { createWebFetchTool } from '../builtins/web-fetch.js';
import { RecordingToolLogger } from '../logging.js';
import {
  CANNED_SEARCH_BASE_URL,
  CannedSearchBackend,
  cannedResultsAt,
  defaultCannedResults,
} from './backends.js';

/**
 * TC-TOOL-003 / TC-TOOL-006 offline (D14, D-067): the canned index's result URLs can be pointed at a
 * base URL. By default they sit under `https://example.test` — a reserved name that never resolves,
 * so a zero-configuration engine answers a search but no fetch of a result pretends to succeed.
 * Pointed at a local page server (the round-4 HTTP fixture server in the acceptance suite), the same
 * `web_search` → `web_fetch` chain completes with no network and no SearXNG.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('TC-TOOL-006 the canned index answers under a base URL', () => {
  it('defaults to the reserved https://example.test, exactly as before', () => {
    expect(CANNED_SEARCH_BASE_URL).toBe('https://example.test');
    const [first] = defaultCannedResults('Quarterly results', 1);
    expect(first?.url).toBe('https://example.test/quarterly-results/1');
  });

  it('puts every result URL under the base it is given, a trailing slash or not', () => {
    const at = cannedResultsAt('http://127.0.0.1:4321/');
    const results = at('Quarterly results', 2);
    expect(results.map((result) => result.url)).toEqual([
      'http://127.0.0.1:4321/quarterly-results/1',
      'http://127.0.0.1:4321/quarterly-results/2',
    ]);
    expect(cannedResultsAt('http://127.0.0.1:4321')('x', 1)[0]?.url).toBe(
      'http://127.0.0.1:4321/x/1',
    );
    // Titles and snippets are the canned ones; only the address moved.
    expect(results[0]?.title).toBe(defaultCannedResults('Quarterly results', 1)[0]?.title);
  });

  it('refuses a base that is not an http(s) URL', () => {
    expect(() => cannedResultsAt('file:///etc')).toThrow(/http/);
    expect(() => cannedResultsAt('not a url')).toThrow();
  });
});

describe('TC-TOOL-003 search → fetch works offline when the index points at a local page server', () => {
  it('web_fetch reads the page the first canned result names', async () => {
    const server = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><head><title>Local page</title></head><body><p>Offline words.</p></body></html>',
      );
    });
    close = server.close;

    const backend = new CannedSearchBackend({}, cannedResultsAt(server.url));
    const [first] = await backend.search(LOCAL_SCOPE, 'quarterly results summary', 3);
    expect(first?.url.startsWith(server.url)).toBe(true);

    const fetched = await createWebFetchTool().implementation(
      { url: first?.url },
      {
        scope: LOCAL_SCOPE,
        runId: 'run',
        sandboxDir: '/nowhere',
        logger: new RecordingToolLogger(),
        // a loopback page is reachable only through an allowlist entry that is itself the IP
        // [audit S-2]
        allowedDomains: ['127.0.0.1'],
      },
    );
    expect(fetched).toEqual({ title: 'Local page', text: 'Offline words.' });
  });
});
