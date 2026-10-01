import type { Scope } from './scope.js';

export interface KeywordRecord {
  chunkId: string;
  documentId: string;
  knowledgeBaseId: string;
  text: string;
}

export interface KeywordMatch {
  chunkId: string;
  /** The negated bm25 rank, so higher is better. */
  score: number;
}

/**
 * Keyword search (Arch §7: FTS5 locally, Postgres FTS when hosted).
 * Every record and query is narrowed to one knowledge base (round 5, F2).
 */
export interface KeywordIndex {
  index(scope: Scope, records: KeywordRecord[]): Promise<void>;
  search(scope: Scope, knowledgeBaseId: string, query: string, k: number): Promise<KeywordMatch[]>;
  deleteByDocument(scope: Scope, documentId: string): Promise<void>;
  deleteByKnowledgeBase(scope: Scope, knowledgeBaseId: string): Promise<void>;
}
