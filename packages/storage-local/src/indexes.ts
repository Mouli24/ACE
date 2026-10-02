import type {
  KeywordIndex,
  KeywordMatch,
  KeywordRecord,
  Scope,
  VectorIndex,
  VectorMatch,
  VectorRecord,
} from '@ace/engine';
import type BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * The two search indexes of a knowledge base (Arch §7, §12.6, F8): vectors and keywords.
 *
 * **Vectors.** `kb_vectors` is the table of record — every embedding as Float32 bytes. When the
 * sqlite-vec extension loads, each embedding width also gets a `vec0` virtual table,
 * `kb_vectors_vec_<dims>`, partitioned by knowledge base and measured by cosine distance; a query
 * is a KNN search inside one partition. A `vec0` column has one fixed width and a base's width is
 * its embedding model's, so one table per width is what lets a 768-wide base and a 1536-wide base
 * live side by side. The `vec0` tables are never in a migration, because the extension may be
 * absent: they are created at open, filled from `kb_vectors` when missing or out of step, and
 * rebuilt after an import. Without the extension, `VectorIndex` scans `kb_vectors` exactly.
 *
 * **Keywords.** `kb_chunks_fts` is an FTS5 external-content table over `kb_chunks` (migration
 * `ROUND_5_MIGRATION_ID`), kept in step by triggers, so a chunk's text is stored once and the
 * index can never hold a chunk the table does not. Its content *is* `kb_chunks`, which is why
 * indexing or deleting a keyword record works on the chunk rows.
 *
 * Both are narrowed to one knowledge base on every query (F2) and to the caller's workspace (BR-18).
 */

/** What the open database searches vectors with (F8). */
export type VectorExtension = 'sqlite-vec' | 'scan';

/** The widest embedding a `vec0` column takes. */
export const MAX_VECTOR_DIMS = 8192;

/** sqlite-vec refuses a KNN query for more neighbours than this; the scan honours the same cap. */
export const MAX_VECTOR_K = 4096;

/** The `vec0` table holding every embedding of one width. */
export function vectorTableName(dims: number): string {
  if (!Number.isInteger(dims) || dims < 1 || dims > MAX_VECTOR_DIMS) {
    throw new RangeError(`a vector is 1 to ${MAX_VECTOR_DIMS} numbers wide, not ${dims}`);
  }
  return `kb_vectors_vec_${dims}`;
}

/**
 * Loads sqlite-vec into this connection and answers which vector search it now has. A platform
 * without a build, or a load that fails for any other reason, falls back to the scan rather than
 * failing the open: the open result records `'scan'` and the composition root logs the warning.
 */
export function loadVectorExtension(sqlite: BetterSqlite3.Database): VectorExtension {
  try {
    sqliteVec.load(sqlite);
    return 'sqlite-vec';
  } catch {
    return 'scan';
  }
}

/** Whether sqlite-vec is loaded on this connection — `vec_version()` exists only when it is. */
export function detectVectorExtension(sqlite: BetterSqlite3.Database): VectorExtension {
  try {
    sqlite.prepare('SELECT vec_version()').get();
    return 'sqlite-vec';
  } catch {
    return 'scan';
  }
}

function tableExists(sqlite: BetterSqlite3.Database, name: string): boolean {
  return (
    sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  );
}

/** The `vec0` virtual tables present, by width. Their shadow tables are not `CREATE VIRTUAL`. */
function existingVectorTables(sqlite: BetterSqlite3.Database): Map<number, string> {
  const rows = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name GLOB 'kb_vectors_vec_[0-9]*'
          AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
    )
    .all() as { name: string }[];
  const tables = new Map<number, string>();
  for (const { name } of rows) tables.set(Number(name.slice('kb_vectors_vec_'.length)), name);
  return tables;
}

