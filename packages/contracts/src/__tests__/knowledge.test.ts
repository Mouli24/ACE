import { describe, expect, it } from 'vitest';

import { RetrievalConfigSchema, SEARCH_MODES } from '../graph.js';
import {
  AddKbDocumentRequestSchema,
  CHUNK_OVERLAP_MAX,
  CHUNK_SIZE_MAX,
  CHUNK_SIZE_MIN,
  CreateKnowledgeBaseRequestSchema,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  KB_DOCUMENT_STATUSES,
  KbChunkSchema,
  KbDocumentSchema,
  KnowledgeBaseSchema,
  NodeRunSourceSchema,
  RRF_K,
  SEARCH_VIAS,
  SearchHitSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  UpdateKnowledgeBaseRequestSchema,
  fuseRankings,
  isKbDocumentSettled,
} from '../knowledge.js';
import {
  ARTIFACT_ID,
  KB_CHUNK_ID,
  KB_CHUNK_ID_2,
  KB_CHUNK_ID_3,
  KB_DOCUMENT_ID,
  KB_ID,
  NOW,
  PROJECT_ID,
  PROVIDER_ID,
} from './fixtures.js';

const kb = {
  id: KB_ID,
  projectId: PROJECT_ID,
  name: 'Product docs',
  embeddingProviderId: PROVIDER_ID,
  embeddingModelId: 'mock-embed',
  chunkSize: 700,
  chunkOverlap: 90,
  documentCount: 5,
  chunkCount: 42,
  createdAt: NOW,
  updatedAt: NOW,
};

const document = {
  id: KB_DOCUMENT_ID,
  knowledgeBaseId: KB_ID,
  artifactId: ARTIFACT_ID,
  name: 'handbook.pdf',
  mime: 'application/pdf',
  size: 48_213,
  status: 'ready',
  chunkCount: 12,
  ingestedAt: NOW,
  createdAt: NOW,
};

const chunk = {
  id: KB_CHUNK_ID,
  documentId: KB_DOCUMENT_ID,
  knowledgeBaseId: KB_ID,
  ordinal: 0,
  text: 'The zephyrine-protocol-7 handshake runs before any payload.',
  tokens: 14,
  source: 'handbook.pdf#Handshake',
  headings: ['Protocols', 'Handshake'],
};

const hit = {
  chunkId: KB_CHUNK_ID,
  documentId: KB_DOCUMENT_ID,
  text: chunk.text,
  score: 0.5,
  source: chunk.source,
  via: 'keyword',
};

/* -------------------------------------------------------------------------- */

describe('FR-RAG-001 KnowledgeBase', () => {
  it('TC-RAG-001 parses a base with its embedder and chunk settings', () => {
    expect(KnowledgeBaseSchema.parse(kb)).toEqual(kb);
  });

  it('bounds the name to 1..80 characters', () => {
    expect(KnowledgeBaseSchema.safeParse({ ...kb, name: '' }).success).toBe(false);
    expect(KnowledgeBaseSchema.safeParse({ ...kb, name: 'x'.repeat(80) }).success).toBe(true);
    expect(KnowledgeBaseSchema.safeParse({ ...kb, name: 'x'.repeat(81) }).success).toBe(false);
  });

  it('bounds the chunk size to whole numbers 200..2000 and the overlap to 0..400 (§2.1)', () => {
    for (const chunkSize of [CHUNK_SIZE_MIN, DEFAULT_CHUNK_SIZE, CHUNK_SIZE_MAX]) {
      expect(KnowledgeBaseSchema.safeParse({ ...kb, chunkSize }).success, `${chunkSize}`).toBe(
        true,
      );
    }
    for (const chunkSize of [199, 2001, 700.5]) {
      expect(KnowledgeBaseSchema.safeParse({ ...kb, chunkSize }).success, `${chunkSize}`).toBe(
        false,
      );
    }
    for (const chunkOverlap of [0, CHUNK_OVERLAP_MAX]) {
      expect(KnowledgeBaseSchema.safeParse({ ...kb, chunkOverlap }).success).toBe(true);
    }
    for (const chunkOverlap of [-1, 401]) {
      expect(KnowledgeBaseSchema.safeParse({ ...kb, chunkOverlap }).success).toBe(false);
    }
  });

  it('refuses an overlap as large as the chunk itself, which would never advance', () => {
    expect(
      KnowledgeBaseSchema.safeParse({ ...kb, chunkSize: 300, chunkOverlap: 300 }).success,
    ).toBe(false);
    expect(
      KnowledgeBaseSchema.safeParse({ ...kb, chunkSize: 300, chunkOverlap: 299 }).success,
    ).toBe(true);
  });

  it('is strict, so a stray key is drift rather than a silent extra', () => {
    expect(KnowledgeBaseSchema.safeParse({ ...kb, vectors: [] }).success).toBe(false);
  });
});

