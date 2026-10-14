import { describe, expect, it } from 'vitest';

import { createPathLocks } from './locks.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('FR-TOOL-008 per-path write locks (agentic nodes, concurrency)', () => {
  it('runs two holders of one path one after the other', async () => {
    const locks = createPathLocks();
    const order: string[] = [];
    const first = locks.withLock('/p/x', async () => {
      order.push('a:start');
      await tick();
      order.push('a:end');
      return 'a';
    });
    const second = locks.withLock('/p/x', async () => {
      order.push('b:start');
      await tick();
      order.push('b:end');
      return 'b';
    });
    expect(await Promise.all([first, second])).toEqual(['a', 'b']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('does not hold different paths behind each other', async () => {
    const locks = createPathLocks();
    const order: string[] = [];
    await Promise.all([
      locks.withLock('/p/x', async () => {
        order.push('x:start');
        await tick();
        order.push('x:end');
      }),
      locks.withLock('/p/y', async () => {
        order.push('y:start');
        await tick();
        order.push('y:end');
      }),
    ]);
    expect(order.slice(0, 2).sort()).toEqual(['x:start', 'y:start']);
  });

  it('releases on a throw, and the next holder still runs', async () => {
    const locks = createPathLocks();
    await expect(
      locks.withLock('/p/x', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(locks.withLock('/p/x', async () => 'next')).resolves.toBe('next');
  });

  it('serializes case variants of one path on Windows', async () => {
    const locks = createPathLocks({ platform: 'win32' });
    const order: string[] = [];
    await Promise.all([
      locks.withLock('C:\\P\\X.ts', async () => {
        order.push('a:start');
        await tick();
        order.push('a:end');
      }),
      locks.withLock('c:\\p\\x.ts', async () => {
        order.push('b:start');
      }),
    ]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('keeps nothing once every holder has released (no leak)', async () => {
    const locks = createPathLocks();
    await Promise.all([1, 2, 3].map((n) => locks.withLock(`/p/${n % 2}`, async () => n)));
    await expect(
      locks.withLock('/p/0', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(locks.size()).toBe(0);
  });
});
