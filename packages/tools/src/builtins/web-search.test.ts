import { describe, expect, it } from 'vitest';

import { CannedSearchBackend } from '../search/backends.js';
import { makeContext } from '../__tests__/helpers.js';
import { WEB_SEARCH_DEFINITION, createWebSearchTool } from './web-search.js';

const context = makeContext();

describe('TC-TOOL-006 web_search', () => {
  it('is a network tool', () => {
    expect(WEB_SEARCH_DEFINITION.permissions.network).toBe(true);
  });

  it('returns results with URLs from the backend', async () => {
    const tool = createWebSearchTool({ searchBackend: new CannedSearchBackend() });
    const result = (await tool.implementation({ query: 'ace platform' }, context)) as {
      results: Array<{ url: string }>;
    };
    expect(result.results.length).toBeGreaterThan(0);
    for (const hit of result.results) expect(hit.url).toMatch(/^https:\/\//);
  });

  it('clamps k to what was asked', async () => {
    const tool = createWebSearchTool({ searchBackend: new CannedSearchBackend() });
    const result = (await tool.implementation({ query: 'x', k: 2 }, context)) as { results: unknown[] };
    expect(result.results).toHaveLength(2);
  });

  it('refuses an empty query', async () => {
    const tool = createWebSearchTool({ searchBackend: new CannedSearchBackend() });
    await expect(tool.implementation({ query: '' }, context)).rejects.toMatchObject({ kind: 'invalid_args' });
  });
});
