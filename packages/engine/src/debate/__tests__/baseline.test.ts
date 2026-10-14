import { describe, expect, it } from 'vitest';

import { createFakeDebateProvider } from './fake-debate-provider.js';
import { debateHarness } from './harness.js';
import { openingsMajority } from '../baseline.js';

const choice = { answerFormat: 'choice' as const, options: ['yes', 'no', 'maybe'] };

/** Each debater keeps one answer in every round; the judge's is named on its own. */
const byLabel =
  (answers: Record<string, string>) =>
  (callId: string): string =>
    answers[callId] ?? answers[callId.slice(-1)] ?? 'yes';

describe('D348 DB9 the openings majority is computed in code', () => {
  it('counts trimmed, case-folded answers and names the winner', () => {
    expect(openingsMajority(['yes', 'Yes ', 'no'], choice.options)).toBe('yes');
    expect(openingsMajority(['no', 'no', 'maybe'], choice.options)).toBe('no');
  });

  it('records a tie as "tie"', () => {
    expect(openingsMajority(['yes', 'no'], choice.options)).toBe('tie');
    expect(openingsMajority(['yes', 'no', 'maybe'], choice.options)).toBe('tie');
    expect(openingsMajority([], choice.options)).toBe('tie');
  });

  it('runs no model for it: the debate reports the majority with no extra call', async () => {
    const provider = createFakeDebateProvider({ answer: byLabel({ A: 'no', B: 'no', C: 'yes' }) });
    const { outcome } = await debateHarness({
      provider,
      config: { ...choice, maxRounds: 1 },
    }).run();
    expect(provider.calls).toHaveLength(7);
    expect(outcome.kind === 'verdict' && outcome.verdict.stats.openingsMajority).toBe('no');
  });

  it('a tied opening gives "tie" and no changedFromOpenings', async () => {
    const provider = createFakeDebateProvider({
      answer: byLabel({ A: 'yes', B: 'no', C: 'maybe' }),
    });
    const { outcome } = await debateHarness({
      provider,
      config: { ...choice, maxRounds: 1 },
    }).run();
    if (outcome.kind !== 'verdict') throw new Error('expected a verdict');
    expect(outcome.verdict.stats.openingsMajority).toBe('tie');
    expect(outcome.verdict.stats.changedFromOpenings).toBeUndefined();
  });
});

describe('D348 DB9 changedFromOpenings', () => {
  it('is true when the verdict differs from the openings majority', async () => {
    const provider = createFakeDebateProvider({
      answer: byLabel({ A: 'no', B: 'no', C: 'yes', judge: 'yes' }),
    });
    const { outcome } = await debateHarness({
      provider,
      config: { ...choice, maxRounds: 1 },
    }).run();
    if (outcome.kind !== 'verdict') throw new Error('expected a verdict');
    expect(outcome.verdict.stats).toMatchObject({
      openingsMajority: 'no',
      changedFromOpenings: true,
    });
  });

  it('is false when the verdict keeps the openings majority', async () => {
    const provider = createFakeDebateProvider({
      answer: byLabel({ A: 'no', B: 'no', C: 'yes', judge: 'NO' }),
    });
    const { outcome } = await debateHarness({
      provider,
      config: { ...choice, maxRounds: 1 },
    }).run();
    if (outcome.kind !== 'verdict') throw new Error('expected a verdict');
    expect(outcome.verdict.answer).toBe('no');
    expect(outcome.verdict.stats).toMatchObject({
      openingsMajority: 'no',
      changedFromOpenings: false,
    });
  });
});

describe('D348 DB9 free mode: the baseline judge', () => {
  it('stores the judge’s answer over the openings alone as openingsVerdict', async () => {
    const answers: Record<string, string> = {
      judge: 'Redis with a TTL',
      'judge-openings': 'Redis',
    };
    const provider = createFakeDebateProvider({ answer: (id) => answers[id] ?? 'Redis' });
    const { outcome } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();
    if (outcome.kind !== 'verdict') throw new Error('expected a verdict');
    expect(outcome.verdict.answer).toBe('Redis with a TTL');
    expect(outcome.verdict.stats.openingsVerdict).toBe('Redis');
    // No auto label in free mode.
    expect(outcome.verdict.stats.changedFromOpenings).toBeUndefined();
    expect(outcome.verdict.stats.openingsMajority).toBeUndefined();
  });

  it('the baseline judge prompt holds only the openings', async () => {
    const provider = createFakeDebateProvider();
    await debateHarness({ provider, config: { maxRounds: 2, earlyStop: false } }).run();
    const [baseline] = provider.promptsOf('judge-openings');
    expect(baseline).toContain('[R0-A]');
    expect(baseline).toContain('[R0-B]');
    expect(baseline).toContain('[R0-C]');
    expect(baseline).not.toMatch(/\[R[1-4]-/);
    expect(baseline).not.toContain('EARLIER ROUNDS');
  });

  it('runs no baseline judge when baselineJudge is off', async () => {
    const provider = createFakeDebateProvider();
    const { outcome } = await debateHarness({
      provider,
      config: { maxRounds: 1, baselineJudge: false },
    }).run();
    expect(provider.promptsOf('judge-openings')).toEqual([]);
    expect(outcome.kind === 'verdict' && outcome.verdict.stats.openingsVerdict).toBeUndefined();
  });

  it('a baseline judge that fails costs only its openingsVerdict, never the verdict', async () => {
    const provider = createFakeDebateProvider();
    provider.script('judge-openings', [{ reply: 'nothing' }, { reply: 'nothing again' }]);
    const { outcome } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();
    expect(outcome.kind).toBe('verdict');
    expect(outcome.kind === 'verdict' && outcome.verdict.stats.openingsVerdict).toBeUndefined();
  });
});
