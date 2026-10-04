import {
  NodeRunSourceSchema,
  RetrievalConfigSchema,
  SearchHitSchema,
  type Id,
  type Part,
  type SearchHit,
  type SearchRequest,
  type SearchResponse,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { failureReasonFor } from '../../errors/index.js';
import { newId } from '../../ids.js';
import { runRetrievalNode } from '../retrieval-node.js';
import { KnowledgeBaseMissingError, type SearchService } from '../search.js';

/** A search double that answers fixed hits and remembers what it was asked. */
function fakeSearch(
  answer: (kbId: Id, req: SearchRequest) => SearchResponse | Error,
): SearchService & {
  calls: { kbId: Id; req: SearchRequest }[];
} {
  const calls: { kbId: Id; req: SearchRequest }[] = [];
  return {
    calls,
    async search(kbId, req) {
      calls.push({ kbId, req });
      const result = answer(kbId, req);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const hit = (text: string, score: number, via: SearchHit['via'] = 'both'): SearchHit => ({
  chunkId: newId(),
  documentId: newId(),
  text,
  score,
  source: `handbook.md#${text.split(' ')[0]}`,
  via,
});

const KB = newId();

describe('TC-RAG-007 the Retrieval node outputs { hits } and records sources', () => {
  it('searches its base with the concatenated text reads and answers one json part', async () => {
    const hits = [hit('Refunds take fourteen days.', 0.9), hit('Returns need a receipt.', 0.4)];
    const search = fakeSearch(() => ({ hits, tookMs: 3 }));
    const reads: Part[] = [
      { type: 'text', text: 'How long do refunds take?' },
      { type: 'json', value: { ignored: true } },
      { type: 'text', text: 'And what about returns?' },
    ];

    const outcome = await runRetrievalNode(
      RetrievalConfigSchema.parse({ knowledgeBaseId: KB, k: 3, mode: 'keyword' }),
      reads,
      search,
    );

    expect(search.calls).toEqual([
      {
        kbId: KB,
        req: { query: 'How long do refunds take?\nAnd what about returns?', k: 3, mode: 'keyword' },
      },
    ]);
    expect(outcome).toEqual({
      ok: true,
      parts: [{ type: 'json', value: { hits } }],
      sources: hits.map(({ chunkId, documentId, score, source }) => ({
        chunkId,
        documentId,
        score,
        source,
      })),
    });
    if (!outcome.ok) throw new Error('unreachable');
    for (const source of outcome.sources) NodeRunSourceSchema.parse(source);
    for (const each of (outcome.parts[0] as { value: { hits: SearchHit[] } }).value.hits) {
      SearchHitSchema.parse(each);
    }
  });

  it('searches hybrid with its configured k when no mode is set', async () => {
    const search = fakeSearch(() => ({ hits: [], tookMs: 0 }));

    const outcome = await runRetrievalNode(
      RetrievalConfigSchema.parse({ knowledgeBaseId: KB }),
      [{ type: 'text', text: 'office hours' }],
      search,
    );

    expect(search.calls[0]?.req).toEqual({ query: 'office hours', k: 5, mode: 'hybrid' });
    // No hits is an answer, not a failure: the node still produces `{ hits: [] }`.
    expect(outcome).toEqual({
      ok: true,
      parts: [{ type: 'json', value: { hits: [] } }],
      sources: [],
    });
  });
});

describe('FR-RAG-006 a Retrieval node that cannot search says why, with a typed error', () => {
  it('fails BLOCKED missing_knowledge_base without a knowledge base', async () => {
    const search = fakeSearch(() => ({ hits: [], tookMs: 0 }));

    const outcome = await runRetrievalNode(
      RetrievalConfigSchema.parse({}),
      [{ type: 'text', text: 'anything' }],
      search,
    );

    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.reason).toMatch(/knowledge base/i);
    expect(outcome.error).toMatchObject({
      kind: 'invalid_config',
      code: 'missing_knowledge_base',
      retryable: false,
    });
    expect(failureReasonFor(outcome.error)).toBe('BLOCKED');
    expect(search.calls).toEqual([]);
  });

  it('fails BLOCKED when its reads carry no text to search for', async () => {
    const search = fakeSearch(() => ({ hits: [], tookMs: 0 }));

    const outcome = await runRetrievalNode(
      RetrievalConfigSchema.parse({ knowledgeBaseId: KB }),
      [
        { type: 'json', value: { not: 'text' } },
        { type: 'text', text: '   ' },
      ],
      search,
    );

    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.reason).toMatch(/no text/i);
    expect(outcome.error).toMatchObject({ kind: 'workflow', code: 'retrieval_query_empty' });
    expect(failureReasonFor(outcome.error)).toBe('BLOCKED');
    expect(search.calls).toEqual([]);
  });

  it('fails BLOCKED missing_knowledge_base when its base was deleted mid-run', async () => {
    const search = fakeSearch((kbId) => new KnowledgeBaseMissingError(kbId));

    const outcome = await runRetrievalNode(
      RetrievalConfigSchema.parse({ knowledgeBaseId: KB }),
      [{ type: 'text', text: 'office hours' }],
      search,
    );

    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.error).toMatchObject({
      kind: 'invalid_config',
      code: 'missing_knowledge_base',
    });
    expect(outcome.reason).toBe(outcome.error.message);
    expect(failureReasonFor(outcome.error)).toBe('BLOCKED');
  });

  it('classifies any other search failure like a node failure, keeping its reason', async () => {
    const search = fakeSearch(() => new Error('The embedder is unreachable.'));

    const outcome = await runRetrievalNode(
      RetrievalConfigSchema.parse({ knowledgeBaseId: KB }),
      [{ type: 'text', text: 'office hours' }],
      search,
    );

    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.reason).toBe('The embedder is unreachable.');
    expect(outcome.error).toMatchObject({
      kind: 'provider',
      message: 'The embedder is unreachable.',
    });
    expect(failureReasonFor(outcome.error)).toBe('RUN_FAILED');
  });

  it('classifies a thrown value that is not an Error', async () => {
    const search: SearchService = {
      search: () => Promise.reject('boom'),
    };

    const outcome = await runRetrievalNode(
      RetrievalConfigSchema.parse({ knowledgeBaseId: KB }),
      [{ type: 'text', text: 'office hours' }],
      search,
    );

    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome).toMatchObject({ reason: 'boom', error: { kind: 'provider', message: 'boom' } });
  });
});
