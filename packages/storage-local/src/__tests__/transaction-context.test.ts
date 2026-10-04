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

  it('refuses exclusive() from inside a transaction instead of deadlocking', async () => {
    await expect(
      db.repository.transaction(async () => db.repository.exclusive(async () => 'never')),
    ).rejects.toThrow(/inside a transaction/);
    expect(await db.repository.exclusive(async () => 'outside')).toBe('outside');
  });
});
