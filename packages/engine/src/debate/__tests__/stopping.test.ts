import { describe, expect, it } from 'vitest';

import { createFakeDebateProvider } from './fake-debate-provider.js';
import { debateHarness, nodeOf } from './harness.js';

describe('D350 DB11 CLI failures', () => {
  it('a CLI failure then a success on the retry: the debate goes on', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R0-B', [{ fail: 'cli_exit_1' }]);
    const { outcome, record } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();

    expect(outcome.kind).toBe('verdict');
    expect(provider.calls.filter((c) => c.callId === 'R0-B').map((c) => c.attempt)).toEqual([1, 2]);
    expect(record?.turns['R0-B']).toBeDefined();
    expect(record?.rounds[0]?.failures).toEqual([
      expect.objectContaining({
        callId: 'R0-B',
        willRetry: true,
        out: false,
        failureReason: 'RUN_FAILED',
      }),
    ]);
  });

  it('two failures: the debater is out, and with two left the debate goes on', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R0-B', [{ fail: 'cli_exit_1' }, { fail: 'cli_exit_1' }]);
    const states: string[] = [];
    const { outcome, record } = await debateHarness({
      provider,
      config: { maxRounds: 1 },
      hooks: {
        debaterState: (nodeId, state, reason) =>
          void (
            nodeId === nodeOf('B') &&
            states.push(reason === undefined ? state : `${state}:${reason}`)
          ),
      },
    }).run();

    expect(outcome.kind).toBe('verdict');
    expect(record?.debaters.map((d) => d.status)).toEqual(['active', 'out', 'active']);
    expect(provider.calls.some((c) => c.callId === 'R1-B')).toBe(false);
    expect(record?.rounds[1]?.labels).toEqual(['A', 'C']);
    expect(states).toEqual(['RUNNING', 'FAILED:RUN_FAILED']);
  });

  it('with one debater left the hub ends RUN_FAILED and the partial record is kept', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R0-B', [{ fail: 'cli_exit_1' }, { fail: 'cli_exit_1' }]);
    provider.script('R1-C', [{ fail: 'cli_exit_1' }, { fail: 'cli_exit_1' }]);
    const { outcome, record } = await debateHarness({
      provider,
      config: { maxRounds: 2, earlyStop: false },
    }).run();

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.failureReason).toBe('RUN_FAILED');
    expect(record?.stoppedBy).toBe('failures');
    expect(record?.status).toBe('failed');
    expect(record?.turns['R0-A']).toBeDefined();
    expect(record?.turns['R1-A']).toBeDefined();
    expect(provider.calls.some((c) => c.callId === 'judge')).toBe(false);
  });

  it('a judge that fails twice ends the hub RUN_FAILED', async () => {
    const provider = createFakeDebateProvider();
    provider.script('judge', [{ fail: 'cli_exit_1' }, { fail: 'cli_exit_1' }]);
    const { outcome } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();
    expect(outcome.kind === 'failed' && outcome.failureReason).toBe('RUN_FAILED');
  });
});

