import type { Scope } from './scope.js';

export interface VectorRecord {
  chunkId: string;
  documentId: string;
  embedding: number[];
}

export interface VectorMatch {
  chunkId: string;
  score: number;
}

/**
 * Embedding search (Arch §7: sqlite-vec locally, pgvector when hosted).
 * Interface only this round — knowledge bases arrive in round 5.
 */
export interface VectorIndex {
  upsert(scope: Scope, records: VectorRecord[]): Promise<void>;
  query(scope: Scope, embedding: number[], k: number): Promise<VectorMatch[]>;
  deleteByDocument(scope: Scope, documentId: string): Promise<void>;
}
