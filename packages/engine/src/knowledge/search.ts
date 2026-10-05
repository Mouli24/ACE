import {
  fuseRankings,
  type Id,
  type KnowledgeBase,
  type NodeError,
  type SearchHit,
  type SearchRequest,
  type SearchResponse,
} from '@ace/contracts';

import { CHARS_PER_TOKEN } from '../envelopes/index.js';
import type {
  EmbedderFor,
  KbChunkRepository,
  KeywordIndex,
  KnowledgeBaseRepository,
  Scope,
  VectorIndex,
} from '../ports/index.js';

/**
 * Hybrid search over one knowledge base (round 5 §2.1, FR-RAG-004, Arch §12.6).
 *
 * Two arms, each narrowed to the base (F2): the vector arm embeds the query with the base's own
 * embedder — a base's vectors only compare with vectors from the model that made them — and asks
 * the `VectorIndex` for its top `k`; the keyword arm asks the `KeywordIndex` (FTS5) for its top `k`.
 * The two ranked lists are fused by `fuseRankings` from the contract (D231), so the engine and the
 * web app's mocks score alike, and the fused list is cut to `k`. `mode` picks the arms: `keyword`
 * never embeds anything, `vector` never touches FTS.
 *
 * The indexes answer chunk ids; the text and source a hit carries come from `KbChunkRepository`, so
 * a hit always shows the stored chunk rather than whatever an index happens to keep. An index entry
 * whose chunk is gone (deleted between the two reads) is skipped, not reported as a failure.
 *
 * A query is cut to the base's chunk size first — `chunkSize × CHARS_PER_TOKEN` characters, from the
 * start (final-review M5). An implicit retrieval or a Retrieval node searches with a node's whole
 * reads, which can run to thousands of tokens, and a real embedder refuses an input that long; a
 * base's embedder is sized for its chunks, so that is what both arms are given.
 */

export interface SearchOptions {
  /**
   * The run's abort signal, when a node run searches (13a review m3): once it is aborted the search
   * stops where it is and rejects with its reason, an `AbortError` — a Stop never waits for an
   * embedding to finish. Absent (the search route), the search runs to the end.
   */
  signal?: AbortSignal;
}

export interface SearchService {
  search(kbId: Id, req: SearchRequest, options?: SearchOptions): Promise<SearchResponse>;
}

/**
 * `work`, unless the signal aborts first: then its reason, at once. The work itself is left to
 * finish on its own — an embedder has no way to be told — and whatever it answers is ignored.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The base a search names does not exist. It carries the `NodeError` pre-flight would have raised
 * (`missing_knowledge_base`, `invalid_config`), so a node whose base was deleted mid-run is BLOCKED
 * the same way (`nodeErrorOf` reads it), and a route can answer 404 by type.
 */
export class KnowledgeBaseMissingError extends Error {
  override readonly name = 'KnowledgeBaseMissingError';
  readonly nodeError: NodeError;

  constructor(readonly knowledgeBaseId: Id) {
    super(`Knowledge base ${knowledgeBaseId} does not exist.`);
    this.nodeError = {
      kind: 'invalid_config',
      code: 'missing_knowledge_base',
      message: `The knowledge base ${knowledgeBaseId} no longer exists.`,
      retryable: false,
    };
  }
}

export interface SearchServiceDeps {
  scope: Scope;
  knowledgeBases: Pick<KnowledgeBaseRepository, 'get'>;
  chunks: Pick<KbChunkRepository, 'getMany'>;
  vectors: Pick<VectorIndex, 'query'>;
  keywords: Pick<KeywordIndex, 'search'>;
  /** The base's own embedder (F1): the model rides the base, never a global setting. */
  embedderFor: EmbedderFor;
  /** Milliseconds, for `tookMs`. Defaults to `Date.now`. */
  clock?: () => number;
}

/** Best first. The ports promise higher-is-better scores, not an order, so the order is made here. */
function rankedIds(matches: readonly { chunkId: string; score: number }[]): string[] {
  return [...matches].sort((a, b) => b.score - a.score).map((match) => match.chunkId);
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const { scope } = deps;
  const clock = deps.clock ?? Date.now;

  async function vectorRanking(
    kb: KnowledgeBase,
    req: SearchRequest,
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    const embedder = await deps.embedderFor(kb);
    signal?.throwIfAborted();
    const [embedding] = await untilAborted(embedder.embed([req.query]), signal);
    if (embedding === undefined) {
      throw new Error(`The embedder for "${kb.name}" returned no vector for the query.`);
    }
    return rankedIds(await deps.vectors.query(scope, kb.id, embedding, req.k));
  }

  async function keywordRanking(kb: KnowledgeBase, req: SearchRequest): Promise<string[]> {
    return rankedIds(await deps.keywords.search(scope, kb.id, req.query, req.k));
  }

  return {
    async search(kbId, req, options = {}) {
      const { signal } = options;
      signal?.throwIfAborted();
      const started = clock();

      const kb = await deps.knowledgeBases.get(scope, kbId);
      if (kb === null) throw new KnowledgeBaseMissingError(kbId);
      signal?.throwIfAborted();

      const fitted: SearchRequest = {
        ...req,
        query: req.query.slice(0, kb.chunkSize * CHARS_PER_TOKEN),
      };
      const [vectorIds, keywordIds] = await Promise.all([
        fitted.mode === 'keyword' ? [] : vectorRanking(kb, fitted, signal),
        fitted.mode === 'vector' ? [] : keywordRanking(kb, fitted),
      ]);
      signal?.throwIfAborted();

      const fused = fuseRankings(vectorIds, keywordIds).slice(0, req.k);
      const chunks = await deps.chunks.getMany(
        scope,
        fused.map((rank) => rank.chunkId),
      );
      const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));

      const hits: SearchHit[] = fused.flatMap((rank) => {
        const chunk = byId.get(rank.chunkId);
        if (chunk === undefined) return [];
        return [
          {
            chunkId: chunk.id,
            documentId: chunk.documentId,
            text: chunk.text,
            score: rank.score,
            source: chunk.source,
            via: rank.via,
          },
        ];
      });

      return { hits, tookMs: Math.max(0, clock() - started) };
    },
  };
}
