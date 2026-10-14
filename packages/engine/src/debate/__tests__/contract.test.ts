import { describe, expect, it } from 'vitest';

import { createFakeDebateProvider } from './fake-debate-provider.js';
import { debateHarness, nodeOf } from './harness.js';

const rebuttal = (fields: Record<string, unknown> = {}) => ({
  answer: 'yes',
  confidence: 0.5,
  reasoning: 'r',
  rebuttals: [{ targetTurnId: 'R0-B', claim: 'c', response: 'r' }],
  positionChanged: false,
  changedBecause: null,
  ...fields,
});

const judge = (fields: Record<string, unknown> = {}) => ({
  answer: 'yes',
  confidence: 0.8,
  rationale: [{ point: 'p', supportedBy: ['R1-A'] }],
  dissent: [],
  openQuestions: [],
  ...fields,
});

describe('D344 DB5 the anti-conformity contract, D350 DB11 one repair', () => {
  it('a rebuttal with no rebuttals gets a repair prompt carrying the errors, and a valid repair is accepted', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R1-A', [{ reply: rebuttal({ rebuttals: [] }) }, { reply: rebuttal() }]);
    const { record } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();

    const [first, repair] = provider.promptsOf('R1-A');
    expect(repair).toContain(first);
    expect(repair).toContain("Your last reply didn't meet the required format:");
    expect(repair).toContain('rebuttals');
    expect(repair).toContain('Reply again with only the corrected fenced json block.');
    // The model sees the reply it is asked to correct (D358).
    expect(repair).toContain('"rebuttals": []');
    expect(record?.turns['R1-A']).toBeDefined();
    expect(record?.rounds[1]?.violations).toEqual([
      expect.objectContaining({ callId: 'R1-A', willRepair: true }),
    ]);
  });

  it('two invalid replies: CONTRACT_VIOLATION, A sits out that round only, and is back next round', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R1-A', [{ reply: 'no json here' }, { reply: 'still none' }]);
    const { record, outcome } = await debateHarness({
      provider,
      config: { maxRounds: 2, earlyStop: false },
    }).run();

    expect(outcome.kind).toBe('verdict');
    expect(record?.rounds[1]?.violations.map((v) => v.willRepair)).toEqual([true, false]);
    expect(record?.turns['R1-A']).toBeUndefined();
    expect(record?.turns['R2-A']).toBeDefined();
    expect(record?.debaters.find((d) => d.label === 'A')?.status).toBe('active');
    if (outcome.kind === 'verdict') expect(outcome.verdict.stats.violations).toBe(1);
    // The round-2 prompt says A had no valid turn last round.
    expect(provider.promptsOf('R2-A')[0]).toContain('[R1-A] (you) (no valid turn');
  });

  it('a choice answer that is not an option is a violation', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R0-A', [{ reply: { answer: 'maybe', confidence: 0.5, reasoning: 'r' } }]);
    const { record } = await debateHarness({
      provider,
      config: { maxRounds: 1, answerFormat: 'choice', options: ['yes', 'no'] },
    }).run();
    expect(record?.rounds[0]?.violations[0]?.errors.join(' ')).toMatch(/answer/);
  });

  it('accepts a choice answer whatever its case and spacing, stored as the option', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R0-A', [{ reply: { answer: '  YES ', confidence: 0.5, reasoning: 'r' } }]);
    const { record } = await debateHarness({
      provider,
      config: { maxRounds: 1, answerFormat: 'choice', options: ['yes', 'no'] },
    }).run();
    expect(record?.turns['R0-A']?.answer).toBe('yes');
  });

  it('positionChanged true without changedBecause is a violation', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R1-A', [{ reply: rebuttal({ positionChanged: true, changedBecause: null }) }]);
    const { record } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();
    expect(record?.rounds[1]?.violations[0]?.errors.join(' ')).toMatch(/changedBecause/);
  });

  it.each([
    [
      'a rebuttal of your own turn',
      { rebuttals: [{ targetTurnId: 'R0-A', claim: 'c', response: 'r' }] },
    ],
    [
      'a rebuttal of a turn that does not exist',
      { rebuttals: [{ targetTurnId: 'R0-E', claim: 'c', response: 'r' }] },
    ],
    [
      'a rebuttal of the wrong round',
      { rebuttals: [{ targetTurnId: 'R1-B', claim: 'c', response: 'r' }] },
    ],
    [
      'changedBecause your own turn',
      { answer: 'no', positionChanged: true, changedBecause: { turnId: 'R0-A', argument: 'a' } },
    ],
    [
      'changedBecause a missing turn',
      { answer: 'no', positionChanged: true, changedBecause: { turnId: 'R0-D', argument: 'a' } },
    ],
    [
      'changedBecause the wrong round',
      { answer: 'no', positionChanged: true, changedBecause: { turnId: 'R1-B', argument: 'a' } },
    ],
  ])('%s is a violation', async (_name, fields) => {
    const provider = createFakeDebateProvider();
    provider.script('R1-A', [{ reply: rebuttal(fields) }]);
    const { record } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();
    expect(record?.rounds[1]?.violations[0]?.callId).toBe('R1-A');
  });

  it('choice mode: the model says it kept its position but its answer changed, and the engine’s value wins', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R1-A', [
      {
        reply: rebuttal({
          answer: 'no',
          positionChanged: false,
          changedBecause: { turnId: 'R0-B', argument: 'B showed the cost.' },
        }),
      },
    ]);
    const { record } = await debateHarness({
      provider,
      config: { maxRounds: 1, answerFormat: 'choice', options: ['yes', 'no'] },
    }).run();
    expect(record?.turns['R1-A']?.positionChanged).toBe(true);
    expect(record?.rounds[1]?.changedCount).toBe(1);
  });

  it('choice mode: the model says it changed but its answer is the same, and the engine’s value wins', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R1-A', [
      {
        reply: rebuttal({
          positionChanged: true,
          changedBecause: { turnId: 'R0-B', argument: 'x' },
        }),
      },
    ]);
    const { record } = await debateHarness({
      provider,
      config: { maxRounds: 1, answerFormat: 'choice', options: ['yes', 'no'] },
    }).run();
    expect(record?.turns['R1-A']?.positionChanged).toBe(false);
    expect(record?.turns['R1-A']?.changedBecause).toBeNull();
  });
});

