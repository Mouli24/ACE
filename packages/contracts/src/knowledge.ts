import { z } from 'zod';

import {
  DEFAULT_SEARCH_K,
  DEFAULT_SEARCH_MODE,
  IdSchema,
  SearchKSchema,
  SearchModeSchema,
  TimestampSchema,
} from './graph.js';
import { VerdictSchema } from './guardrails.js';

/**
 * Knowledge bases, their documents and chunks, and search (round 5 §2.1, FR-RAG-001..009,
 * Arch §12.6, §15.1, §21.3).
 *
 * A knowledge base belongs to a project and records the embedding model its vectors were made
 * with. A document is an uploaded artifact going through the ingestion pipeline — parse, PII, chunk,
 * embed — and a chunk is one indexed piece of it. Every body here is strict, as rounds 3 and 4's
 * are (D122): a chunk's text reaches a prompt only as an untrusted retrieved block (BR-13), and a
 * key the contract does not name is drift on the one seam that carries it.
 */

/* -------------------------------------------------------------------------- */
/* Knowledge base (§2.1, FR-RAG-001)                                           */
/* -------------------------------------------------------------------------- */

export const KNOWLEDGE_BASE_NAME_MAX = 80;
export const KnowledgeBaseNameSchema = z.string().min(1).max(KNOWLEDGE_BASE_NAME_MAX);

/** Chunk size in tokens (§2.1). Arch §12.6 aims at ~500–800; 700 sits inside it. */
export const CHUNK_SIZE_MIN = 200;
export const CHUNK_SIZE_MAX = 2000;
export const DEFAULT_CHUNK_SIZE = 700;
export const ChunkSizeSchema = z.number().int().min(CHUNK_SIZE_MIN).max(CHUNK_SIZE_MAX);

/** Overlap in tokens (§2.1). 90 of 700 is ~13 %, inside Arch §12.6's 10–15 %. */
export const CHUNK_OVERLAP_MIN = 0;
export const CHUNK_OVERLAP_MAX = 400;
export const DEFAULT_CHUNK_OVERLAP = 90;
export const ChunkOverlapSchema = z.number().int().min(CHUNK_OVERLAP_MIN).max(CHUNK_OVERLAP_MAX);

const OVERLAP_MESSAGE = 'chunk overlap must be smaller than the chunk size';

/**
 * A window that overlapped by its whole size would never advance, so the overlap is always the
 * smaller of the two. Checked wherever both are known at once.
 */
const overlapFits = (kb: { chunkSize?: number; chunkOverlap?: number }): boolean =>
  kb.chunkSize === undefined || kb.chunkOverlap === undefined || kb.chunkOverlap < kb.chunkSize;

