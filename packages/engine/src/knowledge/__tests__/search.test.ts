import {
  SearchResponseSchema,
  fuseRankings,
  type Id,
  type KbChunk,
  type KnowledgeBase,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { nodeErrorOf } from '../../errors/index.js';
import { newId } from '../../ids.js';
import {
  LOCAL_SCOPE,
  type Embedder,
  type KeywordIndex,
  type KeywordMatch,
  type Scope,
  type VectorIndex,
  type VectorMatch,
} from '../../ports/index.js';
import { KnowledgeBaseMissingError, createSearchService, type SearchService } from '../search.js';

/*
 * Local doubles (the shared FakeRepository has no index fakes, and wave-3 tasks may not edit it).
 *
 * The keyword fake really matches words, so "an exact rare term is found by the keyword arm" is a
 * statement about the text. The vector fake answers a fixed ranking per base — "a fake index pair
 * whose rankings disagree" (the real-index version of TC-RAG-004/005 is Task 13's).
 */

class FakeVectorIndex implements Pick<VectorIndex, 'query'> {
  readonly calls: { knowledgeBaseId: string; embedding: number[]; k: number }[] = [];

  constructor(private readonly rankings: Record<string, string[]>) {}

  async query(
    _scope: Scope,
    knowledgeBaseId: string,
    embedding: number[],
    k: number,
  ): Promise<VectorMatch[]> {
    this.calls.push({ knowledgeBaseId, embedding, k });
    return (this.rankings[knowledgeBaseId] ?? [])
      .slice(0, k)
      .map((chunkId, index) => ({ chunkId, score: 0.9 - index * 0.1 }));
  }
}

const wordsOf = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((word) => word !== ''),
  );

class FakeKeywordIndex implements Pick<KeywordIndex, 'search'> {
  readonly calls: { knowledgeBaseId: string; query: string; k: number }[] = [];

  constructor(private readonly chunks: () => readonly KbChunk[]) {}

