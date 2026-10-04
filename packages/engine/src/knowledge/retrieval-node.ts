import {
  DEFAULT_SEARCH_MODE,
  type NodeError,
  type NodeRunSource,
  type Part,
  type RetrievalConfig,
  type SearchHit,
} from '@ace/contracts';

import { classifyError } from '../errors/index.js';
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
 *
 * A failure carries a typed `NodeError` beside its reason, so the node run records the right state:
 * no base chosen, or a base deleted mid-run, is BLOCKED `missing_knowledge_base` exactly as for an
 * agent's implicit retrieval; no text to search for is BLOCKED like any node its graph starved
 * (FR-ERR-006); anything else is classified by the engine's one classifier (FR-ERR-001).
 */

export type RetrievalNodeOutcome =
  | { ok: true; parts: Part[]; sources: NodeRunSource[] }
  | { ok: false; reason: string; error: NodeError };

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

const failure = (error: NodeError): RetrievalNodeOutcome => ({
  ok: false,
  reason: error.message,
  error,
});

export async function runRetrievalNode(
  config: RetrievalConfig,
  reads: readonly Part[],
  search: SearchService,
): Promise<RetrievalNodeOutcome> {
  if (config.knowledgeBaseId === undefined) {
    // Pre-flight's `missing_knowledge_base` should have stopped the run; this is the second lock.
    return failure({
      kind: 'invalid_config',
      code: 'missing_knowledge_base',
      message: 'No knowledge base is chosen for this Retrieval node.',
      retryable: false,
    });
  }

  const query = queryOf(reads);
  if (query.trim() === '') {
    return failure({
      kind: 'workflow',
      code: 'retrieval_query_empty',
      message: 'The Retrieval node received no text to search for.',
      retryable: false,
    });
  }

  try {
    const { hits } = await search.search(config.knowledgeBaseId, {
      query,
      k: config.k,
      mode: config.mode ?? DEFAULT_SEARCH_MODE,
    });
    return { ok: true, parts: [{ type: 'json', value: { hits } }], sources: hits.map(sourceOf) };
  } catch (error) {
    // `KnowledgeBaseMissingError` carries its own `NodeError`, which the classifier believes.
    return failure(classifyError(error));
  }
}
