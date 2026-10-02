import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KbChunk } from '@ace/contracts';
import { newId, type VectorRecord } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type OpenDatabase } from '../db.js';
import { Fts5KeywordIndex, SqliteVectorIndex, vectorTableName } from '../indexes.js';
import { SqliteRepository } from '../repository.js';
import { scope } from './fixtures.js';

/**
 * The two search indexes of F8 (Arch §7, §12.6): embeddings in `kb_vectors` plus a `vec0` index
 * when sqlite-vec loads, with an exact cosine scan when it does not; and an FTS5 external-content
 * index over `kb_chunks`. Both are narrowed to one knowledge base (F2).
 */

const OTHER = { workspaceId: 'other' };

let dir: string;
let handles: OpenDatabase[];

function open(options: { loadVectorExtension?: boolean } = {}): OpenDatabase {
  const opened = openDatabase({ path: join(dir, 'ace.sqlite'), ...options });
  handles.push(opened);
  return opened;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-indexes-'));
  handles = [];
});

afterEach(() => {
  for (const handle of handles.reverse()) {
    try {
      handle.sqlite.close();
    } catch {
      // already closed by the test
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a lingering handle on Windows; the OS reclaims the temp directory anyway
  }
});

const KB_A = newId();
const KB_B = newId();
const DOC_A = newId();
const DOC_B = newId();

const chunk = (id: string, documentId: string, knowledgeBaseId: string, text: string): KbChunk => ({
  id,
  documentId,
  knowledgeBaseId,
  ordinal: 0,
  text,
  tokens: Math.ceil(text.length / 4),
  source: `doc.md#${id}`,
  headings: [],
});

const vector = (
  chunkId: string,
  documentId: string,
  knowledgeBaseId: string,
  embedding: number[],
): VectorRecord => ({ chunkId, documentId, knowledgeBaseId, embedding });

describe('F8 opening the database records which vector search it has', () => {
  it('loads sqlite-vec when it can', () => {
    expect(open().vectorExtension).toBe('sqlite-vec');
  });

  it('records the scan fallback when the extension is not loaded', () => {
    expect(open({ loadVectorExtension: false }).vectorExtension).toBe('scan');
  });
});

describe('FR-RAG-004 vector query returns nearest by cosine, scoped to its knowledge base', () => {
  it('ranks by cosine similarity, best first, and only within the base asked', async () => {
    const { sqlite } = open();
    const index = new SqliteVectorIndex(sqlite);
    const same = [1, 0, 0, 0];
    await index.upsert(scope, [
      vector('a1', DOC_A, KB_A, same),
      vector('a2', DOC_A, KB_A, [0.6, 0.8, 0, 0]),
      vector('a3', DOC_A, KB_A, [0, 0, 1, 0]),
      // The same vector in another base: never returned for KB_A.
      vector('b1', DOC_B, KB_B, same),
    ]);

    const matches = await index.query(scope, KB_A, same, 5);
    expect(matches.map((match) => match.chunkId)).toEqual(['a1', 'a2', 'a3']);
    expect(matches[0]!.score).toBeCloseTo(1, 5);
    expect(matches[1]!.score).toBeCloseTo(0.6, 5);
    expect(matches[2]!.score).toBeCloseTo(0, 5);

    expect((await index.query(scope, KB_B, same, 5)).map((match) => match.chunkId)).toEqual(['b1']);
    expect(await index.query(scope, KB_A, same, 1)).toHaveLength(1);
  });

  it('keeps tenants apart: another workspace sees nothing', async () => {
    const { sqlite } = open();
    const index = new SqliteVectorIndex(sqlite);
    await index.upsert(scope, [vector('a1', DOC_A, KB_A, [1, 0])]);

    expect(await index.query(OTHER, KB_A, [1, 0], 5)).toEqual([]);
  });

  it('replaces a chunk vector on upsert rather than duplicating it', async () => {
    const { sqlite } = open();
    const index = new SqliteVectorIndex(sqlite);
    await index.upsert(scope, [vector('a1', DOC_A, KB_A, [1, 0])]);
    await index.upsert(scope, [vector('a1', DOC_A, KB_A, [0, 1])]);

    const matches = await index.query(scope, KB_A, [0, 1], 5);
    expect(matches.map((match) => match.chunkId)).toEqual(['a1']);
    expect(matches[0]!.score).toBeCloseTo(1, 5);
  });

  it('holds bases embedded at different widths side by side', async () => {
    const { sqlite } = open();
    const index = new SqliteVectorIndex(sqlite);
    await index.upsert(scope, [
      vector('a1', DOC_A, KB_A, [1, 0, 0]),
      vector('b1', DOC_B, KB_B, [1, 0, 0, 0, 0]),
    ]);

    expect((await index.query(scope, KB_A, [1, 0, 0], 5)).map((m) => m.chunkId)).toEqual(['a1']);
    expect((await index.query(scope, KB_B, [1, 0, 0, 0, 0], 5)).map((m) => m.chunkId)).toEqual([
      'b1',
    ]);
    // A query of a width the base was not embedded at matches nothing.
    expect(await index.query(scope, KB_A, [1, 0], 5)).toEqual([]);
  });

  it('answers nothing for k below one or an empty base', async () => {
    const { sqlite } = open();
    const index = new SqliteVectorIndex(sqlite);
    await index.upsert(scope, [vector('a1', DOC_A, KB_A, [1, 0])]);

    expect(await index.query(scope, KB_A, [1, 0], 0)).toEqual([]);
    expect(await index.query(scope, KB_B, [1, 0], 5)).toEqual([]);
  });

  it('refuses an embedding that is empty or not finite', async () => {
    const { sqlite } = open();
    const index = new SqliteVectorIndex(sqlite);

    await expect(index.upsert(scope, [vector('a1', DOC_A, KB_A, [])])).rejects.toThrow(/embedding/);
    await expect(index.upsert(scope, [vector('a1', DOC_A, KB_A, [1, Number.NaN])])).rejects.toThrow(
      /embedding/,
    );
  });

  it('deletes by document and by knowledge base', async () => {
    const { sqlite } = open();
    const index = new SqliteVectorIndex(sqlite);
    const other = newId();
    await index.upsert(scope, [
      vector('a1', DOC_A, KB_A, [1, 0]),
      vector('a2', other, KB_A, [0.9, 0.1]),
      vector('b1', DOC_B, KB_B, [1, 0]),
    ]);

    await index.deleteByDocument(scope, DOC_A);
    expect((await index.query(scope, KB_A, [1, 0], 5)).map((m) => m.chunkId)).toEqual(['a2']);

    await index.deleteByKnowledgeBase(scope, KB_A);
    expect(await index.query(scope, KB_A, [1, 0], 5)).toEqual([]);
    expect((await index.query(scope, KB_B, [1, 0], 5)).map((m) => m.chunkId)).toEqual(['b1']);
  });
});

describe('F8 scan fallback answers like vec0', () => {
  it('returns the same ids in the same order as the vec0 index', async () => {
    const { sqlite, vectorExtension } = open();
    expect(vectorExtension).toBe('sqlite-vec');
    const vec0 = new SqliteVectorIndex(sqlite, { vectorExtension: 'sqlite-vec' });
    const scan = new SqliteVectorIndex(sqlite, { vectorExtension: 'scan' });

    // Deterministic pseudo-random directions (a fixed LCG), so the run is repeatable.
    let state = 42;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648 - 0.5;
    };
    const random = () => Array.from({ length: 8 }, next);
    const records: VectorRecord[] = [];
    for (let n = 0; n < 60; n += 1) {
      records.push(vector(`c${String(n).padStart(2, '0')}`, DOC_A, KB_A, random()));
    }
    records.push(vector('other-kb', DOC_B, KB_B, random()));
    await vec0.upsert(scope, records);

    for (const query of [random(), random(), random()]) {
      const fromVec0 = await vec0.query(scope, KB_A, query, 7);
      const fromScan = await scan.query(scope, KB_A, query, 7);
      // The comparison means something only if no two neighbours tie at float32 precision.
      for (let index = 1; index < fromScan.length; index += 1) {
        expect(fromScan[index - 1]!.score - fromScan[index]!.score).toBeGreaterThan(1e-5);
      }
      expect(fromScan.map((m) => m.chunkId)).toEqual(fromVec0.map((m) => m.chunkId));
      fromScan.forEach((match, index) => {
        expect(match.score).toBeCloseTo(fromVec0[index]!.score, 5);
      });
    }
  });

  it('writes through the scan index too, so a later vec0 open rebuilds what it missed', async () => {
    const first = open({ loadVectorExtension: false });
    const scan = new SqliteVectorIndex(first.sqlite);
    await scan.upsert(scope, [
      vector('a1', DOC_A, KB_A, [1, 0]),
      vector('a2', DOC_A, KB_A, [0, 1]),
    ]);
    expect((await scan.query(scope, KB_A, [0, 1], 5)).map((m) => m.chunkId)).toEqual(['a2', 'a1']);
    first.sqlite.close();

    const second = open();
    const tables = second.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE name = ?`)
      .all(vectorTableName(2));
    expect(tables).toHaveLength(1);
    const vec0 = new SqliteVectorIndex(second.sqlite);
    expect((await vec0.query(scope, KB_A, [0, 1], 5)).map((m) => m.chunkId)).toEqual(['a2', 'a1']);
  });

  it('rebuilds a missing vec0 table from kb_vectors at open', async () => {
    const first = open();
    await new SqliteVectorIndex(first.sqlite).upsert(scope, [vector('a1', DOC_A, KB_A, [1, 0])]);
    first.sqlite.exec(`DROP TABLE ${vectorTableName(2)}`);
    first.sqlite.close();

    const second = open();
    expect(
      (await new SqliteVectorIndex(second.sqlite).query(scope, KB_A, [1, 0], 5)).map(
        (m) => m.chunkId,
      ),
    ).toEqual(['a1']);
  });
});

describe('TC-RAG-004 groundwork: FTS5 finds zephyrine-protocol-7 as one token', () => {
  async function seed(): Promise<{ repository: SqliteRepository; keyword: Fts5KeywordIndex }> {
    const { db, sqlite } = open();
    const repository = new SqliteRepository(db, sqlite);
    await repository.kbChunks.replaceForDocument(
      scope,
      DOC_A,
      [
        chunk('a1', DOC_A, KB_A, 'The zephyrine-protocol-7 governs the north gate.'),
        chunk('a2', DOC_A, KB_A, 'A protocol for the zephyrine valley, version 7.'),
        chunk('a3', DOC_A, KB_A, 'Nothing about gates here.'),
      ],
      [
        [1, 0],
        [0, 1],
        [1, 1],
      ],
    );
    await repository.kbChunks.replaceForDocument(
      scope,
      DOC_B,
      [chunk('b1', DOC_B, KB_B, 'The zephyrine-protocol-7 again, in another base.')],
      [[1, 0]],
    );
    return { repository, keyword: new Fts5KeywordIndex(sqlite) };
  }

  it('matches the hyphenated term only where it appears whole, in the base asked', async () => {
    const { keyword } = await seed();

    const matches = await keyword.search(scope, KB_A, 'zephyrine-protocol-7', 5);
    expect(matches.map((match) => match.chunkId)).toEqual(['a1']);
    expect(matches[0]!.score).toBeGreaterThan(0);

    // The parts alone are other tokens: 'zephyrine' finds a2, never the hyphenated a1.
    expect((await keyword.search(scope, KB_A, 'zephyrine', 5)).map((m) => m.chunkId)).toEqual([
      'a2',
    ]);
    expect(
      (await keyword.search(scope, KB_B, 'zephyrine-protocol-7', 5)).map((m) => m.chunkId),
    ).toEqual(['b1']);
  });

  it('ranks by bm25, best first, and finds a term inside a question', async () => {
    const { keyword } = await seed();

    const matches = await keyword.search(scope, KB_A, 'What does zephyrine-protocol-7 govern?', 5);
    expect(matches[0]!.chunkId).toBe('a1');
    for (let index = 1; index < matches.length; index += 1) {
      expect(matches[index - 1]!.score).toBeGreaterThanOrEqual(matches[index]!.score);
    }
  });

  it('treats FTS5 syntax in a query as plain words, and an empty query as no hits', async () => {
    const { keyword } = await seed();

    await expect(keyword.search(scope, KB_A, '"gate" AND (north OR', 5)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ chunkId: 'a1' })]),
    );
    expect(await keyword.search(scope, KB_A, '  ?!  ', 5)).toEqual([]);
    expect(await keyword.search(scope, KB_A, 'gate', 0)).toEqual([]);
    expect(await keyword.search(OTHER, KB_A, 'gate', 5)).toEqual([]);
  });

  it('re-indexes a stored chunk with new text, and refuses a record with no stored chunk', async () => {
    const { keyword } = await seed();

    await keyword.index(scope, [
      { chunkId: 'a3', documentId: DOC_A, knowledgeBaseId: KB_A, text: 'Now about quasar beams.' },
    ]);
    expect((await keyword.search(scope, KB_A, 'quasar', 5)).map((m) => m.chunkId)).toEqual(['a3']);
    expect(await keyword.search(scope, KB_A, 'gates', 5)).toEqual([]);

    await expect(
      keyword.index(scope, [
        { chunkId: 'missing', documentId: DOC_A, knowledgeBaseId: KB_A, text: 'x' },
      ]),
    ).rejects.toThrow(/missing/);
  });

  it('deletes a document and a base from the keyword index', async () => {
    const { keyword } = await seed();

    await keyword.deleteByDocument(scope, DOC_A);
    expect(await keyword.search(scope, KB_A, 'zephyrine', 5)).toEqual([]);
    expect(await keyword.search(scope, KB_B, 'zephyrine-protocol-7', 5)).toHaveLength(1);

    await keyword.deleteByKnowledgeBase(scope, KB_B);
    expect(await keyword.search(scope, KB_B, 'zephyrine-protocol-7', 5)).toEqual([]);
  });
});