function createVectorTable(sqlite: BetterSqlite3.Database, dims: number): void {
  sqlite.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${vectorTableName(dims)} USING vec0(
       chunk_id TEXT PRIMARY KEY,
       knowledge_base_id TEXT PARTITION KEY,
       embedding float[${dims}] distance_metric=cosine
     )`,
  );
}

function fillVectorTable(sqlite: BetterSqlite3.Database, dims: number): void {
  sqlite
    .prepare(
      `INSERT INTO ${vectorTableName(dims)} (chunk_id, knowledge_base_id, embedding)
       SELECT chunk_id, knowledge_base_id, embedding FROM kb_vectors WHERE dims = ?`,
    )
    .run(dims);
}

function countRows(sqlite: BetterSqlite3.Database, sql: string, ...params: unknown[]): number {
  return (sqlite.prepare(sql).get(...params) as { n: number }).n;
}

/**
 * Brings the `vec0` tables into step with `kb_vectors` (F8), once sqlite-vec is loaded: a width
 * with no table gets one, filled from `kb_vectors`; a table whose row count differs from its
 * width's — it was written while the extension was absent, say — is rebuilt; and a table whose
 * width no longer has vectors is dropped. A database before round 5 has no `kb_vectors` yet and
 * nothing to do. One transaction, so a failure leaves the tables as they were.
 */
export function ensureVectorTables(sqlite: BetterSqlite3.Database): void {
  if (!tableExists(sqlite, 'kb_vectors')) return;

  sqlite.transaction(() => {
    const widths = (
      sqlite.prepare('SELECT dims, count(*) AS n FROM kb_vectors GROUP BY dims').all() as {
        dims: number;
        n: number;
      }[]
    ).filter(({ dims }) => Number.isInteger(dims) && dims >= 1 && dims <= MAX_VECTOR_DIMS);
    const existing = existingVectorTables(sqlite);

    for (const { dims, n } of widths) {
      const name = existing.get(dims);
      existing.delete(dims);
      if (name !== undefined && countRows(sqlite, `SELECT count(*) AS n FROM ${name}`) === n) {
        continue;
      }
      if (name !== undefined) sqlite.exec(`DROP TABLE ${name}`);
      createVectorTable(sqlite, dims);
      fillVectorTable(sqlite, dims);
    }
    for (const name of existing.values()) sqlite.exec(`DROP TABLE ${name}`);
  })();
}

/** Drops every `vec0` table and builds them again from `kb_vectors` — after an import (F12). */
export function rebuildVectorTables(sqlite: BetterSqlite3.Database): void {
  sqlite.transaction(() => {
    for (const name of existingVectorTables(sqlite).values()) sqlite.exec(`DROP TABLE ${name}`);
  })();
  ensureVectorTables(sqlite);
}

/** Rebuilds the FTS5 index from `kb_chunks` (F12), the documented repair for external content. */
export function rebuildKeywordIndex(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`INSERT INTO kb_chunks_fts (kb_chunks_fts) VALUES ('rebuild')`);
}

/* -------------------------------------------------------------------------- */
/* Vectors                                                                     */
/* -------------------------------------------------------------------------- */

/** Little-endian Float32 bytes — the layout `vec0` reads and `kb_vectors` stores. */
function toFloat32Blob(chunkId: string, embedding: readonly number[]): Buffer {
  const floats = Float32Array.from(embedding);
  if (
    floats.length < 1 ||
    floats.length > MAX_VECTOR_DIMS ||
    !floats.every((value) => Number.isFinite(value))
  ) {
    throw new RangeError(
      `the embedding of chunk ${chunkId} must be 1 to ${MAX_VECTOR_DIMS} finite numbers`,
    );
  }
  return Buffer.from(floats.buffer);
}

/** Copied out, because a blob's offset in its buffer need not be a multiple of four. */
function fromFloat32Blob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/** Cosine similarity, or null when either side has no direction (sqlite-vec answers NULL too). */
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number | null {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  if (aa === 0 || bb === 0) return null;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}

type VectorColumn = 'document_id' | 'knowledge_base_id';

/**
 * The synchronous vector store both `SqliteVectorIndex` and `kbChunks.replaceForDocument` write
 * through, so a chunk's vector reaches `kb_vectors` and its `vec0` table by one code path. Every
 * method assumes the caller has opened the transaction it needs.
 */
export class VectorStore {
  constructor(
    private readonly sqlite: BetterSqlite3.Database,
    readonly mode: VectorExtension,
  ) {}

  /** Writes or replaces each record's vector. Throws on an empty or non-finite embedding. */
  write(scope: Scope, records: readonly VectorRecord[]): void {
    const previous = this.sqlite.prepare('SELECT dims FROM kb_vectors WHERE chunk_id = ?');
    const upsert = this.sqlite.prepare(
      `INSERT OR REPLACE INTO kb_vectors
         (chunk_id, workspace_id, knowledge_base_id, document_id, dims, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const ready = new Set<number>();

    for (const record of records) {
      const blob = toFloat32Blob(record.chunkId, record.embedding);
      const dims = record.embedding.length;

      if (this.mode === 'sqlite-vec') {
        const old = previous.get(record.chunkId) as { dims: number } | undefined;
        if (old !== undefined) this.#deleteFromVectorTable(old.dims, record.chunkId);
      }
      upsert.run(
        record.chunkId,
        scope.workspaceId,
        record.knowledgeBaseId,
        record.documentId,
        dims,
        blob,
      );
      if (this.mode === 'sqlite-vec') {
        if (!ready.has(dims)) {
          createVectorTable(this.sqlite, dims);
          ready.add(dims);
        }
        this.sqlite
          .prepare(
            `INSERT INTO ${vectorTableName(dims)} (chunk_id, knowledge_base_id, embedding)
             VALUES (?, ?, ?)`,
          )
          .run(record.chunkId, record.knowledgeBaseId, blob);
      }
    }
  }

  /** Removes every vector of one document or one base, from `kb_vectors` and the `vec0` tables. */
  deleteWhere(scope: Scope, column: VectorColumn, value: string): void {
    if (this.mode === 'sqlite-vec') {
      const rows = this.sqlite
        .prepare(`SELECT chunk_id, dims FROM kb_vectors WHERE workspace_id = ? AND ${column} = ?`)
        .all(scope.workspaceId, value) as { chunk_id: string; dims: number }[];
      for (const row of rows) this.#deleteFromVectorTable(row.dims, row.chunk_id);
    }
    this.sqlite
      .prepare(`DELETE FROM kb_vectors WHERE workspace_id = ? AND ${column} = ?`)
      .run(scope.workspaceId, value);
  }

  /** The `k` nearest vectors of one base by cosine similarity, best first. */
  query(
    scope: Scope,
    knowledgeBaseId: string,
    embedding: readonly number[],
    k: number,
  ): VectorMatch[] {
    const limit = Math.min(Math.floor(k), MAX_VECTOR_K);
    if (limit < 1) return [];
    const blob = toFloat32Blob('<query>', embedding);
    const dims = embedding.length;

    return this.mode === 'sqlite-vec'
      ? this.#knn(scope, knowledgeBaseId, blob, dims, limit)
      : this.#scan(scope, knowledgeBaseId, blob, dims, limit);
  }

  #knn(
    scope: Scope,
    knowledgeBaseId: string,
    blob: Buffer,
    dims: number,
    limit: number,
  ): VectorMatch[] {
    const table = vectorTableName(dims);
    if (!tableExists(this.sqlite, table)) return [];

    const rows = this.sqlite
      .prepare(
        `SELECT chunk_id, distance FROM ${table}
          WHERE embedding MATCH ? AND k = ? AND knowledge_base_id = ?`,
      )
      .all(blob, limit, knowledgeBaseId) as { chunk_id: string; distance: number | null }[];
    if (rows.length === 0) return [];

    // `kb_vectors` is the table of record: only what it holds for this workspace and base counts,
    // which keeps tenants apart and ignores a stale `vec0` row the next open would rebuild.
    const held = new Set(
      (
        this.sqlite
          .prepare(
            `SELECT chunk_id FROM kb_vectors
              WHERE workspace_id = ? AND knowledge_base_id = ? AND dims = ?
                AND chunk_id IN (${rows.map(() => '?').join(', ')})`,
          )
          .all(scope.workspaceId, knowledgeBaseId, dims, ...rows.map((row) => row.chunk_id)) as {
          chunk_id: string;
        }[]
      ).map((row) => row.chunk_id),
    );

    return rows
      .filter((row) => held.has(row.chunk_id))
      .map((row) => ({
        chunkId: row.chunk_id,
        score: row.distance === null ? 0 : 1 - row.distance,
      }));
  }

  /** The exact fallback (F8): every vector of the base, scored and sorted here. */
  #scan(
    scope: Scope,
    knowledgeBaseId: string,
    blob: Buffer,
    dims: number,
    limit: number,
  ): VectorMatch[] {
    const query = fromFloat32Blob(blob);
    const rows = this.sqlite
      .prepare(
        `SELECT chunk_id, embedding FROM kb_vectors
          WHERE workspace_id = ? AND knowledge_base_id = ? AND dims = ?`,
      )
      .all(scope.workspaceId, knowledgeBaseId, dims) as { chunk_id: string; embedding: Buffer }[];

    return rows
      .map((row) => ({
        chunkId: row.chunk_id,
        similarity: cosine(query, fromFloat32Blob(row.embedding)),
      }))
      .sort((a, b) => {
        // Directionless vectors last, as sqlite-vec orders its NULL distances; then by id.
        if (a.similarity === null || b.similarity === null) {
          if (a.similarity !== b.similarity) return a.similarity === null ? 1 : -1;
        } else if (a.similarity !== b.similarity) {
          return b.similarity - a.similarity;
        }
        return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
      })
      .slice(0, limit)
      .map((row) => ({ chunkId: row.chunkId, score: row.similarity ?? 0 }));
  }

  #deleteFromVectorTable(dims: number, chunkId: string): void {
    const table = vectorTableName(dims);
    if (!tableExists(this.sqlite, table)) return;
    this.sqlite.prepare(`DELETE FROM ${table} WHERE chunk_id = ?`).run(chunkId);
  }
}

