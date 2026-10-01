import type { Scope } from './scope.js';

export interface VectorRecord {
  chunkId: string;
  documentId: string;
  knowledgeBaseId: string;
  embedding: number[];
}

export interface VectorMatch {
  chunkId: string;
  /** Cosine similarity, higher is better. */
  score: number;
}

/**
 * Embedding search (Arch §7: sqlite-vec locally, pgvector when hosted).
 * Every record and query is narrowed to one knowledge base (round 5, F2).
 */
export interface VectorIndex {
  upsert(scope: Scope, records: VectorRecord[]): Promise<void>;
  query(
    scope: Scope,
    knowledgeBaseId: string,
    embedding: number[],
    k: number,
  ): Promise<VectorMatch[]>;
  deleteByDocument(scope: Scope, documentId: string): Promise<void>;
  deleteByKnowledgeBase(scope: Scope, knowledgeBaseId: string): Promise<void>;
}
