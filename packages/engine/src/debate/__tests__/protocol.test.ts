import { describe, expect, it } from 'vitest';

import { createFakeDebateProvider } from './fake-debate-provider.js';
import { debateHarness, nodeOf } from './harness.js';

/** A's rebuttal that changes its mind because of B's previous turn. */
const changeOfMind = (round: number, answer: string) => ({
  answer,
  confidence: 0.6,
  reasoning: `A changes in round ${round}.`,
  rebuttals: [{ targetTurnId: `R${round - 1}-B`, claim: 'B said so', response: 'convincing' }],
  positionChanged: true,
  changedBecause: { turnId: `R${round - 1}-B`, argument: 'B showed the cost.' },
});

describe('D342 DB3 the protocol: openings, rebuttal rounds, judge', () => {
  it('free mode, 3 debaters, 2 rounds, nobody converges: 3 openings + 6 rebuttals + judge + baseline judge = 11 calls', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R1-A', [{ reply: changeOfMind(1, 'Memcached') }]);
    provider.script('R2-A', [{ reply: changeOfMind(2, 'Redis') }]);
    const { outcome, record } = await debateHarness({ provider, config: { maxRounds: 2 } }).run();

    expect(outcome.kind).toBe('verdict');
    expect(provider.calls).toHaveLength(11);
    expect(provider.calls.map((c) => c.callId)).toEqual(
      expect.arrayContaining([
        'R0-A',
        'R0-B',
        'R0-C',
        'R1-A',
        'R1-B',
        'R1-C',
        'R2-A',
        'R2-B',
        'R2-C',
        'judge',
        'judge-openings',
      ]),
    );
    expect(record?.stoppedBy).toBe('max_rounds');
    expect(record?.rounds.map((r) => r.round)).toEqual([0, 1, 2]);
  });

  it('choice mode, same debate: 10 calls, no baseline judge', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R1-A', [{ reply: changeOfMind(1, 'no') }]);
    provider.script('R2-A', [{ reply: changeOfMind(2, 'yes') }]);
    const { outcome } = await debateHarness({
      provider,
      config: { maxRounds: 2, answerFormat: 'choice', options: ['yes', 'no'] },
    }).run();

    expect(outcome.kind).toBe('verdict');
    expect(provider.calls).toHaveLength(10);
    expect(provider.calls.map((c) => c.callId)).not.toContain('judge-openings');
  });

  it('runs every turn of a round in parallel, behind a barrier between rounds', async () => {
    const provider = createFakeDebateProvider();
    const { record } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();
    const order = provider.calls.map((c) => c.callId);
    // All three openings start before any rebuttal, and all rebuttals before the judge.
    expect(order.slice(0, 3).sort()).toEqual(['R0-A', 'R0-B', 'R0-C']);
    expect(order.slice(3, 6).sort()).toEqual(['R1-A', 'R1-B', 'R1-C']);
    expect(order[6]).toBe('judge');
    expect(record?.rounds.every((r) => r.completed)).toBe(true);
  });
});

describe('D349 DB10 stopping on convergence', () => {
  it('a rebuttal round with no change of position stops after round 1, stoppedBy converged', async () => {
    const provider = createFakeDebateProvider();
    const { record, outcome } = await debateHarness({
      provider,
      config: { maxRounds: 3, earlyStop: true },
    }).run();

    expect(outcome.kind).toBe('verdict');
    expect(record?.stoppedBy).toBe('converged');
    expect(record?.rounds.map((r) => [r.round, r.changedCount])).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(provider.calls.some((c) => c.callId.startsWith('R2-'))).toBe(false);
  });

  it('with earlyStop off, every round runs even when nobody changes', async () => {
    const provider = createFakeDebateProvider();
    const { record } = await debateHarness({
      provider,
      config: { maxRounds: 3, earlyStop: false },
    }).run();

    expect(record?.stoppedBy).toBe('max_rounds');
    expect(record?.rounds.map((r) => r.round)).toEqual([0, 1, 2, 3]);
    expect(provider.calls.filter((c) => /^R\d-/.test(c.callId))).toHaveLength(12);
  });
});

describe('D353 the node states of a debate', () => {
  it('a debater is RUNNING in its turn, WAITING between rounds and COMPLETED after the verdict', async () => {
    const states: [string, string][] = [];
    await debateHarness({
      config: { maxRounds: 1 },
      hooks: { debaterState: (nodeId, state) => void states.push([nodeId, state]) },
    }).run();

    const of = (label: 'A' | 'B') =>
      states.filter(([id]) => id === nodeOf(label)).map(([, s]) => s);
    expect(of('A')).toEqual(['RUNNING', 'WAITING', 'RUNNING', 'WAITING', 'COMPLETED']);
    expect(of('B')).toEqual(['RUNNING', 'WAITING', 'RUNNING', 'WAITING', 'COMPLETED']);
  });

  it('reports every call usage against the node that made it, the judge against the hub', async () => {
    const usage: [string, number][] = [];
    const { outcome } = await debateHarness({
      config: { maxRounds: 1, answerFormat: 'choice', options: ['yes', 'no'] },
      hooks: { usage: (nodeId, u) => void usage.push([nodeId, u.tokensIn + u.tokensOut]) },
    }).run();

    expect(usage.filter(([id]) => id === nodeOf('A'))).toHaveLength(2);
    expect(outcome.kind === 'verdict' && outcome.judgeUsage.tokensIn).toBeGreaterThan(0);
    if (outcome.kind !== 'verdict') return;
    const total = usage.reduce((sum, [, n]) => sum + n, 0);
    expect(outcome.verdict.stats.tokens).toBe(total);
  });
});
