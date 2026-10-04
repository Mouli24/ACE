import {
  DEFAULT_SEARCH_MODE,
  type NodeRunSource,
  type Part,
  type RetrievalConfig,
  type SearchHit,
} from '@ace/contracts';

import type { SearchService } from './search.js';

/**
 * The Retrieval node (round 5 §2.4, FR-RAG-006, FR-RAG-007).
 *
 * One text query in, `{ hits: SearchHit[] }` out as a single `json` part. The query is the node's
 * text reads joined in order — the same rule an agent's implicit retrieval uses — and the search is
 * the base's own, at the node's `k` and `mode` (`hybrid` when unset). The hits ride on downstream as
 * an ordinary upstream output, so whatever reads them gets them as untrusted reads and the context
 * guardrails judge them there (BR-13); this node only searches.
 *
 * Every hit is recorded as a node-run source (FR-RAG-007), the shape the inspector's Sources tab
 * lists. A search that finds nothing is an answer — `{ hits: [] }` — not a failure.
 */

export type RetrievalNodeOutcome =
  { ok: true; parts: Part[]; sources: NodeRunSource[] } | { ok: false; reason: string };

/** The text reads, joined in order: what an agent's `{{input.text}}` would read, and the query. */
export function queryOf(reads: readonly Part[]): string {
  return reads
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** What a node run records for a hit (FR-RAG-007): the chunk, its document, its score and place. */
export function sourceOf(
  hit: Pick<SearchHit, 'chunkId' | 'documentId' | 'score' | 'source'>,
): NodeRunSource {
  return { chunkId: hit.chunkId, documentId: hit.documentId, score: hit.score, source: hit.source };
}

export async function runRetrievalNode(
  config: RetrievalConfig,
  reads: readonly Part[],
  search: SearchService,
): Promise<RetrievalNodeOutcome> {
  if (config.knowledgeBaseId === undefined) {
    // Pre-flight's `missing_knowledge_base` should have stopped the run; this is the second lock.
    return { ok: false, reason: 'No knowledge base is chosen for this Retrieval node.' };
  }

  const query = queryOf(reads);
  if (query.trim() === '') {
    return { ok: false, reason: 'The Retrieval node received no text to search for.' };
  }

  try {
    const { hits } = await search.search(config.knowledgeBaseId, {
      query,
      k: config.k,
      mode: config.mode ?? DEFAULT_SEARCH_MODE,
    });
    return { ok: true, parts: [{ type: 'json', value: { hits } }], sources: hits.map(sourceOf) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : `The search failed: ${String(error)}`,
    };
  }
}
