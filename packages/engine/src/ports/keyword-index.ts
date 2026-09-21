import type { Scope } from './scope.js';

export interface KeywordRecord {
  chunkId: string;
  documentId: string;
  text: string;
}

export interface KeywordMatch {
  chunkId: string;
  score: number;
}

/**
 * Keyword search (Arch §7: FTS5 locally, Postgres FTS when hosted).
 * Interface only this round — knowledge bases arrive in round 5.
 */
export interface KeywordIndex {
  index(scope: Scope, records: KeywordRecord[]): Promise<void>;
  search(scope: Scope, query: string, k: number): Promise<KeywordMatch[]>;
  deleteByDocument(scope: Scope, documentId: string): Promise<void>;
}