export interface SqliteVectorIndexOptions {
  /** Defaults to whatever this connection has loaded; a test forces `'scan'` to compare the two. */
  vectorExtension?: VectorExtension;
}

/** `VectorIndex` over `kb_vectors` and sqlite-vec, or the exact scan without it (F8). */
export class SqliteVectorIndex implements VectorIndex {
  readonly #sqlite: BetterSqlite3.Database;
  readonly #store: VectorStore;

  constructor(sqlite: BetterSqlite3.Database, options: SqliteVectorIndexOptions = {}) {
    this.#sqlite = sqlite;
    this.#store = new VectorStore(sqlite, options.vectorExtension ?? detectVectorExtension(sqlite));
  }

  get vectorExtension(): VectorExtension {
    return this.#store.mode;
  }

  async upsert(scope: Scope, records: VectorRecord[]): Promise<void> {
    this.#sqlite.transaction(() => this.#store.write(scope, records))();
  }

  async query(
    scope: Scope,
    knowledgeBaseId: string,
    embedding: number[],
    k: number,
  ): Promise<VectorMatch[]> {
    return this.#store.query(scope, knowledgeBaseId, embedding, k);
  }

  async deleteByDocument(scope: Scope, documentId: string): Promise<void> {
    this.#sqlite.transaction(() => this.#store.deleteWhere(scope, 'document_id', documentId))();
  }