describe('D349 DB10 a human "Judge now"', () => {
  it('kills the turns in flight and judges the completed ones, stoppedBy human_end', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R1-B', [{ hold: true }]);
    provider.script('R1-C', [{ hold: true }]);
    const h = debateHarness({ provider, config: { maxRounds: 3, earlyStop: false } });
    const done = h.run();
    await provider.whenCalled('R1-B');
    await provider.whenCalled('R1-C');
    // A's round-1 turn finishes; B and C are still thinking.
    await waitFor(() => h.provider.calls.some((c) => c.callId === 'R1-A'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.control.judgeNow();
    const { outcome, record } = await done;

    expect(outcome.kind).toBe('verdict');
    expect(record?.stoppedBy).toBe('human_end');
    expect(
      provider.calls
        .filter((c) => c.aborted)
        .map((c) => c.callId)
        .sort(),
    ).toEqual(['R1-B', 'R1-C']);
    expect(provider.calls.some((c) => c.callId.startsWith('R2-'))).toBe(false);
    expect(record?.turns['R1-A']).toBeDefined();
    expect(
      record?.rounds[1]?.failures
        .filter((f) => f.cancelled)
        .map((f) => f.callId)
        .sort(),
    ).toEqual(['R1-B', 'R1-C']);
    // No retry of a killed turn, and nobody is out for it.
    expect(provider.calls.filter((c) => c.callId === 'R1-B')).toHaveLength(1);
    expect(record?.debaters.every((d) => d.status === 'active')).toBe(true);
    const [judgePrompt] = provider.promptsOf('judge');
    expect(judgePrompt).toContain('[R1-A]');
    expect(record?.controls.map((c) => c.action)).toEqual(['judge_now']);
  });
});

describe('D354 DB10 the budget', () => {
  it('stops and judges when the next round plus the judge would not fit, stoppedBy budget', async () => {
    const provider = createFakeDebateProvider();
    let checks = 0;
    const h = debateHarness({
      provider,
      config: { maxRounds: 3, earlyStop: false },
      budget: {
        // Plenty before the openings and round 1; almost nothing left before round 2.
        remaining: async () => {
          checks += 1;
          return { tokens: checks <= 2 ? 1_000_000 : 100, usd: null };
        },
      },
    });
    const { record, outcome } = await h.run();

    expect(outcome.kind).toBe('verdict');
    expect(record?.stoppedBy).toBe('budget');
    expect(record?.rounds.map((r) => r.round)).toEqual([0, 1]);
    expect(provider.calls.some((c) => c.callId.startsWith('R2-'))).toBe(false);
    expect(provider.calls.filter((c) => c.callId === 'judge')).toHaveLength(1);
  });

  it('refuses to start, with no call, when even the openings and the judge would not fit', async () => {
    const provider = createFakeDebateProvider();
    const { outcome, record } = await debateHarness({
      provider,
      budget: { remaining: async () => ({ tokens: 10, usd: null }) },
    }).run();
    expect(provider.calls).toHaveLength(0);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.error.code).toBe('debate_budget_too_low');
    expect(record).toBeUndefined();
  });

  it('checks the USD caps when the models have a price', async () => {
    const provider = createFakeDebateProvider();
    const { record } = await debateHarness({
      provider,
      config: { maxRounds: 3, earlyStop: false },
      budget: {
        // Each call is priced at 0.15 USD. Before the openings 1 USD covers 3 turns + 2 judge
        // calls (0.75); after them 0.55 is left, short of another 0.75.
        remaining: async () => ({ tokens: null, usd: 1 - 0.15 * provider.calls.length }),
        costOf: () => 0.15,
      },
    }).run();
    expect(record?.stoppedBy).toBe('budget');
    expect(record?.rounds.map((r) => r.round)).toEqual([0]);
  });

  it('with no budget set, never stops for budget', async () => {
    const { record } = await debateHarness({
      config: { maxRounds: 2, earlyStop: false },
      budget: { remaining: async () => ({ tokens: null, usd: null }) },
    }).run();
    expect(record?.stoppedBy).toBe('max_rounds');
  });
});

describe('D358 "Pause after this round"', () => {
  it('makes no call while paused and goes on once resumed', async () => {
    const provider = createFakeDebateProvider();
    const h = debateHarness({ provider, config: { maxRounds: 2, earlyStop: false } });
    h.control.pauseAfterRound();
    const done = h.run();
    await waitFor(() => provider.calls.filter((c) => c.callId.startsWith('R0-')).length === 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(provider.calls).toHaveLength(3);
    h.control.resume();
    const { record, outcome } = await done;
    expect(outcome.kind).toBe('verdict');
    expect(record?.controls.map((c) => c.action)).toEqual(['pause_after_round', 'resume']);
    expect(record?.stoppedBy).toBe('max_rounds');
  });

  it('"Judge now" while paused judges at once', async () => {
    const provider = createFakeDebateProvider();
    const h = debateHarness({ provider, config: { maxRounds: 2, earlyStop: false } });
    h.control.pauseAfterRound();
    const done = h.run();
    await waitFor(() => provider.calls.filter((c) => c.callId.startsWith('R0-')).length === 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.control.judgeNow();
    const { record } = await done;
    expect(record?.stoppedBy).toBe('human_end');
    expect(provider.calls.some((c) => c.callId.startsWith('R1-'))).toBe(false);
  });

  it('a stopped run ends the debate STOPPED, killing what is in flight', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R0-A', [{ hold: true }]);
    const states: string[] = [];
    const h = debateHarness({
      provider,
      hooks: {
        debaterState: (nodeId, state) => void (nodeId === nodeOf('A') && states.push(state)),
      },
    });
    const done = h.run();
    await provider.whenCalled('R0-A');
    h.abort.abort();
    const { outcome } = await done;
    expect(outcome.kind).toBe('stopped');
    expect(provider.calls.find((c) => c.callId === 'R0-A')?.aborted).toBe(true);
    expect(states.at(-1)).toBe('STOPPED');
  });
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
