import type { ServerFrame } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { useRunStore } from './run-store';

const RUN = '01RUN0000000000000000000000';
const WF = '01WF00000000000000000000000';
const NODE = '01NODE000000000000000000000';
const NODE_RUN = '01NR00000000000000000000000';
const EDGE = '01EDGE000000000000000000000';

const usage = { tokensIn: 10, tokensOut: 4, costUsd: 0.000018, priceTableVersion: 'mock-v1' };

const state = (seq: number, status: string): ServerFrame =>
  ({
    seq,
    type: 'node.state',
    payload: {
      runId: RUN,
      nodeRunId: NODE_RUN,
      nodeId: NODE,
      iteration: 1,
      attempt: 1,
      status,
    },
  }) as ServerFrame;

const token = (delta: string): ServerFrame =>
  ({ type: 'node.token', payload: { runId: RUN, nodeRunId: NODE_RUN, delta } }) as ServerFrame;

describe('FR-EXE-008/009/015 the run overlay store folds §2.4 frames', () => {
  beforeEach(() => useRunStore.getState().reset());

  it('tracks a node through its states and collects its streamed text', () => {
    const store = useRunStore.getState();
    store.begin(WF, RUN, 'RUNNING');
    expect(useRunStore.getState().nodeState(NODE)).toBe('IDLE');

    store.apply(state(1, 'READY'));
    store.apply(state(2, 'RUNNING'));
    store.apply(token('Hello '));
    store.apply(token('world'));

    const after = useRunStore.getState();
    expect(after.nodeState(NODE)).toBe('RUNNING');
    expect(after.streamedText(NODE_RUN)).toBe('Hello world');
    expect(after.active).toBe(true);
  });

  it('ignores a replayed persisted frame but never dedupes a token (TC-EXE-013)', () => {
    const store = useRunStore.getState();
    store.begin(WF, RUN, 'RUNNING');
    store.apply(state(1, 'RUNNING'));
    store.apply(token('a'));

    // What a reconnect replays: the same seq again, plus a token that carries no seq at all.
    store.apply(state(1, 'RUNNING'));
    store.apply(token('a'));

    expect(useRunStore.getState().streamedText(NODE_RUN)).toBe('aa');
    expect(useRunStore.getState().lastSeq()).toBe(1);
  });

  it('records the model used and the edge transfer, and ends the run', () => {
    const store = useRunStore.getState();
    store.begin(WF, RUN, 'RUNNING');
    store.apply({
      seq: 3,
      type: 'node.output',
      payload: {
        runId: RUN,
        nodeRunId: NODE_RUN,
        nodeId: NODE,
        output: [{ type: 'text', text: 'done' }],
        usage,
        modelUsed: { providerId: WF, modelId: 'mock-text-fallback', viaFallback: true },
      },
    } as ServerFrame);
    store.apply({
      seq: 4,
      type: 'edge.transfer',
      payload: {
        runId: RUN,
        edgeId: EDGE,
        fromNodeId: NODE,
        toNodeId: NODE,
        iteration: 1,
        summary: 'done',
      },
    } as ServerFrame);
    store.apply({
      seq: 5,
      type: 'run.completed',
      payload: { runId: RUN, status: 'COMPLETE', totals: usage, finalOutput: {} },
    } as ServerFrame);

    const after = useRunStore.getState();
    expect(after.nodeRun(NODE)?.modelUsed?.viaFallback).toBe(true);
    expect(after.lastTransfer(EDGE)?.summary).toBe('done');
    expect(after.status).toBe('COMPLETE');
    expect(after.active).toBe(false);
    expect(after.totals).toEqual(usage);
  });

  it('drops frames belonging to another run', () => {
    const store = useRunStore.getState();
    store.begin(WF, RUN, 'RUNNING');
    store.apply(state(1, 'RUNNING'));
    store.apply({
      seq: 2,
      type: 'node.state',
      payload: {
        runId: '01OTHER00000000000000000000',
        nodeRunId: '01NR10000000000000000000000',
        nodeId: '01NODE100000000000000000000',
        iteration: 1,
        attempt: 1,
        status: 'RUNNING',
      },
    } as ServerFrame);
    expect(useRunStore.getState().nodeRuns()).toHaveLength(1);
  });
});