  async deleteByKnowledgeBase(scope: Scope, knowledgeBaseId: string): Promise<void> {
    this.#sqlite.transaction(() =>
      this.#store.deleteWhere(scope, 'knowledge_base_id', knowledgeBaseId),
    )();
  }
}

/* -------------------------------------------------------------------------- */
/* Keywords                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A free-text query as an FTS5 expression: every word quoted, joined by OR, so a user's quotes,
 * brackets, `AND`/`NEAR` or a stray `*` are words and never syntax that throws. A word is what the
 * `unicode61 tokenchars '-_'` tokenizer keeps together — letters, digits, marks, `-` and `_` — so
 * `zephyrine-protocol-7` stays one term. OR lets bm25 rank a chunk with the rare term first.
 * `undefined` when the query has no word at all.
 */
export function toMatchExpression(query: string): string | undefined {
  const words = new Set(
    query.split(/[^\p{L}\p{N}\p{M}_-]+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)),
  );
  if (words.size === 0) return undefined;
  return [...words].map((word) => `"${word}"`).join(' OR ');
}

/** `KeywordIndex` over the FTS5 external-content table `kb_chunks_fts` (F8, FR-RAG-004). */
export class Fts5KeywordIndex implements KeywordIndex {
  readonly #sqlite: BetterSqlite3.Database;