describe('FR-RAG-001 creating and editing a base', () => {
  const create = {
    name: 'Product docs',
    embeddingProviderId: PROVIDER_ID,
    embeddingModelId: 'mock-embed',
  };

  it('defaults the chunk size to 700 and the overlap to 90 (§2.1)', () => {
    expect(CreateKnowledgeBaseRequestSchema.parse(create)).toEqual({
      ...create,
      chunkSize: DEFAULT_CHUNK_SIZE,
      chunkOverlap: DEFAULT_CHUNK_OVERLAP,
    });
    expect(DEFAULT_CHUNK_SIZE).toBe(700);
    expect(DEFAULT_CHUNK_OVERLAP).toBe(90);
  });

  it('requires the embedder, which is fixed for the life of the base', () => {
    const { embeddingModelId: _model, ...noModel } = create;
    expect(CreateKnowledgeBaseRequestSchema.safeParse(noModel).success).toBe(false);
    expect(
      UpdateKnowledgeBaseRequestSchema.safeParse({ embeddingModelId: 'other-embed' }).success,
      'a PATCH cannot swap the embedder',
    ).toBe(false);
  });

  it('checks the overlap against the size in a create, and in a patch that names both', () => {
    expect(
      CreateKnowledgeBaseRequestSchema.safeParse({ ...create, chunkSize: 200, chunkOverlap: 250 })
        .success,
    ).toBe(false);
    expect(
      UpdateKnowledgeBaseRequestSchema.safeParse({ chunkSize: 200, chunkOverlap: 250 }).success,
    ).toBe(false);
    expect(UpdateKnowledgeBaseRequestSchema.safeParse({ chunkOverlap: 250 }).success).toBe(true);
  });

  it('patches the name and the chunk settings, each optional, filling in nothing', () => {
    expect(UpdateKnowledgeBaseRequestSchema.parse({})).toEqual({});
    expect(UpdateKnowledgeBaseRequestSchema.parse({ name: 'Docs' })).toEqual({ name: 'Docs' });
  });
});

