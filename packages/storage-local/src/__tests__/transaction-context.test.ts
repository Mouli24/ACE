import type { Repository } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeProject, scope } from './fixtures.js';
import { createTempDb, type TempDb } from './temp-db.js';

/**
 * NFR-REL-02, TC-NFR-006: a transaction is joined only by the code it runs.
 *
 * There is one SQLite connection, so every statement issued while a transaction is open lands in
 * it. Round 5 adds background writers — ingestion's `replaceForDocument`, a document or base
 * delete — that call `transaction` while an unrelated batch may be awaiting inside its own. Such a
 * caller must wait for that batch to commit or roll back, never join it: joining would let the
 * batch's rollback take the caller's writes with it, or commit half of the caller's work. A call
 * made from inside the open transaction's own body still joins it, as it always has.
 */

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TC-NFR-006 a concurrent transaction waits instead of joining', () => {
  it('keeps the second writer when the first, still open, rolls back', async () => {
    const doomed = makeProject({ name: 'Rolled back' });
    const survivor = makeProject({ name: 'Written by another caller' });

    const first = db.repository.transaction(async (tx) => {
      await tx.projects.create(scope, doomed);
      await delay(30);
      throw new Error('first batch failed');
    });
    // The first transaction is open and awaiting when the second caller arrives.
    await delay(5);
    expect(db.sqlite.inTransaction).toBe(true);
    const second = db.repository.transaction(async (tx) => {
      await tx.projects.create(scope, survivor);
    });

    await expect(first).rejects.toThrow('first batch failed');
    await second;

    expect(await db.repository.projects.get(scope, doomed.id)).toBeNull();
    expect(await db.repository.projects.get(scope, survivor.id)).toEqual(survivor);
  });

  it('does not let a failing second caller roll back the first one', async () => {
    const kept = makeProject({ name: 'Committed by the first' });
    const refused = makeProject({ name: 'Refused second' });

    const first = db.repository.transaction(async (tx) => {
      await tx.projects.create(scope, kept);
      await delay(20);
    });
    await delay(5);
    const second = db.repository.transaction(async (tx) => {
      await tx.projects.create(scope, refused);
      throw new Error('second batch failed');
    });

    await first;
    await expect(second).rejects.toThrow('second batch failed');

    expect(await db.repository.projects.get(scope, kept.id)).toEqual(kept);
    expect(await db.repository.projects.get(scope, refused.id)).toBeNull();
  });

  it('runs a writer that arrives later after the open one, in arrival order', async () => {
    const order: string[] = [];
    const first = db.repository.transaction(async () => {
      order.push('first:start');
      await delay(20);
      order.push('first:end');
    });
    await delay(5);
    const second = db.repository.transaction(async () => {
      order.push('second');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});

describe('TC-NFR-006 a nested transaction joins the one its body opened', () => {
  it('sees the outer writes, and a throw inside it rolls the whole outer transaction back', async () => {
    const outer = makeProject({ name: 'Outer' });
    const inner = makeProject({ name: 'Inner' });

    await expect(
      db.repository.transaction(async (tx) => {
        await tx.projects.create(scope, outer);
        await tx.transaction(async (nested) => {
          // Joined, not queued: it would deadlock waiting for its own outer transaction otherwise.
          expect(await nested.projects.get(scope, outer.id)).toEqual(outer);
          await nested.projects.create(scope, inner);
          throw new Error('nested failure');
        });
      }),
    ).rejects.toThrow('nested failure');

    expect(await db.repository.projects.get(scope, outer.id)).toBeNull();
    expect(await db.repository.projects.get(scope, inner.id)).toBeNull();
    expect(db.sqlite.inTransaction).toBe(false);
  });

  it('commits nested writes with the outer transaction', async () => {
    const outer = makeProject({ name: 'Outer' });
    const inner = makeProject({ name: 'Inner' });

    await db.repository.transaction(async (tx) => {
      await tx.projects.create(scope, outer);
      await tx.transaction(async (nested) => {
        await nested.projects.create(scope, inner);
      });
    });

    expect(await db.repository.projects.get(scope, outer.id)).toEqual(outer);
    expect(await db.repository.projects.get(scope, inner.id)).toEqual(inner);
  });

  it('queues work a body leaves running past its own commit, rather than joining a later transaction', async () => {
    const late = makeProject({ name: 'Started inside, written after' });
    let detached: Promise<unknown> = Promise.resolve();

    await db.repository.transaction(async () => {
      // Not awaited: by the time it calls `transaction`, this body's transaction has committed.
      detached = delay(10).then(() =>
        db.repository.transaction(async (tx) => tx.projects.create(scope, late)),
      );
    });
    const blocker = db.repository.transaction(async () => {
      await delay(20);
      throw new Error('unrelated failure');
    });

    await expect(blocker).rejects.toThrow('unrelated failure');
    await detached;
    expect(await db.repository.projects.get(scope, late.id)).toEqual(late);
  });

  it('queues a transaction opened through a body handle kept past its commit, rather than joining a later batch', async () => {
    const event = { type: 'late.append', payload: {}, createdAt: '2026-10-01T10:00:00.000Z' };
    let kept: Repository | undefined;
    await db.repository.transaction(async (tx) => {
      kept = tx;
    });

    const blocker = db.repository.transaction(async () => {
      await delay(30);
      throw new Error('unrelated failure');
    });
    await delay(5);
    expect(db.sqlite.inTransaction).toBe(true);
    // The handle outlived its transaction: using it must not land inside the open, doomed batch.
    const late = kept!.transaction(async (tx) => tx.events.append(scope, event));

    await expect(blocker).rejects.toThrow('unrelated failure');
    await late;
    const types = (
      await db.repository.events.listAfter(scope, 0, { includeEngineScope: true })
    ).map((row) => row.type);
    expect(types).toEqual(['late.append']);
  });

  it('gives a body handle kept past its commit a transaction of its own, rolled back whole', async () => {
    let kept: Repository | undefined;
    await db.repository.transaction(async (tx) => {
      kept = tx;
    });

    await expect(
      kept!.transaction(async (tx) => {
        await tx.events.append(scope, {
          type: 'half.written',
          payload: {},
          createdAt: '2026-10-01T10:00:00.000Z',
        });
        throw new Error('second statement failed');
      }),
    ).rejects.toThrow('second statement failed');

    expect(await db.repository.events.listAfter(scope, 0, { includeEngineScope: true })).toEqual(
      [],
    );
    expect(db.sqlite.inTransaction).toBe(false);
  });

  it('refuses exclusive() from inside a transaction instead of deadlocking', async () => {
    await expect(
      db.repository.transaction(async () => db.repository.exclusive(async () => 'never')),
    ).rejects.toThrow(/inside a transaction/);
    expect(await db.repository.exclusive(async () => 'outside')).toBe('outside');
  });
});

/**
 * NFR-REL-02: a call that is not wrapped in `transaction` — the ingestion worker's document update,
 * a node-run update, an event append — must not land inside someone else's open batch either. It
 * waits until that batch has committed or rolled back, then runs; from inside the batch's own body
 * it runs at once, because it is part of the batch.
 */
describe('TC-NFR-006 a plain repository call waits for an unrelated open transaction', () => {
  const event = (type: string) => ({
    type,
    payload: { type },
    createdAt: '2026-10-01T10:00:00.000Z',
  });

  it('keeps a plain write issued while an unrelated transaction is open and later throws', async () => {
    const doomed = makeProject({ name: 'Rolled back' });
    const outside = makeProject({ name: 'Written outside the batch' });

    const batch = db.repository.transaction(async (tx) => {
      await tx.projects.create(scope, doomed);
      await delay(30);
      throw new Error('stale_version');
    });
    await delay(5);
    expect(db.sqlite.inTransaction).toBe(true);
    const plain = db.repository.projects.create(scope, outside);
    const appended = db.repository.events.append(scope, event('plain.append'));

    await expect(batch).rejects.toThrow('stale_version');
    await plain;
    await appended;

    expect(await db.repository.projects.get(scope, doomed.id)).toBeNull();
    expect(await db.repository.projects.get(scope, outside.id)).toEqual(outside);
    const types = (
      await db.repository.events.listAfter(scope, 0, { includeEngineScope: true })
    ).map((row) => row.type);
    expect(types).toEqual(['plain.append']);
  });

  it('orders a plain write after an unrelated transaction that commits, and keeps both', async () => {
    const batch = db.repository.transaction(async (tx) => {
      await tx.events.append(scope, event('batch.first'));
      await delay(30);
      await tx.events.append(scope, event('batch.second'));
    });
    await delay(5);
    const plain = db.repository.events.append(scope, event('plain'));

    await batch;
    await plain;

    const types = (
      await db.repository.events.listAfter(scope, 0, { includeEngineScope: true })
    ).map((row) => row.type);
    expect(types).toEqual(['batch.first', 'batch.second', 'plain']);
  });

  it('reads nothing of an unrelated batch that is still open', async () => {
    const pending = makeProject({ name: 'Not yet committed' });
    const batch = db.repository.transaction(async (tx) => {
      await tx.projects.create(scope, pending);
      await delay(30);
      throw new Error('rolled back');
    });
    await delay(5);

    const read = db.repository.projects.get(scope, pending.id);

    await expect(batch).rejects.toThrow('rolled back');
    expect(await read).toBeNull();
  });

  it('runs reads and writes from inside the batch body at once, through any reference', async () => {
    const inside = makeProject({ name: 'Inside' });

    const seen = await db.repository.transaction(async (tx) => {
      await tx.projects.create(scope, inside);
      // The outer reference, not `tx`: still the batch's own body, so no wait and no deadlock.
      const viaOuter = await db.repository.projects.get(scope, inside.id);
      await db.repository.events.append(scope, event('inside'));
      return viaOuter;
    });

    expect(seen).toEqual(inside);
    expect(
      (await db.repository.events.listAfter(scope, 0, { includeEngineScope: true })).map(
        (row) => row.type,
      ),
    ).toEqual(['inside']);
  });

  it('keeps the connection for the whole of a plain call, so a batch cannot open half way through it', async () => {
    // `settings.update` reads, awaits, then writes. A batch arriving meanwhile must not capture the
    // write, or its rollback would undo a settings change it never made.
    const updated = db.repository.settings.update(scope, { dataDir: 'D:/kept', concurrency: 7 });
    const batch = db.repository.transaction(async () => {
      await delay(5);
      throw new Error('unrelated failure');
    });

    await expect(batch).rejects.toThrow('unrelated failure');
    await updated;
    expect((await db.repository.settings.get(scope)).concurrency).toBe(7);
  });

  it('gates the repository indexes too: a search waits, and runs at once inside the batch', async () => {
    const kb = makeProject().id;
    const documentId = makeProject().id;
    const chunk = {
      id: makeProject().id,
      documentId,
      knowledgeBaseId: kb,
      ordinal: 0,
      text: 'quasar lattice',
      tokens: 4,
      source: 'doc.md#a',
      headings: [],
    };
    let insideHits = -1;
    const batch = db.repository.transaction(async (tx) => {
      await tx.kbChunks!.replaceForDocument(scope, documentId, [chunk], [[1, 0]]);
      // The batch's own search sees its own rows at once.
      insideHits = (await db.repository.keywordIndex.search(scope, kb, 'quasar', 5)).length;
      await delay(30);
      throw new Error('ingestion batch failed');
    });
    await delay(10);

    const keyword = db.repository.keywordIndex.search(scope, kb, 'quasar', 5);
    const vector = db.repository.vectorIndex.query(scope, kb, [1, 0], 5);

    await expect(batch).rejects.toThrow('ingestion batch failed');
    expect(insideHits).toBe(1);
    expect(await keyword).toEqual([]);
    expect(await vector).toEqual([]);
  });

  it('gates every composed repository, round 5 and usage included', async () => {
    const batch = db.repository.transaction(async () => {
      await delay(20);
      throw new Error('unrelated failure');
    });
    await delay(5);
    const writes = Promise.all([
      db.repository.memory.upsert(
        scope,
        makeProject().id,
        'k',
        'v',
        '2026-10-01T10:00:00.000Z',
        () => makeProject().id,
      ),
      db.repository.summaryCache.put(scope, 'key', 'summary', '2026-10-01T10:00:00.000Z'),
    ]);
    const totals = db.repository.usage.dayTotals(scope, '2026-10-01');

    await expect(batch).rejects.toThrow('unrelated failure');
    await writes;
    expect(await totals).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    expect(await db.repository.summaryCache.get(scope, 'key', '2026-10-01T10:00:01.000Z')).toBe(
      'summary',
    );
    expect(
      (db.sqlite.prepare('SELECT count(*) AS n FROM agent_memory').get() as { n: number }).n,
    ).toBe(1);
  });
});