  constructor(sqlite: BetterSqlite3.Database) {
    this.#sqlite = sqlite;
  }

  /**
   * The index's content is `kb_chunks`, so a record is indexed by its chunk row: a changed text is
   * written there and the update trigger re-indexes it. A record with no stored chunk cannot be
   * indexed — write the chunk with `kbChunks.replaceForDocument`, which indexes it in the same
   * transaction.
   */
  async index(scope: Scope, records: KeywordRecord[]): Promise<void> {
    const find = this.#sqlite.prepare(
      `SELECT seq, text FROM kb_chunks
        WHERE workspace_id = ? AND id = ? AND knowledge_base_id = ? AND document_id = ?`,
    );
    const update = this.#sqlite.prepare('UPDATE kb_chunks SET text = ? WHERE seq = ?');

    this.#sqlite.transaction(() => {
      for (const record of records) {
        const row = find.get(
          scope.workspaceId,
          record.chunkId,
          record.knowledgeBaseId,
          record.documentId,
        ) as { seq: number; text: string } | undefined;
        if (row === undefined) {
          throw new Error(
            `keyword record ${record.chunkId} has no stored chunk; kbChunks.replaceForDocument writes and indexes chunks`,
          );
        }
        if (row.text !== record.text) update.run(record.text, row.seq);
      }
    })();
  }

  async search(
    scope: Scope,
    knowledgeBaseId: string,
    query: string,
    k: number,
  ): Promise<KeywordMatch[]> {
    const match = toMatchExpression(query);
    const limit = Math.floor(k);
    if (match === undefined || limit < 1) return [];

    const rows = this.#sqlite
      .prepare(
        `SELECT c.id AS chunkId, bm25(kb_chunks_fts) AS bm25Rank
           FROM kb_chunks_fts
           JOIN kb_chunks c ON c.seq = kb_chunks_fts.rowid
          WHERE kb_chunks_fts MATCH ?
            AND c.workspace_id = ? AND c.knowledge_base_id = ?
          ORDER BY bm25Rank ASC, c.id ASC
          LIMIT ?`,
      )
      .all(match, scope.workspaceId, knowledgeBaseId, limit) as {
      chunkId: string;
      bm25Rank: number;
    }[];

    // bm25 is lower-is-better and negative for a match; the port wants higher-is-better.
    return rows.map((row) => ({ chunkId: row.chunkId, score: -row.bm25Rank }));
  }

  /** Deletes the document's chunk rows; the delete trigger takes their FTS rows with them. */
  async deleteByDocument(scope: Scope, documentId: string): Promise<void> {
    this.#sqlite
      .prepare('DELETE FROM kb_chunks WHERE workspace_id = ? AND document_id = ?')
      .run(scope.workspaceId, documentId);
  }

  async deleteByKnowledgeBase(scope: Scope, knowledgeBaseId: string): Promise<void> {
    this.#sqlite
      .prepare('DELETE FROM kb_chunks WHERE workspace_id = ? AND knowledge_base_id = ?')
      .run(scope.workspaceId, knowledgeBaseId);
  }
}