describe('FR-RAG-002 FR-RAG-003 KbDocument', () => {
  it('declares the ingestion stages in pipeline order, then the two endings (Arch §21.3)', () => {
    expect([...KB_DOCUMENT_STATUSES]).toEqual([
      'pending',
      'parsing',
      'chunking',
      'embedding',
      'ready',
      'failed',
    ]);
  });

  it('settles a document only at ready or failed', () => {
    expect(KB_DOCUMENT_STATUSES.filter(isKbDocumentSettled)).toEqual(['ready', 'failed']);
  });

  it('parses a ready document', () => {
    expect(KbDocumentSchema.parse(document)).toEqual(document);
  });

  it('TC-RAG-003 carries a failed document with its reason', () => {
    const failed = {
      ...document,
      status: 'failed',
      chunkCount: 0,
      ingestedAt: undefined,
      error: 'The PDF is damaged: no cross-reference table was found.',
    };
    expect(KbDocumentSchema.parse(failed)).toEqual(failed);
    expect(KbDocumentSchema.safeParse({ ...failed, error: '' }).success).toBe(false);
  });

  it('records the ingestion PII verdict by type, without a node run (§2.3, FR-GRD-014)', () => {
    const verdict = {
      id: KB_CHUNK_ID_2,
      point: 'context',
      checkType: 'pii',
      action: 'redact',
      passed: false,
      reason: 'Personal data was redacted before chunking.',
      redactedTypes: ['email', 'phone'],
      at: NOW,
    };
    expect(KbDocumentSchema.parse({ ...document, verdicts: [verdict] }).verdicts).toEqual([
      verdict,
    ]);
    expect(
      KbDocumentSchema.safeParse({ ...document, verdicts: [{ ...verdict, nodeRunId: KB_ID }] })
        .success,
      'ingestion runs no node',
    ).toBe(false);
    expect(
      KbDocumentSchema.safeParse({
        ...document,
        verdicts: [{ ...verdict, redactedTypes: ['ada@example.com'] }],
      }).success,
      'a type, never the value',
    ).toBe(false);
  });

  it('refuses a status outside the pipeline, and bytes of any name (BR-02)', () => {
    expect(KbDocumentSchema.safeParse({ ...document, status: 'indexed' }).success).toBe(false);
    expect(KbDocumentSchema.safeParse({ ...document, bytes: 'JVBERi0x' }).success).toBe(false);
  });

  it('adds a document by artifact id alone (§2.9)', () => {
    expect(AddKbDocumentRequestSchema.parse({ artifactId: ARTIFACT_ID })).toEqual({
      artifactId: ARTIFACT_ID,
    });
    expect(AddKbDocumentRequestSchema.safeParse({}).success).toBe(false);
    expect(
      AddKbDocumentRequestSchema.safeParse({ artifactId: ARTIFACT_ID, text: 'inline' }).success,
    ).toBe(false);
  });
});

describe('§2.1 KbChunk', () => {
  it('parses a chunk with its source and heading path', () => {
    expect(KbChunkSchema.parse(chunk)).toEqual(chunk);
  });

  it('allows a chunk above the first heading, with no heading path', () => {
    expect(KbChunkSchema.safeParse({ ...chunk, headings: [] }).success).toBe(true);
  });

  it('requires a source, an ordinal from 0 and at least one token', () => {
    expect(KbChunkSchema.safeParse({ ...chunk, source: '' }).success).toBe(false);
    expect(KbChunkSchema.safeParse({ ...chunk, ordinal: -1 }).success).toBe(false);
    expect(KbChunkSchema.safeParse({ ...chunk, tokens: 0 }).success).toBe(false);
  });
});

describe('FR-RAG-004 FR-RAG-008 search', () => {
  it('defaults k to 5 and the mode to hybrid (§2.1)', () => {
    expect(SearchRequestSchema.parse({ query: 'zephyrine-protocol-7' })).toEqual({
      query: 'zephyrine-protocol-7',
      k: 5,
      mode: 'hybrid',
    });
  });

  it('bounds k to whole numbers 1..20 and refuses an empty query', () => {
    expect(SearchRequestSchema.safeParse({ query: 'q', k: 20 }).success).toBe(true);
    for (const k of [0, 21, 2.5]) {
      expect(SearchRequestSchema.safeParse({ query: 'q', k }).success, `${k}`).toBe(false);
    }
    expect(SearchRequestSchema.safeParse({ query: '' }).success).toBe(false);
  });

  it('searches in the three modes the Retrieval node offers too', () => {
    expect([...SEARCH_MODES]).toEqual(['hybrid', 'vector', 'keyword']);
    for (const mode of SEARCH_MODES) {
      expect(SearchRequestSchema.safeParse({ query: 'q', mode }).success).toBe(true);
      expect(RetrievalConfigSchema.safeParse({ k: 5, mode }).success).toBe(true);
    }
    expect(SearchRequestSchema.safeParse({ query: 'q', mode: 'semantic' }).success).toBe(false);
  });

  it('bounds SearchHit.score to 0..1 (§3)', () => {
    for (const score of [0, 0.25, 1]) {
      expect(SearchHitSchema.safeParse({ ...hit, score }).success, `${score}`).toBe(true);
    }
    for (const score of [-0.01, 1.01, 16.4]) {
      expect(SearchHitSchema.safeParse({ ...hit, score }).success, `${score}`).toBe(false);
    }
  });

  it('records which arm found a hit: vector, keyword or both', () => {
    expect([...SEARCH_VIAS]).toEqual(['vector', 'keyword', 'both']);
    expect(SearchHitSchema.safeParse({ ...hit, via: 'fts' }).success).toBe(false);
  });

  it('answers the hits with the time the search took', () => {
    const response = { hits: [hit], tookMs: 3.4 };
    expect(SearchResponseSchema.parse(response)).toEqual(response);
    expect(SearchResponseSchema.safeParse({ hits: [hit] }).success).toBe(false);
  });

  it('FR-RAG-007 records a used source on a node run with its document and score', () => {
    const source = { chunkId: KB_CHUNK_ID, documentId: KB_DOCUMENT_ID, score: 1, source: 'a#b' };
    expect(NodeRunSourceSchema.parse(source)).toEqual(source);
    expect(NodeRunSourceSchema.safeParse({ ...source, score: 2 }).success).toBe(false);
    expect(NodeRunSourceSchema.safeParse({ ...source, text: 'x' }).success).toBe(false);
  });
});