export const KnowledgeBaseSchema = z
  .strictObject({
    id: IdSchema,
    projectId: IdSchema,
    name: KnowledgeBaseNameSchema,
    /** The embedder is fixed for the life of the base: its vectors only compare with their own. */
    embeddingProviderId: IdSchema,
    embeddingModelId: z.string().min(1),
    chunkSize: ChunkSizeSchema,
    chunkOverlap: ChunkOverlapSchema,
    documentCount: z.number().int().min(0),
    chunkCount: z.number().int().min(0),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .refine(overlapFits, { message: OVERLAP_MESSAGE, path: ['chunkOverlap'] });
export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;

/** `POST /projects/:id/knowledge-bases` → `KnowledgeBase` (§2.9, FR-RAG-001). */
export const CreateKnowledgeBaseRequestSchema = z
  .strictObject({
    name: KnowledgeBaseNameSchema,
    embeddingProviderId: IdSchema,
    embeddingModelId: z.string().min(1),
    chunkSize: ChunkSizeSchema.default(DEFAULT_CHUNK_SIZE),
    chunkOverlap: ChunkOverlapSchema.default(DEFAULT_CHUNK_OVERLAP),
  })
  .refine(overlapFits, { message: OVERLAP_MESSAGE, path: ['chunkOverlap'] });
export type CreateKnowledgeBaseRequest = z.infer<typeof CreateKnowledgeBaseRequestSchema>;

/**
 * `PATCH /knowledge-bases/:id` → `KnowledgeBase`. The embedder cannot change — a base whose vectors
 * came from two models cannot be searched — so it is not here: create a new base instead. New chunk
 * settings apply to documents ingested afterwards, and to every document on a reindex (FR-RAG-009).
 * When a patch names only one of the two, the engine checks the overlap against the stored size.
 */
export const UpdateKnowledgeBaseRequestSchema = z
  .strictObject({
    name: KnowledgeBaseNameSchema.optional(),
    chunkSize: ChunkSizeSchema.optional(),
    chunkOverlap: ChunkOverlapSchema.optional(),
  })
  .refine(overlapFits, { message: OVERLAP_MESSAGE, path: ['chunkOverlap'] });
export type UpdateKnowledgeBaseRequest = z.infer<typeof UpdateKnowledgeBaseRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Documents (§2.1, FR-RAG-002, 003, 009, Arch §21.3)                          */
/* -------------------------------------------------------------------------- */

/** The ingestion stages in pipeline order, then the two endings (§2.1, Arch §21.3). */
export const KB_DOCUMENT_STATUSES = [
  'pending',
  'parsing',
  'chunking',
  'embedding',
  'ready',
  'failed',
] as const;
export const KbDocumentStatusSchema = z.enum(KB_DOCUMENT_STATUSES);
export type KbDocumentStatus = z.infer<typeof KbDocumentStatusSchema>;

/** A document is done when it is `ready` or `failed`; every other status is still in the pipeline. */
export const TERMINAL_KB_DOCUMENT_STATUSES = [
  'ready',
  'failed',
] as const satisfies readonly KbDocumentStatus[];

export const isKbDocumentSettled = (status: KbDocumentStatus): boolean =>
  (TERMINAL_KB_DOCUMENT_STATUSES as readonly KbDocumentStatus[]).includes(status);

/**
 * A guardrail verdict on a document at ingestion — the PII check over the full text before it is
 * chunked (round 5 §2.3, Arch §21.3). No node run exists at ingestion, so it names none, the way
 * `ChatVerdict` names none (D125). Types only, never the values (FR-GRD-014).
 */
export const KbDocumentVerdictSchema = VerdictSchema.omit({ nodeRunId: true });
export type KbDocumentVerdict = z.infer<typeof KbDocumentVerdictSchema>;

export const KbDocumentSchema = z.strictObject({
  id: IdSchema,
  knowledgeBaseId: IdSchema,
  /** The uploaded file (round 4 §2.1); the document never carries its bytes. */
  artifactId: IdSchema,
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().min(0),
  status: KbDocumentStatusSchema,
  chunkCount: z.number().int().min(0),
  /** Why ingestion failed, in words a user can act on (FR-RAG-003). Set only when `failed`. */
  error: z.string().min(1).optional(),
  /** When the document last reached `ready`. */
  ingestedAt: TimestampSchema.optional(),
  /** The ingestion-time context checks, PII first; absent until they have run. */
  verdicts: z.array(KbDocumentVerdictSchema).optional(),
  createdAt: TimestampSchema,
});
export type KbDocument = z.infer<typeof KbDocumentSchema>;

/** `POST /knowledge-bases/:id/documents` → 202 `KbDocument`, `pending` and queued (§2.9). */
export const AddKbDocumentRequestSchema = z.strictObject({ artifactId: IdSchema });
export type AddKbDocumentRequest = z.infer<typeof AddKbDocumentRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Chunks (§2.1)                                                               */
/* -------------------------------------------------------------------------- */

export const KbChunkSchema = z.strictObject({
  id: IdSchema,
  documentId: IdSchema,
  knowledgeBaseId: IdSchema,
  /** 0-based position within the document. */
  ordinal: z.number().int().min(0),
  text: z.string().min(1),
  tokens: z.number().int().min(1),
  /** `<document name>#<heading or line range>` — always resolvable to a place in the document. */
  source: z.string().min(1),
  /** The heading path the chunk sits under, outermost first; empty above the first heading. */
  headings: z.array(z.string()),
});
export type KbChunk = z.infer<typeof KbChunkSchema>;

/* -------------------------------------------------------------------------- */
/* Search (§2.1, FR-RAG-004, FR-RAG-008)                                       */
/* -------------------------------------------------------------------------- */

/** `POST /knowledge-bases/:id/query` (§2.9). */
export const SearchRequestSchema = z.strictObject({
  query: z.string().min(1),
  k: SearchKSchema.default(DEFAULT_SEARCH_K),
  mode: SearchModeSchema.default(DEFAULT_SEARCH_MODE),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/** Which ranked list a hit came from; `both` when the vector and the keyword arm both found it. */
export const SEARCH_VIAS = ['vector', 'keyword', 'both'] as const;
export const SearchViaSchema = z.enum(SEARCH_VIAS);
export type SearchVia = z.infer<typeof SearchViaSchema>;

/** A normalised relevance score: 1 is the best a search can rank anything. */
export const SearchScoreSchema = z.number().min(0).max(1);

export const SearchHitSchema = z.strictObject({
  chunkId: IdSchema,
  documentId: IdSchema,
  text: z.string(),
  score: SearchScoreSchema,
  source: z.string().min(1),
  via: SearchViaSchema,
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResponseSchema = z.strictObject({
  /** Best first. */
  hits: z.array(SearchHitSchema),
  tookMs: z.number().min(0),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * A chunk a node run's context used, recorded on the node run as `sources` (§2.4, FR-RAG-007) —
 * by a Retrieval node and by an agent's implicit retrieval alike. The inspector's Sources tab lists
 * these, and `chunkId` is the same id the envelope's `context.retrieved` carries.
 */
export const NodeRunSourceSchema = z.strictObject({
  chunkId: IdSchema,
  documentId: IdSchema,
  score: SearchScoreSchema,
  source: z.string().min(1),
});
export type NodeRunSource = z.infer<typeof NodeRunSourceSchema>;

/* -------------------------------------------------------------------------- */
/* Hybrid ranking — reciprocal-rank fusion (§2.1)                              */
/* -------------------------------------------------------------------------- */

/** The `60` of §2.1's `1/(60 + rank)`. */
export const RRF_K = 60;

/** The highest raw fused score there is: rank 1 in both lists. */
const RRF_MAX = 2 / (RRF_K + 1);

export interface FusedRank {
  chunkId: string;
  /** Σ 1/(60 + rank) over the lists that hold the chunk, divided by the most it could be. */
  score: number;
  via: SearchVia;
}

/**
 * Fuse a vector ranking and a keyword ranking (each best first, ranks 1-based) into one list, best
 * first (§2.1, FR-RAG-004). Pure — one definition for the engine's search and for the web app's
 * mocks, the way `messageMatchesQuery` is shared (D52).
 *
 * The score is normalised by the most it could ever be, rank 1 in both lists, so it lands in 0..1
 * and is comparable from one query to the next: a hit only one arm found scores at most 0.5. A mode
 * that runs one arm passes an empty list for the other. A chunk listed twice in one list counts at
 * its best rank. Ties keep vector order, then keyword order, so the result is deterministic.
 */
export function fuseRankings(
  vectorIds: readonly string[],
  keywordIds: readonly string[],
): FusedRank[] {
  const fused = new Map<
    string,
    { raw: number; vector: boolean; keyword: boolean; order: number }
  >();

  const add = (ids: readonly string[], arm: 'vector' | 'keyword'): void => {
    const seen = new Set<string>();
    ids.forEach((chunkId, index) => {
      if (seen.has(chunkId)) return;
      seen.add(chunkId);
      const entry = fused.get(chunkId) ?? {
        raw: 0,
        vector: false,
        keyword: false,
        order: fused.size,
      };
      entry.raw += 1 / (RRF_K + index + 1);
      entry[arm] = true;
      fused.set(chunkId, entry);
    });
  };

  add(vectorIds, 'vector');
  add(keywordIds, 'keyword');

  return [...fused.entries()]
    .sort(([, a], [, b]) => b.raw - a.raw || a.order - b.order)
    .map(([chunkId, { raw, vector, keyword }]) => ({
      chunkId,
      score: Math.min(1, raw / RRF_MAX),
      via: vector && keyword ? 'both' : vector ? 'vector' : 'keyword',
    }));
}
