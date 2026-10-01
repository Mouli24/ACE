import { type Scope, type SearchBackend, type SearchResult } from '@ace/engine';

import { ToolError } from '../errors.js';

/**
 * Search backends behind the `SearchBackend` port (FR-TOOL-005, D14).
 *
 * D14 makes SearXNG the default, but round 4 §2 makes it unrequirable by any test. So there are two
 * adapters: {@link SearxngSearchBackend} queries a self-hosted SearXNG over its JSON API when
 * `settings.searxngUrl` is set, and {@link CannedSearchBackend} answers from an in-memory index the
 * rest of the time — which is what keeps `web_search` working with zero configuration and every
 * test hermetic. {@link createSearchBackend} is the one the engine calls: URL set → SearXNG, else
 * the fallback.
 */

/**
 * Where the canned index's result URLs live by default: `example.test`, a name reserved never to
 * resolve (RFC 2606). A zero-configuration engine therefore answers a search, but a `web_fetch` of a
 * result fails honestly instead of pretending there is a page behind it.
 */
export const CANNED_SEARCH_BASE_URL = 'https://example.test';

/** How the canned index answers a query it was not given ahead of time. */
export function defaultCannedResults(
  query: string,
  k: number,
  baseUrl: string = CANNED_SEARCH_BASE_URL,
): SearchResult[] {
  const base = baseUrl.replace(/\/+$/, '');
  const slug = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'result';
  return Array.from({ length: Math.max(1, k) }, (_unused, index) => ({
    title: `${query} — result ${index + 1}`,
    url: `${base}/${slug}/${index + 1}`,
    snippet: `A canned snippet about ${query} (result ${index + 1}).`,
  }));
}

/**
 * The canned answers, with every result URL under `baseUrl` — the fallback to hand
 * {@link CannedSearchBackend} when the pages should be fetchable (TC-TOOL-003, D-067). The acceptance
 * harness points it at the round-4 local HTTP test server, which answers any path with a small HTML
 * page, so `web_search` → `web_fetch` completes with no network and no SearXNG (D14). The host still
 * has to be on the agent's `allowedDomains`: this moves where the pages are, not what is allowed.
 */
export function cannedResultsAt(baseUrl: string): (query: string, k: number) => SearchResult[] {
  const protocol = new URL(baseUrl).protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`The canned search base must be an http(s) URL, not ${protocol}`);
  }
  return (query, k) => defaultCannedResults(query, k, baseUrl);
}

/**
 * An in-memory search index. `index` maps an exact query (or `'*'` for any) to its results, and
 * `fallback` handles the rest; with neither, {@link defaultCannedResults} answers. This is what the
 * engine wires in when there is no SearXNG, and what a test points at its own HTTP test server so a
 * `web_search` → `web_fetch` chain (mock-search) has a real URL to fetch.
 */
export class CannedSearchBackend implements SearchBackend {
  constructor(
    private readonly index: Record<string, SearchResult[]> = {},
    private readonly fallback?: (query: string, k: number) => SearchResult[],
  ) {}

  search(_scope: Scope, query: string, k: number): Promise<SearchResult[]> {
    const hit = this.index[query] ?? this.index['*'] ?? this.fallback?.(query, k) ?? defaultCannedResults(query, k);
    return Promise.resolve(hit.slice(0, k));
  }
}

/** Queries a self-hosted SearXNG over its JSON API (D14). Never required by a test. */
export class SearxngSearchBackend implements SearchBackend {
  constructor(
    private readonly searxngUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async search(_scope: Scope, query: string, k: number): Promise<SearchResult[]> {
    const url = new URL('search', this.searxngUrl.endsWith('/') ? this.searxngUrl : `${this.searxngUrl}/`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ToolError('failed', 'web_search', `SearXNG did not answer: ${(error as Error).message}`, {
        searxngUrl: this.searxngUrl,
      });
    }
    if (!response.ok) {
      throw new ToolError('failed', 'web_search', `SearXNG answered ${response.status}.`, {
        status: response.status,
      });
    }

    const payload = (await response.json()) as { results?: unknown };
    const results = Array.isArray(payload.results) ? payload.results : [];
    return results
      .slice(0, k)
      .map((raw) => {
        const row = raw as { title?: unknown; url?: unknown; content?: unknown };
        return {
          title: typeof row.title === 'string' ? row.title : '',
          url: typeof row.url === 'string' ? row.url : '',
          snippet: typeof row.content === 'string' ? row.content : '',
        };
      })
      .filter((result) => result.url.length > 0);
  }
}

/** SearXNG when a URL is configured (D14), the fallback (a canned index) otherwise. */
export function createSearchBackend(options: {
  searxngUrl?: string;
  fallback?: SearchBackend;
}): SearchBackend {
  if (options.searxngUrl !== undefined && options.searxngUrl.length > 0) {
    return new SearxngSearchBackend(options.searxngUrl);
  }
  return options.fallback ?? new CannedSearchBackend();
}