describe('§2.1 reciprocal-rank fusion', () => {
  it('uses 60 as the rank constant §2.1 writes', () => {
    expect(RRF_K).toBe(60);
  });

  it('scores rank 1 in both lists as 1, and rank 1 in one list as one half', () => {
    expect(fuseRankings(['a'], ['a'])).toEqual([{ chunkId: 'a', score: 1, via: 'both' }]);
    expect(fuseRankings(['a'], [])).toEqual([{ chunkId: 'a', score: 0.5, via: 'vector' }]);
    expect(fuseRankings([], ['a'])).toEqual([{ chunkId: 'a', score: 0.5, via: 'keyword' }]);
  });

  it('is Σ 1/(60 + rank) normalised by its maximum, 2/61', () => {
    const [fused] = fuseRankings(['x', 'a'], ['a']);
    const raw = 1 / (RRF_K + 2) + 1 / (RRF_K + 1);

    expect(fused?.chunkId).toBe('a');
    expect(fused?.score).toBeCloseTo(raw / (2 / (RRF_K + 1)), 12);
  });

  it('puts what both arms found above what either found alone', () => {
    const fused = fuseRankings(['v1', 'shared'], ['k1', 'shared']);

    expect(fused.map((f) => [f.chunkId, f.via])).toEqual([
      ['shared', 'both'],
      ['v1', 'vector'],
      ['k1', 'keyword'],
    ]);
  });

  it('keeps every score in 0..1 and the list best first', () => {
    const vector = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const keyword = [...vector].reverse();
    const fused = fuseRankings(vector, keyword);

    for (const { score } of fused) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    const scores = fused.map((f) => f.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('breaks ties by vector order, then keyword order, so the result is deterministic', () => {
    expect(fuseRankings(['a', 'b'], []).map((f) => f.chunkId)).toEqual(['a', 'b']);
    expect(fuseRankings(['a'], ['b']).map((f) => f.chunkId)).toEqual(['a', 'b']);
    expect(fuseRankings(['b'], ['a']).map((f) => f.chunkId)).toEqual(['b', 'a']);
  });

  it('counts a chunk listed twice in one arm at its best rank only', () => {
    expect(fuseRankings(['a', 'a'], [])).toEqual([{ chunkId: 'a', score: 0.5, via: 'vector' }]);
  });

  it('turns two empty lists into no hits', () => {
    expect(fuseRankings([], [])).toEqual([]);
  });

  it('produces scores a SearchHit accepts', () => {
    for (const { chunkId, score, via } of fuseRankings(
      [KB_CHUNK_ID, KB_CHUNK_ID_3],
      [KB_CHUNK_ID],
    )) {
      expect(SearchHitSchema.safeParse({ ...hit, chunkId, score, via }).success).toBe(true);
    }
  });
});