describe('D346 DB7 the judge’s contract', () => {
  it('a verdict citing a turn that does not exist is repaired once, then the hub ends CONTRACT_VIOLATION with every turn kept', async () => {
    const provider = createFakeDebateProvider();
    const bad = judge({ rationale: [{ point: 'p', supportedBy: ['R3-C'] }] });
    provider.script('judge', [{ reply: bad }, { reply: bad }]);
    const { outcome, record } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();

    expect(provider.promptsOf('judge')).toHaveLength(2);
    expect(provider.promptsOf('judge')[1]).toContain('R3-C');
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.failureReason).toBe('CONTRACT_VIOLATION');
    expect(record?.status).toBe('failed');
    expect(Object.keys(record?.turns ?? {})).toHaveLength(6);
    expect(record?.judgeViolations.map((v) => v.willRepair)).toEqual([true, false]);
  });

  it('a dissent naming a missing turn is a violation too', async () => {
    const provider = createFakeDebateProvider();
    provider.script('judge', [
      {
        reply: judge({
          dissent: [{ label: 'B', answer: 'no', strongestArgument: 's', turnId: 'R1-D' }],
        }),
      },
    ]);
    const { record } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();
    expect(record?.judgeViolations[0]?.errors.join(' ')).toMatch(/dissent/);
  });

  it('a point no debater made cites "judge" and is accepted', async () => {
    const provider = createFakeDebateProvider();
    provider.script('judge', [
      { reply: judge({ rationale: [{ point: 'mine', supportedBy: ['judge'] }] }) },
    ]);
    const { outcome } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();
    expect(outcome.kind).toBe('verdict');
  });

  it('stats the model writes are ignored and replaced by the engine’s', async () => {
    const provider = createFakeDebateProvider();
    provider.script('judge', [
      {
        reply: judge({
          stats: {
            debateId: 'x',
            rounds: 99,
            stoppedBy: 'budget',
            turns: 1,
            violations: 9,
            tokens: 1,
          },
        }),
      },
    ]);
    const { outcome, record } = await debateHarness({
      provider,
      config: { maxRounds: 1, answerFormat: 'choice', options: ['yes', 'no'] },
    }).run();

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.verdict.stats).toEqual({
      debateId: '01JF0000000000000000000003',
      rounds: 1,
      stoppedBy: 'converged',
      turns: 6,
      violations: 0,
      tokens: record?.tokens,
      openingsMajority: 'yes',
      changedFromOpenings: false,
    });
  });

  it('keeps the judge’s dissent as written', async () => {
    const provider = createFakeDebateProvider();
    const dissent = [{ label: 'B', answer: 'no', strongestArgument: 'RAM costs', turnId: 'R1-B' }];
    provider.script('judge', [{ reply: judge({ dissent }) }]);
    const { outcome } = await debateHarness({ provider, config: { maxRounds: 1 } }).run();
    expect(outcome.kind === 'verdict' && outcome.verdict.dissent).toEqual(dissent);
  });
});

describe('D350 the debater out of turns', () => {
  it('the debater state follows a violation: back to WAITING, never FAILED', async () => {
    const provider = createFakeDebateProvider();
    provider.script('R1-A', [{ reply: 'x' }, { reply: 'y' }]);
    const states: string[] = [];
    await debateHarness({
      provider,
      config: { maxRounds: 1 },
      hooks: {
        debaterState: (nodeId, state) => void (nodeId === nodeOf('A') && states.push(state)),
      },
    }).run();
    expect(states).not.toContain('FAILED');
    expect(states.at(-1)).toBe('COMPLETED');
  });
});
