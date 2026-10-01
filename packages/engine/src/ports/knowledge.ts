import type {
  BackupImportResponse,
  HealthMetrics,
  Id,
  KbChunk,
  KbDocument,
  KbDocumentVerdict,
  KnowledgeBase,
  MemoryEntry,
  Timestamp,
  Usage,
  UsageQuery,
  UsageResponse,
} from '@ace/contracts';

import type { Scope } from './scope.js';

/**
 * The round 5 ports (Arch §7, §12.8, §21.3): ingestion, knowledge-base storage, agent memory, the
 * summary cache, usage read models and backup. Interfaces only — `packages/context` implements the
 * parser, chunker and embedder, `packages/storage-local` the repositories and `BackupStore`.
 */

/** Bumped when the summarisation prompt changes, so a cached summary is never served stale. */
export const SUMMARY_PROMPT_VERSION = 'ace-summary-1';

/* -------------------------------------------------------------------------- */
/* Ingestion                                                                   */
/* -------------------------------------------------------------------------- */

export interface ParsedHeading {
  level: number;
  title: string;
  offset: number;
}

export interface ParsedDocument {
  text: string;
  headings: ParsedHeading[];
}

export interface DocumentParser {
  /** Throws an Error whose `name` is 'ParseError' and whose `message` is the human reason (FR-RAG-003). */
  parse(input: { bytes: Uint8Array; mime: string; name: string }): Promise<ParsedDocument>;
}

export type ChunkKind = 'prose' | 'code';

export interface ChunkDraft {
  ordinal: number;
  text: string;
  tokens: number;
  source: string;
  headings: string[];
}

export interface Chunker {
  chunk(input: {
    document: ParsedDocument;
    documentName: string;
    kind: ChunkKind;
    chunkSize: number;
    chunkOverlap: number;
  }): ChunkDraft[];
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export type EmbedderFor = (kb: KnowledgeBase) => Promise<Embedder>;

/**
 * The ingestion-time context checks (round 5 §2.3, F6): the PII check and hidden-instruction
 * stripping over a document's full text before it is chunked. Implemented where the guardrail
 * engine lives; `blocked` carries the reason when the text must not be ingested.
 */
export type ContextTextCheck = (input: {
  projectId: Id;
  text: string;
}) => Promise<{ text: string; verdicts: KbDocumentVerdict[]; blocked?: string }>;

/* -------------------------------------------------------------------------- */
/* Knowledge-base storage                                                      */
/* -------------------------------------------------------------------------- */

export interface KnowledgeBaseRepository {
  insert(scope: Scope, kb: KnowledgeBase): Promise<KnowledgeBase>;
  get(scope: Scope, id: Id): Promise<KnowledgeBase | null>;
  listByProject(scope: Scope, projectId: Id): Promise<KnowledgeBase[]>;
  update(
    scope: Scope,
    id: Id,
    patch: Partial<
      Pick<
        KnowledgeBase,
        'name' | 'chunkSize' | 'chunkOverlap' | 'documentCount' | 'chunkCount' | 'updatedAt'
      >
    >,
  ): Promise<KnowledgeBase | null>;
  /** Cascades documents, chunks, kb_vectors and both indexes. */
  delete(scope: Scope, id: Id): Promise<void>;
}

export interface KbDocumentRepository {
  insert(scope: Scope, doc: KbDocument): Promise<KbDocument>;
  get(scope: Scope, id: Id): Promise<KbDocument | null>;
  /** `{ items }` at the route. */
  listByKnowledgeBase(scope: Scope, knowledgeBaseId: Id): Promise<KbDocument[]>;
  /** Status not ready/failed — F7. */
  listUnsettled(scope: Scope): Promise<KbDocument[]>;
  update(
    scope: Scope,
    id: Id,
    patch: Partial<Pick<KbDocument, 'status' | 'chunkCount' | 'ingestedAt' | 'verdicts'> & {
        /** `null` clears a previous error once the document is ready again (D72). */
        error: string | null;
      }
    >,
  ): Promise<KbDocument | null>;
  /** Chunks, vectors and fts rows too. */
  delete(scope: Scope, id: Id): Promise<void>;
}

export interface KbChunkRepository {
  /** One transaction: delete the document's old chunks/vectors/fts rows, write the new ones (§4 item 4). */
  replaceForDocument(
    scope: Scope,
    documentId: Id,
    chunks: KbChunk[],
    embeddings: number[][],
  ): Promise<void>;
  getMany(scope: Scope, ids: readonly Id[]): Promise<KbChunk[]>;
  countByKnowledgeBase(scope: Scope, knowledgeBaseId: Id): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* Memory, summary cache, usage                                                */
/* -------------------------------------------------------------------------- */

export interface MemoryRepository {
  /** Oldest first (createdAt, id). */
  list(scope: Scope, nodeId: Id): Promise<MemoryEntry[]>;
  upsert(
    scope: Scope,
    nodeId: Id,
    key: string,
    value: string,
    at: Timestamp,
    newId: () => Id,
  ): Promise<MemoryEntry>;
  deleteKey(scope: Scope, nodeId: Id, key: string): Promise<boolean>;
  deleteEntry(scope: Scope, nodeId: Id, entryId: Id): Promise<MemoryEntry | null>;
  /** Returns what was removed. */
  clear(scope: Scope, nodeId: Id): Promise<MemoryEntry[]>;
  markUsed(scope: Scope, ids: readonly Id[], at: Timestamp): Promise<void>;
}

export interface SummaryCacheRepository {
  /** Touches last_used_at; an expired (30 d) entry is null. */
  get(scope: Scope, key: string, at: Timestamp): Promise<string | null>;
  /** Prunes to 5,000 rows (LRU). */
  put(scope: Scope, key: string, summary: string, at: Timestamp): Promise<void>;
}

export interface UsageRepository {
  /** D234 semantics. */
  aggregate(scope: Scope, query: UsageQuery): Promise<UsageResponse>;
  dayTotals(scope: Scope, day: string): Promise<Usage>;
  /** F10. */
  healthCounts(scope: Scope): Promise<HealthMetrics>;
}

/* -------------------------------------------------------------------------- */
/* Backup                                                                      */
/* -------------------------------------------------------------------------- */

export interface BackupStore {
  /** A zip: `ace.sqlite` (VACUUM INTO snapshot), `blobs/**`, `settings.json`, `backup.json` manifest. */
  exportZip(): Promise<Uint8Array>;
  /** F12. Throws `BackupFormatError` (name) on a zip that is not an ACE backup, before touching anything. */
  importZip(bytes: Uint8Array): Promise<BackupImportResponse['restored']>;
  /** Returns the path written. */
  writePreImportBackup(): Promise<string>;
}
