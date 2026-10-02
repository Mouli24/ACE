import {
  KbChunkSchema,
  KbDocumentSchema,
  KnowledgeBaseSchema,
  MemoryEntrySchema,
  TERMINAL_KB_DOCUMENT_STATUSES,
  type Id,
  type KbChunk,
  type KbDocument,
  type KnowledgeBase,
  type MemoryEntry,
} from '@ace/contracts';
import type {
  KbChunkRepository,
  KbDocumentRepository,
  KnowledgeBaseRepository,
  MemoryRepository,
  Scope,
  SummaryCacheRepository,
} from '@ace/engine';
import type BetterSqlite3 from 'better-sqlite3';
import { and, asc, eq, getTableColumns, inArray, notInArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { VectorStore } from './indexes.js';
import type { InTransaction } from './repository-guardrails.js';
import type * as schema from './schema.js';
import { agentMemory, kbChunks, kbDocuments, knowledgeBases, summaryCache } from './schema.js';
import { assertNoSecrets, toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * The round 5 repositories (Arch §15.3, §21.3): knowledge bases, documents, chunks, agent memory
 * and the summary cache. The usage read models are in `repository-usage.ts`.
 *
 * Split out of `repository.ts` so one file stays one round's worth of tables; `SqliteRepository`
 * composes them. Each behaves as the engine's in-memory `FakeRepository` does, so an engine test
 * and the real store agree. Every JSON column goes through `toJsonColumn` (BR-07).
 */

/** A summary is served for 30 days from when it was written, however often it is read (§2.5). */
export const SUMMARY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `summary_cache` is pruned to this many rows per workspace, least recently used first (§2.5). */
export const SUMMARY_CACHE_MAX_ROWS = 5000;

/* -------------------------------------------------------------------------- */
/* Row <-> domain                                                              */
/* -------------------------------------------------------------------------- */

type KnowledgeBaseRow = typeof knowledgeBases.$inferSelect & {
  documentCount: number;
  chunkCount: number;
};
type KbDocumentRow = typeof kbDocuments.$inferSelect;
type KbChunkRow = typeof kbChunks.$inferSelect;
type MemoryRow = typeof agentMemory.$inferSelect;

function toKnowledgeBase(row: KnowledgeBaseRow): KnowledgeBase {
  return KnowledgeBaseSchema.parse({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    embeddingProviderId: row.embeddingProviderId,
    embeddingModelId: row.embeddingModelId,
    chunkSize: row.chunkSize,
    chunkOverlap: row.chunkOverlap,
    documentCount: row.documentCount,
    chunkCount: row.chunkCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toKbDocument(row: KbDocumentRow): KbDocument {
  return KbDocumentSchema.parse({
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    artifactId: row.artifactId,
    name: row.name,
    mime: row.mime,
    size: row.size,
    status: row.status,
    chunkCount: row.chunkCount,
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.ingestedAt === null ? {} : { ingestedAt: row.ingestedAt }),
    ...(row.verdicts === null ? {} : { verdicts: JSON.parse(row.verdicts) }),
    createdAt: row.createdAt,
  });
}

function toKbChunk(row: KbChunkRow): KbChunk {
  return KbChunkSchema.parse({
    id: row.id,
    documentId: row.documentId,
    knowledgeBaseId: row.knowledgeBaseId,
    ordinal: row.ordinal,
    text: row.text,
    tokens: row.tokens,
    source: row.source,
    headings: JSON.parse(row.headings),
  });
}

function toMemoryEntry(row: MemoryRow): MemoryEntry {
  return MemoryEntrySchema.parse({
    id: row.id,
    nodeId: row.nodeId,
    key: row.key,
    value: row.value,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.lastUsedAt === null ? {} : { lastUsedAt: row.lastUsedAt }),
  });
}

/* -------------------------------------------------------------------------- */
/* Knowledge bases (FR-RAG-001)                                                */
/* -------------------------------------------------------------------------- */

/** One base's chunks, vectors (both stores) and documents — the cascade a delete runs. */
function deleteKnowledgeBaseContents(
  db: Db,
  vectors: VectorStore,
  scope: Scope,
  knowledgeBaseId: Id,
): void {
  vectors.deleteWhere(scope, 'knowledge_base_id', knowledgeBaseId);
  // The FTS delete trigger takes each chunk's index rows with it.
  db.delete(kbChunks)
    .where(
      and(
        eq(kbChunks.workspaceId, scope.workspaceId),
        eq(kbChunks.knowledgeBaseId, knowledgeBaseId),
      ),
    )
    .run();
  db.delete(kbDocuments)
    .where(
      and(
        eq(kbDocuments.workspaceId, scope.workspaceId),
        eq(kbDocuments.knowledgeBaseId, knowledgeBaseId),
      ),
    )
    .run();
}

/** One document's chunks and vectors; the FTS rows go with the chunks. */
function deleteDocumentContents(db: Db, vectors: VectorStore, scope: Scope, documentId: Id): void {
  vectors.deleteWhere(scope, 'document_id', documentId);
  db.delete(kbChunks)
    .where(and(eq(kbChunks.workspaceId, scope.workspaceId), eq(kbChunks.documentId, documentId)))
    .run();
}

export function createKnowledgeBaseRepository(
  db: Db,
  inTransaction: InTransaction,
  vectors: VectorStore,
): KnowledgeBaseRepository {
  /**
   * `documentCount` and `chunkCount` are counted from the rows on every read, so they cannot drift
   * from what is stored — which is also why a patch naming them changes nothing.
   */
  // Written out in full: Drizzle renders a column of a single-table select unqualified, and inside
  // the subquery `id` would then mean the document's id, not the base's.
  const selectWithCounts = () =>
    db
      .select({
        ...getTableColumns(knowledgeBases),
        documentCount: sql<number>`(SELECT count(*) FROM kb_documents d WHERE d.workspace_id = "knowledge_bases"."workspace_id" AND d.knowledge_base_id = "knowledge_bases"."id")`,
        chunkCount: sql<number>`(SELECT count(*) FROM kb_chunks c WHERE c.workspace_id = "knowledge_bases"."workspace_id" AND c.knowledge_base_id = "knowledge_bases"."id")`,
      })
      .from(knowledgeBases);

  const read = (scope: Scope, id: Id): KnowledgeBase | null => {
    const row = selectWithCounts()
      .where(and(eq(knowledgeBases.workspaceId, scope.workspaceId), eq(knowledgeBases.id, id)))
      .get();
    return row === undefined ? null : toKnowledgeBase(row);
  };

  return {
    insert: async (scope: Scope, kb: KnowledgeBase) => {
      db.insert(knowledgeBases)
        .values({
          id: kb.id,
          workspaceId: scope.workspaceId,
          projectId: kb.projectId,
          name: kb.name,
          embeddingProviderId: kb.embeddingProviderId,
          embeddingModelId: kb.embeddingModelId,
          chunkSize: kb.chunkSize,
          chunkOverlap: kb.chunkOverlap,
          createdAt: kb.createdAt,
          updatedAt: kb.updatedAt,
        })
        .run();
      return read(scope, kb.id) ?? kb;
    },

    get: async (scope: Scope, id: Id) => read(scope, id),

    listByProject: async (scope: Scope, projectId: Id) =>
      selectWithCounts()
        .where(
          and(
            eq(knowledgeBases.workspaceId, scope.workspaceId),
            eq(knowledgeBases.projectId, projectId),
          ),
        )
        .orderBy(asc(knowledgeBases.id))
        .all()
        .map(toKnowledgeBase),

    update: async (scope: Scope, id: Id, patch) => {
      const values = {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.chunkSize === undefined ? {} : { chunkSize: patch.chunkSize }),
        ...(patch.chunkOverlap === undefined ? {} : { chunkOverlap: patch.chunkOverlap }),
        ...(patch.updatedAt === undefined ? {} : { updatedAt: patch.updatedAt }),
      };
      if (Object.keys(values).length > 0) {
        db.update(knowledgeBases)
          .set(values)
          .where(and(eq(knowledgeBases.workspaceId, scope.workspaceId), eq(knowledgeBases.id, id)))
          .run();
      }
      return read(scope, id);
    },

    /** The base, its documents, chunks, vectors and both indexes, in one transaction. */
    delete: async (scope: Scope, id: Id) =>
      inTransaction(async () => {
        deleteKnowledgeBaseContents(db, vectors, scope, id);
        db.delete(knowledgeBases)
          .where(and(eq(knowledgeBases.workspaceId, scope.workspaceId), eq(knowledgeBases.id, id)))
          .run();
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* Documents (FR-RAG-002, 003, 009, Arch §21.3)                                */
/* -------------------------------------------------------------------------- */

export function createKbDocumentRepository(
  db: Db,
  inTransaction: InTransaction,
  vectors: VectorStore,
): KbDocumentRepository {
  const read = (scope: Scope, id: Id): KbDocument | null => {
    const row = db
      .select()
      .from(kbDocuments)
      .where(and(eq(kbDocuments.workspaceId, scope.workspaceId), eq(kbDocuments.id, id)))
      .get();
    return row === undefined ? null : toKbDocument(row);
  };

  return {
    insert: async (scope: Scope, doc: KbDocument) => {
      db.insert(kbDocuments)
        .values({
          id: doc.id,
          workspaceId: scope.workspaceId,
          knowledgeBaseId: doc.knowledgeBaseId,
          artifactId: doc.artifactId,
          name: doc.name,
          mime: doc.mime,
          size: doc.size,
          status: doc.status,
          chunkCount: doc.chunkCount,
          error: doc.error ?? null,
          ingestedAt: doc.ingestedAt ?? null,
          verdicts:
            doc.verdicts === undefined
              ? null
              : toJsonColumn(doc.verdicts, `kbDocument(${doc.id}).verdicts`),
          createdAt: doc.createdAt,
        })
        .run();
      return doc;
    },

    get: async (scope: Scope, id: Id) => read(scope, id),

    listByKnowledgeBase: async (scope: Scope, knowledgeBaseId: Id) =>
      db
        .select()
        .from(kbDocuments)
        .where(
          and(
            eq(kbDocuments.workspaceId, scope.workspaceId),
            eq(kbDocuments.knowledgeBaseId, knowledgeBaseId),
          ),
        )
        .orderBy(asc(kbDocuments.id))
        .all()
        .map(toKbDocument),

    /** Every document still in the pipeline — what the engine re-queues on start (F7). */
    listUnsettled: async (scope: Scope) =>
      db
        .select()
        .from(kbDocuments)
        .where(
          and(
            eq(kbDocuments.workspaceId, scope.workspaceId),
            notInArray(kbDocuments.status, [...TERMINAL_KB_DOCUMENT_STATUSES]),
          ),
        )
        .orderBy(asc(kbDocuments.id))
        .all()
        .map(toKbDocument),

    update: async (scope: Scope, id: Id, patch) => {
      const values = {
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.chunkCount === undefined ? {} : { chunkCount: patch.chunkCount }),
        ...(patch.ingestedAt === undefined ? {} : { ingestedAt: patch.ingestedAt }),
        ...(patch.verdicts === undefined
          ? {}
          : { verdicts: toJsonColumn(patch.verdicts, `kbDocument(${id}).verdicts`) }),
        // `null` clears a previous error once the document is ready again; `undefined` leaves it (D72).
        ...(patch.error === undefined ? {} : { error: patch.error }),
      };
      if (Object.keys(values).length > 0) {
        db.update(kbDocuments)
          .set(values)
          .where(and(eq(kbDocuments.workspaceId, scope.workspaceId), eq(kbDocuments.id, id)))
          .run();
      }
      return read(scope, id);
    },

    /** The document, its chunks, vectors and FTS rows, in one transaction (FR-RAG-008). */
    delete: async (scope: Scope, id: Id) =>
      inTransaction(async () => {
        deleteDocumentContents(db, vectors, scope, id);
        db.delete(kbDocuments)
          .where(and(eq(kbDocuments.workspaceId, scope.workspaceId), eq(kbDocuments.id, id)))
          .run();
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* Chunks (FR-RAG-002, FR-RAG-009)                                             */
/* -------------------------------------------------------------------------- */

export function createKbChunkRepository(
  db: Db,
  inTransaction: InTransaction,
  vectors: VectorStore,
): KbChunkRepository {
  return {
    /**
     * One transaction (§4 item 4): the document's old chunks, vectors and FTS rows go, the new ones
     * are written — `kb_chunks` (its insert trigger writes the FTS row), `kb_vectors` and the
     * `vec0` row. A throw anywhere rolls the lot back, so a reindex never leaves a document half
     * replaced and a failed ingestion leaves the chunks it had.
     */
    replaceForDocument: async (
      scope: Scope,
      documentId: Id,
      chunks: KbChunk[],
      embeddings: number[][],
    ) => {
      if (chunks.length !== embeddings.length) {
        throw new Error('replaceForDocument needs one embedding per chunk');
      }

      await inTransaction(async () => {
        deleteDocumentContents(db, vectors, scope, documentId);

        for (const chunk of chunks) {
          db.insert(kbChunks)
            .values({
              id: chunk.id,
              workspaceId: scope.workspaceId,
              knowledgeBaseId: chunk.knowledgeBaseId,
              documentId: chunk.documentId,
              ordinal: chunk.ordinal,
              text: chunk.text,
              tokens: chunk.tokens,
              source: chunk.source,
              headings: toJsonColumn(chunk.headings, `kbChunk(${chunk.id}).headings`),
            })
            .run();
        }
        vectors.write(
          scope,
          chunks.map((chunk, index) => ({
            chunkId: chunk.id,
            documentId: chunk.documentId,
            knowledgeBaseId: chunk.knowledgeBaseId,
            embedding: embeddings[index]!,
          })),
        );
      });
    },

    /** In the order asked, skipping ids that are not stored — the order a search ranked them. */
    getMany: async (scope: Scope, ids: readonly Id[]) => {
      if (ids.length === 0) return [];
      const rows = db
        .select()
        .from(kbChunks)
        .where(and(eq(kbChunks.workspaceId, scope.workspaceId), inArray(kbChunks.id, [...ids])))
        .all();
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.flatMap((id) => {
        const row = byId.get(id);
        return row === undefined ? [] : [toKbChunk(row)];
      });
    },

    countByKnowledgeBase: async (scope: Scope, knowledgeBaseId: Id) => {
      const row = db
        .select({ n: sql<number>`count(*)` })
        .from(kbChunks)
        .where(
          and(
            eq(kbChunks.workspaceId, scope.workspaceId),
            eq(kbChunks.knowledgeBaseId, knowledgeBaseId),
          ),
        )
        .get();
      return row?.n ?? 0;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Agent memory (FR-MEM-001..004)                                              */
/* -------------------------------------------------------------------------- */

export function createMemoryRepository(db: Db): MemoryRepository {
  const listOf = (scope: Scope, nodeId: Id): MemoryEntry[] =>
    db
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.workspaceId, scope.workspaceId), eq(agentMemory.nodeId, nodeId)))
      .orderBy(asc(agentMemory.createdAt), asc(agentMemory.id))
      .all()
      .map(toMemoryEntry);

  const byKey = (scope: Scope, nodeId: Id, key: string): MemoryRow | undefined =>
    db
      .select()
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.workspaceId, scope.workspaceId),
          eq(agentMemory.nodeId, nodeId),
          eq(agentMemory.key, key),
        ),
      )
      .get();

  return {
    /** Oldest first (createdAt, then id) — the order entries are injected in (§2.2). */
    list: async (scope: Scope, nodeId: Id) => listOf(scope, nodeId),

    /**
     * A save of a key the node already has replaces the value and keeps the entry's id, creation
     * time and last use (FR-MEM-002). The key and value were written by a model, so they go
     * through the same guard as every other stored text: a credential is refused (BR-07).
     */
    upsert: async (scope: Scope, nodeId: Id, key, value, at, newId) => {
      assertNoSecrets(key, `memory(${nodeId}).key`);
      assertNoSecrets(value, `memory(${nodeId}).${key}`);

      const existing = byKey(scope, nodeId, key);
      if (existing !== undefined) {
        db.update(agentMemory)
          .set({ value, updatedAt: at })
          .where(
            and(eq(agentMemory.workspaceId, scope.workspaceId), eq(agentMemory.id, existing.id)),
          )
          .run();
        return toMemoryEntry({ ...existing, value, updatedAt: at });
      }

      const row: MemoryRow = {
        id: newId(),
        workspaceId: scope.workspaceId,
        nodeId,
        key,
        value,
        createdAt: at,
        updatedAt: at,
        lastUsedAt: null,
      };
      db.insert(agentMemory).values(row).run();
      return toMemoryEntry(row);
    },

    deleteKey: async (scope: Scope, nodeId: Id, key: string) =>
      db
        .delete(agentMemory)
        .where(
          and(
            eq(agentMemory.workspaceId, scope.workspaceId),
            eq(agentMemory.nodeId, nodeId),
            eq(agentMemory.key, key),
          ),
        )
        .run().changes > 0,

    /** Only an entry of this node: the route names both, and a mismatch is not found. */
    deleteEntry: async (scope: Scope, nodeId: Id, entryId: Id) => {
      const row = db
        .select()
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.workspaceId, scope.workspaceId),
            eq(agentMemory.nodeId, nodeId),
            eq(agentMemory.id, entryId),
          ),
        )
        .get();
      if (row === undefined) return null;
      db.delete(agentMemory)
        .where(and(eq(agentMemory.workspaceId, scope.workspaceId), eq(agentMemory.id, entryId)))
        .run();
      return toMemoryEntry(row);
    },

    /** Answers what it removed, oldest first, so the caller can emit one delete op per key. */
    clear: async (scope: Scope, nodeId: Id) => {
      const removed = listOf(scope, nodeId);
      db.delete(agentMemory)
        .where(and(eq(agentMemory.workspaceId, scope.workspaceId), eq(agentMemory.nodeId, nodeId)))
        .run();
      return removed;
    },

    markUsed: async (scope: Scope, ids: readonly Id[], at) => {
      if (ids.length === 0) return;
      db.update(agentMemory)
        .set({ lastUsedAt: at })
        .where(
          and(eq(agentMemory.workspaceId, scope.workspaceId), inArray(agentMemory.id, [...ids])),
        )
        .run();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Summary cache (FR-RAG-010, §2.5)                                            */
/* -------------------------------------------------------------------------- */

export function createSummaryCacheRepository(
  db: Db,
  sqlite: BetterSqlite3.Database,
): SummaryCacheRepository {
  const where = (scope: Scope, key: string) =>
    and(eq(summaryCache.workspaceId, scope.workspaceId), eq(summaryCache.key, key));

  return {
    /**
     * A hit touches `last_used_at`, which orders the LRU prune. The 30 days count from creation,
     * not from the last read — a summary read every day still expires — and an expired row is
     * deleted as it is found.
     */
    get: async (scope: Scope, key: string, at) => {
      const row = db.select().from(summaryCache).where(where(scope, key)).get();
      if (row === undefined) return null;
      if (Date.parse(at) - Date.parse(row.createdAt) > SUMMARY_CACHE_TTL_MS) {
        db.delete(summaryCache).where(where(scope, key)).run();
        return null;
      }
      db.update(summaryCache).set({ lastUsedAt: at }).where(where(scope, key)).run();
      return row.summary;
    },

    /**
     * Writes the entry as new — a re-put restarts its 30 days — then prunes the workspace to
     * 5,000 rows, least recently used first (ties: the older write first, as the fake orders them).
     * A summary is model output, so it goes through the secret guard like every stored text.
     */
    put: async (scope: Scope, key: string, summary: string, at) => {
      assertNoSecrets(summary, `summaryCache(${key})`);
      db.delete(summaryCache).where(where(scope, key)).run();
      db.insert(summaryCache)
        .values({ workspaceId: scope.workspaceId, key, summary, createdAt: at, lastUsedAt: at })
        .run();

      const { n } = sqlite
        .prepare('SELECT count(*) AS n FROM summary_cache WHERE workspace_id = ?')
        .get(scope.workspaceId) as { n: number };
      if (n <= SUMMARY_CACHE_MAX_ROWS) return;
      sqlite
        .prepare(
          `DELETE FROM summary_cache WHERE rowid IN (
             SELECT rowid FROM summary_cache WHERE workspace_id = ?
              ORDER BY last_used_at ASC, rowid ASC LIMIT ?
           )`,
        )
        .run(scope.workspaceId, n - SUMMARY_CACHE_MAX_ROWS);
    },
  };
}
