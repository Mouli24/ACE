import { z } from 'zod';

import { type ToolDefinition } from '@ace/contracts';
import { type SearchBackend } from '@ace/engine';

import { ToolError } from '../errors.js';
import { type RegisteredTool } from '../registry.js';

/**
 * `web_search { query, k? } → { results: [{ title, url, snippet }] }` (§2.2, FR-TOOL-005, D14).
 *
 * The tool holds no search logic of its own — it validates the query, clamps `k`, and asks the
 * {@link SearchBackend} port. That is what lets `pnpm test` run without a SearXNG: the engine binds
 * the port to the canned backend when `settings.searxngUrl` is unset (D14, see `search/backends.ts`).
 * `mock-search` calls this, then `web_fetch` on the first result (§2.6).
 */

export const WEB_SEARCH_DEFAULT_K = 5;
export const WEB_SEARCH_MAX_K = 20;

const SearchArgs = z.strictObject({
  query: z.string().min(1),
  k: z.number().int().positive().max(WEB_SEARCH_MAX_K).optional(),
});

export const WEB_SEARCH_DEFINITION: ToolDefinition = {
  name: 'web_search',
  description: 'Searches the web and returns result titles, URLs and snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      k: { type: 'number', minimum: 1, maximum: WEB_SEARCH_MAX_K },
    },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' } },
          required: ['title', 'url', 'snippet'],
        },
      },
    },
    required: ['results'],
  },
  permissions: { network: true, fsPaths: [], destructive: false },
  timeoutMs: 15_000,
  source: 'builtin',
};

export function createWebSearchTool(deps: { searchBackend: SearchBackend }): RegisteredTool {
  return {
    definition: WEB_SEARCH_DEFINITION,
    implementation: async (args, context) => {
      const parsed = SearchArgs.safeParse(args);
      if (!parsed.success) {
        throw new ToolError('invalid_args', 'web_search', 'web_search needs { query: string }.', {
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const k = parsed.data.k ?? WEB_SEARCH_DEFAULT_K;
      const results = await deps.searchBackend.search(context.scope, parsed.data.query, k);
      return { results: results.slice(0, k) };
    },
  };
}
