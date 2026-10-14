import { describe, expect, it } from 'vitest';

import { createFakeDebateProvider, type FakeStep } from './fake-debate-provider.js';
import { DEBATERS, HUB, allPrompts, debateHarness, nodeOf } from './harness.js';

/** A turn whose reasoning carries a marker, so a prompt that shows it can be found. */
const marked = (callId: string, round: number, target?: string): FakeStep => ({
  reply: {
    answer: 'yes',
    confidence: 0.5,
    reasoning: `MARK-${callId}`,
    ...(round === 0
      ? {}
      : {
          rebuttals: [{ targetTurnId: target ?? '', claim: 'c', response: 'r' }],
          positionChanged: false,
          changedBecause: null,
        }),
  },
});

describe('D343 DB4 bounded context, D345 DB6 anonymity', () => {
  it('no opening prompt carries another debater’s opening or stance', async () => {
    const provider = createFakeDebateProvider();
    for (const id of ['R0-A', 'R0-B', 'R0-C']) provider.script(id, [marked(id, 0)]);
    await debateHarness({
      provider,
      config: { maxRounds: 1 },
      stances: { A: 'STANCE-OF-A', B: 'STANCE-OF-B', C: 'STANCE-OF-C' },
    }).run();

    for (const [own, others] of [
      ['A', ['B', 'C']],
      ['B', ['A', 'C']],
      ['C', ['A', 'B']],
    ] as const) {
      const [opening] = provider.promptsOf(`R0-${own}`);
      expect(opening).toContain(`You are debater ${own}`);
      expect(opening).toContain(`STANCE-OF-${own}`);
      for (const other of others) {
        expect(opening).not.toContain(`MARK-R0-${other}`);
        expect(opening).not.toContain(`STANCE-OF-${other}`);
      }
    }
  });

  it('a round-k prompt holds the round k−1 turns of A, B and C and nothing older', async () => {
    const provider = createFakeDebateProvider();
    for (const label of ['A', 'B', 'C']) {
      provider.script(`R0-${label}`, [marked(`R0-${label}`, 0)]);
      provider.script(`R1-${label}`, [marked(`R1-${label}`, 1, label === 'A' ? 'R0-B' : 'R0-A')]);
    }
    await debateHarness({ provider, config: { maxRounds: 2, earlyStop: false } }).run();

    const [round2] = provider.promptsOf('R2-A');
    expect(round2).toContain('Round 2 of 2');
    for (const label of ['A', 'B', 'C']) {
      expect(round2).toContain(`[R1-${label}]`);
      expect(round2).toContain(`MARK-R1-${label}`);
      expect(round2).not.toContain(`MARK-R0-${label}`);
    }
    expect(round2).not.toContain('[R0-');
    expect(round2).toContain('[R1-A] (you)');
  });

  it('no debater prompt and no judge prompt names a node, a provider or a model', async () => {
    const provider = createFakeDebateProvider();
    await debateHarness({ provider, config: { maxRounds: 2 } }).run();

    const forbidden = [
      ...DEBATERS.flatMap((d) => [d.name, d.id, d.providerId, d.modelId]),
      HUB.name,
      HUB.providerId,
      HUB.modelId,
    ];
    for (const prompt of allPrompts(provider)) {
      for (const word of forbidden) expect(prompt).not.toContain(word);
    }
    for (const call of provider.calls) expect(call.system).toBeUndefined();
  });

  it('a human instruction to A reaches only A’s next prompt', async () => {
    const queued = new Map<string, { messageId: string; text: string }[]>([[nodeOf('A'), []]]);
    const provider = createFakeDebateProvider();
    // The message arrives while the openings run, so it is delivered with A's round-1 turn.
    void provider.whenCalled('R0-A').then(() => {
      queued
        .get(nodeOf('A'))
        ?.push({ messageId: '01JG0000000000000000000001', text: 'Weigh the RAM cost.' });
    });
    const { record } = await debateHarness({
      provider,
      config: { maxRounds: 2, earlyStop: false },
      hooks: { takeInstructions: (nodeId) => queued.get(nodeId)?.splice(0) ?? [] },
    }).run();

    const withIt = provider.calls
      .filter((c) => c.prompt.includes('Weigh the RAM cost.'))
      .map((c) => c.callId);
    expect(withIt).toEqual(['R1-A']);
    expect(provider.promptsOf('R1-A')[0]).toContain(
      'INSTRUCTIONS FROM THE HUMAN TO YOU: Weigh the RAM cost.',
    );
    expect(record?.instructions).toEqual([
      {
        nodeId: nodeOf('A'),
        callId: 'R1-A',
        messageId: '01JG0000000000000000000001',
        text: 'Weigh the RAM cost.',
      },
    ]);
  });

  it('an instruction to the hub reaches the judge only', async () => {
    const provider = createFakeDebateProvider();
    const queued = new Map([
      [
        '01JF00000000000000000000H0',
        [{ messageId: '01JG0000000000000000000002', text: 'Favour simplicity.' }],
      ],
    ]);
    await debateHarness({
      provider,
      config: { maxRounds: 1, answerFormat: 'choice', options: ['yes', 'no'] },
      hooks: { takeInstructions: (nodeId) => queued.get(nodeId)?.splice(0) ?? [] },
    }).run();

    const withIt = provider.calls
      .filter((c) => c.prompt.includes('Favour simplicity.'))
      .map((c) => c.callId);
    expect(withIt).toEqual(['judge']);
  });
});