  async search(
    _scope: Scope,
    knowledgeBaseId: string,
    query: string,
    k: number,
  ): Promise<KeywordMatch[]> {
    this.calls.push({ knowledgeBaseId, query, k });
    const terms = [...wordsOf(query)];
    return this.chunks()
      .filter((chunk) => chunk.knowledgeBaseId === knowledgeBaseId)
      .map((chunk) => {
        const words = wordsOf(chunk.text);
        return { chunkId: chunk.id, score: terms.filter((term) => words.has(term)).length };
      })
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

class FakeEmbedder implements Embedder {
  readonly calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map(() => [0.6, 0.8, 0]);
  }
}

const AT = '2026-10-04T09:00:00.000Z';

function knowledgeBase(): KnowledgeBase {
  return {
    id: newId(),
    projectId: newId(),
    name: 'Handbook',
    embeddingProviderId: newId(),
    embeddingModelId: 'mock-embed',
    chunkSize: 700,
    chunkOverlap: 90,
    documentCount: 1,
    chunkCount: 0,
    createdAt: AT,
    updatedAt: AT,
  };
}

interface Harness {
  service: SearchService;
  kb: KnowledgeBase;
  chunks: KbChunk[];
  vectors: FakeVectorIndex;
  keywords: FakeKeywordIndex;
  embedder: FakeEmbedder;
  embedderRequests: Id[];
  repository: FakeRepository;
}

async function harness(
  texts: readonly string[],
  vectorRanking: (chunks: KbChunk[]) => string[],
  options: { clock?: () => number; embedder?: Embedder } = {},
): Promise<Harness> {
  const repository = new FakeRepository();
  const kb = knowledgeBase();
  await repository.knowledgeBases.insert(LOCAL_SCOPE, kb);

  const documentId = newId();
  const chunks: KbChunk[] = texts.map((text, ordinal) => ({
    id: newId(),
    documentId,
    knowledgeBaseId: kb.id,
    ordinal,
    text,
    tokens: Math.ceil(text.length / 4),
    source: `handbook.md#section-${ordinal + 1}`,
    headings: [],
  }));
  await repository.kbChunks.replaceForDocument(
    LOCAL_SCOPE,
    documentId,
    chunks,
    chunks.map(() => [1, 0, 0]),
  );

  const vectors = new FakeVectorIndex({ [kb.id]: vectorRanking(chunks) });
  const keywords = new FakeKeywordIndex(() => chunks);
  const embedder = new FakeEmbedder();
  const embedderRequests: Id[] = [];

  const service = createSearchService({
    scope: LOCAL_SCOPE,
    knowledgeBases: repository.knowledgeBases,
    chunks: repository.kbChunks,
    vectors,
    keywords,
    embedderFor: async (base) => {
      embedderRequests.push(base.id);
      return options.embedder ?? embedder;
    },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  return { service, kb, chunks, vectors, keywords, embedder, embedderRequests, repository };
}

const CORPUS = [
  'Every supplier submits a tax certificate before the first invoice.',
  'Refunds are issued within fourteen days once the parcel is returned.',
  'The zephyrine-protocol-7 governs cold-start retries in the scheduler.',
  'Office hours are nine to five, Monday to Friday.',
];

describe('TC-RAG-004 an exact rare term is found by the keyword arm', () => {
  it('finds the chunk holding the term even though the vector arm never ranked it', async () => {
    // The vector arm ranks everything but the rare-term chunk.
    const h = await harness(CORPUS, (chunks) => [chunks[0]!.id, chunks[1]!.id, chunks[3]!.id]);

    const response = await h.service.search(h.kb.id, {
      query: 'zephyrine-protocol-7',
      k: 5,
      mode: 'hybrid',
    });

    expect(SearchResponseSchema.parse(response)).toEqual(response);
    const hit = response.hits.find((candidate) => candidate.chunkId === h.chunks[2]!.id);
    expect(hit).toMatchObject({
      documentId: h.chunks[2]!.documentId,
      text: CORPUS[2],
      source: 'handbook.md#section-3',
      via: 'keyword',
      score: 0.5,
    });
  });

  it('is the keyword arm that found it: the vector arm alone does not', async () => {
    const h = await harness(CORPUS, (chunks) => [chunks[0]!.id, chunks[1]!.id, chunks[3]!.id]);

    const vectorOnly = await h.service.search(h.kb.id, {
      query: 'zephyrine-protocol-7',
      k: 5,
      mode: 'vector',
    });

    expect(vectorOnly.hits.map((hit) => hit.chunkId)).not.toContain(h.chunks[2]!.id);
  });
});

describe('TC-RAG-005 a paraphrase is found by the vector arm', () => {
  const PARAPHRASE = 'how do I get my money back';

  it('finds the chunk that shares no word with the query, via the vector arm', async () => {
    // The two arms disagree: the vector arm ranks the refund chunk first, the keyword arm cannot
    // see it at all because no word of the query appears in it.
    const h = await harness(CORPUS, (chunks) => [chunks[1]!.id, chunks[0]!.id]);

    const response = await h.service.search(h.kb.id, { query: PARAPHRASE, k: 5, mode: 'hybrid' });

    expect(response.hits[0]).toMatchObject({
      chunkId: h.chunks[1]!.id,
      text: CORPUS[1],
      via: 'vector',
    });
    // The query was embedded once, with the base's own embedder, and that vector was searched.
    expect(h.embedder.calls).toEqual([[PARAPHRASE]]);
    expect(h.embedderRequests).toEqual([h.kb.id]);
    expect(h.vectors.calls).toEqual([{ knowledgeBaseId: h.kb.id, embedding: [0.6, 0.8, 0], k: 5 }]);
  });

  it('is the vector arm that found it: the keyword arm alone does not', async () => {
    const h = await harness(CORPUS, (chunks) => [chunks[1]!.id, chunks[0]!.id]);

    const keywordOnly = await h.service.search(h.kb.id, {
      query: PARAPHRASE,
      k: 5,
      mode: 'keyword',
    });

    expect(keywordOnly.hits.map((hit) => hit.chunkId)).not.toContain(h.chunks[1]!.id);
  });
});

describe('FR-RAG-004 search modes pick the arms', () => {
  it('mode=keyword runs only FTS', async () => {
    const h = await harness(CORPUS, (chunks) => chunks.map((chunk) => chunk.id));

    const response = await h.service.search(h.kb.id, {
      query: 'supplier tax certificate',
      k: 5,
      mode: 'keyword',
    });

    expect(h.vectors.calls).toEqual([]);
    expect(h.embedder.calls).toEqual([]);
    expect(h.embedderRequests).toEqual([]);
    expect(h.keywords.calls).toEqual([
      { knowledgeBaseId: h.kb.id, query: 'supplier tax certificate', k: 5 },
    ]);
    expect(response.hits.length).toBeGreaterThan(0);
    expect(response.hits.every((hit) => hit.via === 'keyword')).toBe(true);
  });

  it('mode=vector runs only the vector arm', async () => {
    const h = await harness(CORPUS, (chunks) => [chunks[3]!.id, chunks[2]!.id]);

    const response = await h.service.search(h.kb.id, {
      query: 'supplier tax certificate',
      k: 5,
      mode: 'vector',
    });

    expect(h.keywords.calls).toEqual([]);
    expect(response.hits.map((hit) => hit.chunkId)).toEqual([h.chunks[3]!.id, h.chunks[2]!.id]);
    expect(response.hits.every((hit) => hit.via === 'vector')).toBe(true);
  });

  it('mode=hybrid fuses both lists with fuseRankings, a chunk both found being via both', async () => {
    const h = await harness(CORPUS, (chunks) => [chunks[0]!.id, chunks[3]!.id]);

    const response = await h.service.search(h.kb.id, {
      query: 'supplier tax certificate',
      k: 5,
      mode: 'hybrid',
    });

    const expected = fuseRankings([h.chunks[0]!.id, h.chunks[3]!.id], [h.chunks[0]!.id]);
    expect(response.hits.map(({ chunkId, score, via }) => ({ chunkId, score, via }))).toEqual(
      expected,
    );
    expect(response.hits[0]).toMatchObject({ chunkId: h.chunks[0]!.id, via: 'both', score: 1 });
  });
});

describe('FR-RAG-004 search results', () => {
  it('a search with no hits is an empty list, not a failure', async () => {
    const h = await harness(CORPUS, () => []);

    const response = await h.service.search(h.kb.id, {
      query: 'quasar',
      k: 5,
      mode: 'hybrid',
    });

    expect(response.hits).toEqual([]);
    expect(response.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('caps the hits at k, and asks each arm for k', async () => {
    const texts = Array.from({ length: 8 }, (_, index) => `policy note number ${index}`);
    const h = await harness(texts, (chunks) => chunks.map((chunk) => chunk.id).reverse());

    const response = await h.service.search(h.kb.id, { query: 'policy', k: 3, mode: 'hybrid' });

    expect(response.hits).toHaveLength(3);
    expect(h.vectors.calls[0]?.k).toBe(3);
    expect(h.keywords.calls[0]?.k).toBe(3);
  });

  it('measures tookMs with its clock', async () => {
    const ticks = [100, 142.5];
    const h = await harness(CORPUS, () => [], { clock: () => ticks.shift() ?? 0 });

    const response = await h.service.search(h.kb.id, { query: 'office', k: 5, mode: 'hybrid' });

    expect(response.tookMs).toBe(42.5);
  });

  it('skips an index entry whose chunk no longer exists', async () => {
    const h = await harness(CORPUS, (chunks) => [newId(), chunks[3]!.id]);

    const response = await h.service.search(h.kb.id, { query: 'quasar', k: 5, mode: 'vector' });

    expect(response.hits.map((hit) => hit.chunkId)).toEqual([h.chunks[3]!.id]);
  });

  it('ranks each arm best first, whatever order an index answers in', async () => {
    const h = await harness(CORPUS, () => []);
    const shuffled: Pick<VectorIndex, 'query'> = {
      query: async () => [
        { chunkId: h.chunks[3]!.id, score: 0.2 },
        { chunkId: h.chunks[1]!.id, score: 0.9 },
      ],
    };
    const service = createSearchService({
      scope: LOCAL_SCOPE,
      knowledgeBases: h.repository.knowledgeBases,
      chunks: h.repository.kbChunks,
      vectors: shuffled,
      keywords: h.keywords,
      embedderFor: async () => h.embedder,
    });

    const response = await service.search(h.kb.id, { query: 'quasar', k: 5, mode: 'vector' });

    expect(response.hits.map((each) => each.chunkId)).toEqual([h.chunks[1]!.id, h.chunks[3]!.id]);
  });

  it('fails loudly when the embedder answers no vector for the query', async () => {
    const h = await harness(CORPUS, () => [], { embedder: { embed: async () => [] } });

    await expect(
      h.service.search(h.kb.id, { query: 'office', k: 5, mode: 'hybrid' }),
    ).rejects.toThrow(/no vector/);
  });

  it('refuses a base that does not exist, as missing_knowledge_base', async () => {
    const h = await harness(CORPUS, () => []);
    const missing = newId();

    const searching = h.service.search(missing, { query: 'office', k: 5, mode: 'hybrid' });

    await expect(searching).rejects.toBeInstanceOf(KnowledgeBaseMissingError);
    const error = await searching.catch((caught: unknown) => caught);
    expect(nodeErrorOf(error)).toMatchObject({
      kind: 'invalid_config',
      code: 'missing_knowledge_base',
      retryable: false,
    });
    expect((error as KnowledgeBaseMissingError).knowledgeBaseId).toBe(missing);
  });
});

describe('FR-RAG-004 search is scoped to one base', () => {
  it('never returns another base’s chunks', async () => {
    const h = await harness(CORPUS, (chunks) => chunks.map((chunk) => chunk.id));
    const other = knowledgeBase();
    await h.repository.knowledgeBases.insert(LOCAL_SCOPE, other);

    const response = await h.service.search(other.id, {
      query: 'supplier',
      k: 5,
      mode: 'hybrid',
    });

    expect(response.hits).toEqual([]);
    expect(h.keywords.calls).toEqual([{ knowledgeBaseId: other.id, query: 'supplier', k: 5 }]);
  });
});
