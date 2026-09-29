import type { Scope } from './scope.js';

/** One hit from a web search (§2.2 `web_search` → `{ results: [{ title, url, snippet }] }`). */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Where `web_search` gets its results (FR-TOOL-005, D14).
 *
 * A port, not a hard-wired SearXNG call, for the reason D14 leaves open: SearXNG is the *default*,
 * not the only backend, and — decisive for `pnpm test` — a real SearXNG must never be required
 * (round 4 §2, D14). Local mode binds this to a SearXNG-backed adapter when `settings.searxngUrl`
 * is set and to a canned index otherwise, so the search tool runs with zero configuration and every
 * test stays hermetic.
 *
 * `k` is the number of results the caller wants; a backend returns at most that many.
 */
export interface SearchBackend {
  search(scope: Scope, query: string, k: number): Promise<SearchResult[]>;
}
