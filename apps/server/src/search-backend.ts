import type { Scope, SearchBackend } from '@ace/engine';
import { createSearchBackend } from '@ace/tools';

/**
 * [audit U-3] `web_search`'s backend, decided by the settings at each search (D14, D-084).
 *
 * The engine registered the canned index once and never read `settings.searxngUrl`, so a SearXNG
 * the person configured in Settings was never queried. This reads the URL at every call — a change
 * in Settings applies to the next search, with no restart — and hands the query to SearXNG when one
 * is set, to `fallback` (the canned index) when none is.
 */
export function settingsSearchBackend(
  searxngUrl: () => Promise<string | undefined>,
  fallback: SearchBackend,
): SearchBackend {
  return {
    async search(scope: Scope, query: string, k: number) {
      const url = await searxngUrl();
      return createSearchBackend({
        ...(url === undefined ? {} : { searxngUrl: url }),
        fallback,
      }).search(scope, query, k);
    },
  };
}
