import { describe, expect, it, vi } from 'vitest';

import {
  engineAccepts,
  sleep,
  waitForDev,
  waitForEngine,
  webAnswers,
  type DevWaitState,
  type FetchLike,
} from '../readiness.js';

const ENGINE = 'http://127.0.0.1:4747';
const WEB = 'http://localhost:5173';
const noSleep = (): Promise<void> => Promise.resolve();

/** A fake engine + Vite: the engine accepts `token`, Vite answers when `webUp`. */
function fakeServers(state: { token?: string; webUp: boolean; engineUp: boolean }): {
  fetch: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (url.startsWith(ENGINE)) {
      if (!state.engineUp) throw new TypeError('fetch failed');
      return { status: init?.headers?.['authorization'] === `Bearer ${state.token}` ? 200 : 401 };
    }
    if (!state.webUp) throw new TypeError('fetch failed');
    return { status: 200 };
  };
  return { fetch, calls };
}

describe('FR-DSK-002 readiness probes (D295)', () => {
  it('engineAccepts: only a 200 with the token counts', async () => {
    const { fetch, calls } = fakeServers({ token: 't1', webUp: true, engineUp: true });
    expect(await engineAccepts(ENGINE, 't1', fetch)).toBe(true);
    expect(await engineAccepts(ENGINE, 'stale', fetch)).toBe(false);
    expect(calls[0]).toBe(`${ENGINE}/api/v1/health`);
  });

  it('engineAccepts and webAnswers: a refused connection is "not yet", not an error', async () => {
    const { fetch } = fakeServers({ webUp: false, engineUp: false });
    expect(await engineAccepts(ENGINE, 't', fetch)).toBe(false);
    expect(await webAnswers(WEB, fetch)).toBe(false);
  });

  it('webAnswers: a 200 from Vite', async () => {
    expect(await webAnswers(WEB, fakeServers({ webUp: true, engineUp: false }).fetch)).toBe(true);
    expect(await webAnswers(WEB, async () => ({ status: 503 }))).toBe(false);
  });
});

describe('FR-DSK-002 waitForDev — token file, then engine, then Vite (D295)', () => {
  it('reports what it waits for, re-reads the token each round, and answers the live token', async () => {
    const servers = { token: 'fresh', webUp: false, engineUp: false };
    const { fetch } = fakeServers(servers);
    const tokens: (string | undefined)[] = [undefined, 'stale', 'fresh', 'fresh'];
    const seen: DevWaitState[] = [];
    let round = 0;

    const token = await waitForDev({
      readToken: () => tokens[Math.min(round, tokens.length - 1)],
      engineUrl: ENGINE,
      webUrl: WEB,
      fetch,
      onWaiting: (state) => seen.push(state),
      sleep: async () => {
        round += 1;
        if (round === 2) servers.engineUp = true;
        if (round === 3) servers.webUp = true;
      },
    });

    expect(token).toBe('fresh');
    // no file → engine down (stale token) → Vite down → ready
    expect(seen).toEqual(['token', 'engine', 'web']);
  });

  it('never gives up on its own, and stops when aborted', async () => {
    const controller = new AbortController();
    let rounds = 0;
    const waiting = waitForDev({
      readToken: () => undefined,
      engineUrl: ENGINE,
      webUrl: WEB,
      fetch: fakeServers({ webUp: false, engineUp: false }).fetch,
      signal: controller.signal,
      sleep: async () => {
        rounds += 1;
        if (rounds === 50) controller.abort(new Error('window closed'));
      },
    });
    await expect(waiting).rejects.toThrow('window closed');
    expect(rounds).toBe(50);
  });
});

describe('FR-DSK-002 waitForEngine — after a restart wrote a new token', () => {
  it('polls until the engine accepts the new token', async () => {
    const servers = { token: 'old', webUp: true, engineUp: true };
    const { fetch } = fakeServers(servers);
    let rounds = 0;
    await waitForEngine({
      engineUrl: ENGINE,
      token: 'new',
      fetch,
      sleep: async () => {
        rounds += 1;
        if (rounds === 3) servers.token = 'new';
      },
    });
    expect(rounds).toBe(3);
  });

  it('stops when aborted (a newer token replaced this one)', async () => {
    const controller = new AbortController();
    controller.abort(new Error('superseded'));
    await expect(
      waitForEngine({
        engineUrl: ENGINE,
        token: 'x',
        fetch: fakeServers({ webUp: true, engineUp: true }).fetch,
        signal: controller.signal,
        sleep: noSleep,
      }),
    ).rejects.toThrow('superseded');
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      const pending = sleep(1_000).then(done);
      await vi.advanceTimersByTimeAsync(999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(done).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects at once when the signal is already aborted, or aborts mid-wait', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('before'));
    await expect(sleep(10_000, aborted.signal)).rejects.toThrow('before');

    const later = new AbortController();
    const pending = sleep(10_000, later.signal);
    later.abort(new Error('during'));
    await expect(pending).rejects.toThrow('during');
  });
});
