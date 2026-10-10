import type { DomainMessage, DomainUsageSnapshot } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { applyFrame, fromPage, initialConversation, orderedMessages } from './conversation-state';

/* D9, D314: the web only renders — it folds the server's frames into the conversation. */

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const TURN = '01ARZ3NDEKTSV4RRFFQ69G5FT1';
const NOW = '2026-10-10T00:00:00.000Z';

const system = (seq: number, text: string): DomainMessage => ({
  id: `sys:${seq}.0`,
  runId: RUN,
  cursor: `${seq}.0`,
  author: { kind: 'system' },
  type: 'system',
  text,
  at: NOW,
});

const turn = (outcome: 'RUNNING' | 'OK'): DomainMessage => ({
  id: `turn:${TURN}`,
  runId: RUN,
  cursor: '5.0',
  author: { kind: 'node', nodeId: NODE },
  type: 'agent',
  text: outcome === 'OK' ? 'Done.' : '',
  turn: { turnId: TURN, trigger: 'dispatch', iteration: 1, attempt: 1, steps: [], outcome },
  at: NOW,
});

describe('the conversation, folded from frames', () => {
  it('appends in cursor order, and an update replaces a message in its place', () => {
    let state = initialConversation();
    state = applyFrame(state, { event: 'chat.message', data: { message: system(7, 'b') } });
    state = applyFrame(state, { event: 'chat.message', data: { message: system(3, 'a') } });
    state = applyFrame(state, { event: 'chat.update', data: { message: system(7, 'B') } });
    expect(orderedMessages(state).map((message) => message.text)).toEqual(['a', 'B']);
  });

  it('a cursor compares as numbers: 10.0 comes after 9.1', () => {
    const state = fromPage([system(10, 'ten'), system(9, 'nine')]);
    expect(orderedMessages(state).map((message) => message.text)).toEqual(['nine', 'ten']);
  });

  it("collects a turn's live text until its message says the turn ended", () => {
    let state = applyFrame(initialConversation(), {
      event: 'chat.message',
      data: { message: turn('RUNNING') },
    });
    for (const delta of ['Hel', 'lo']) {
      state = applyFrame(state, {
        event: 'turn.token',
        data: { nodeRunId: TURN, nodeId: NODE, delta },
      });
    }
    expect(state.tokens[TURN]).toBe('Hello');
    state = applyFrame(state, { event: 'chat.update', data: { message: turn('OK') } });
    expect(state.tokens[TURN]).toBeUndefined();
  });

  it('keeps the latest usage snapshot', () => {
    const snapshot: DomainUsageSnapshot = {
      runId: RUN,
      budget: null,
      total: { input: 1, output: 2, cachedInput: 0, estimatedShare: 0 },
      costEst: null,
      perNode: [],
      perTurn: [],
    };
    const state = applyFrame(initialConversation(), {
      event: 'usage.snapshot',
      data: { snapshot },
    });
    expect(state.usage).toEqual(snapshot);
  });
});
