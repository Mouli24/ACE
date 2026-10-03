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

describe('FR-EXE-014 frames that arrive before the 201 are kept', () => {
  beforeEach(() => useRunStore.getState().reset());

  it('arm() clears the fold, and begin() does not throw away what arrived since', () => {
    const store = useRunStore.getState();
    // What `useStartRun` does: arm, send the request, and only then learn the run's id.
    store.arm(WF);
    store.apply(state(1, 'RUNNING'));
    store.apply(token('the engine answered before its own 201 did'));

    store.begin(WF, RUN, 'COMPLETE');

    const after = useRunStore.getState();
    expect(after.runId).toBe(RUN);
    expect(after.nodeState(NODE)).toBe('RUNNING');
    expect(after.streamedText(NODE_RUN)).toContain('before its own 201');
  });

  it('a stale fold from the previous run is gone once armed', () => {
    const store = useRunStore.getState();
    store.arm(WF);
    store.apply(state(1, 'COMPLETED'));
    expect(useRunStore.getState().nodeRuns()).toHaveLength(1);

    store.arm(WF);
    expect(useRunStore.getState().nodeRuns()).toHaveLength(0);
    expect(useRunStore.getState().settledCount).toBe(0);
  });

  it('counts only settled node runs, so a refetch is not keyed on every token', () => {
    const store = useRunStore.getState();
    store.arm(WF);
    store.apply(state(1, 'RUNNING'));
    store.apply(token('a'));
    store.apply(token('b'));
    expect(useRunStore.getState().settledCount).toBe(0);

    store.apply(state(2, 'COMPLETED'));
    expect(useRunStore.getState().settledCount).toBe(1);
  });
});

describe('D-074 a reload keeps the approval a WAITING node is anchored to (FR-GRD-013, TC-GRD-008)', () => {
  beforeEach(() => useRunStore.getState().reset());

  it('adopt() rebuilds the pending approvals beside the node states', () => {
    const request = {
      id: '01APPROVAL00000000000000000',
      runId: RUN,
      nodeRunId: NODE_RUN,
      nodeId: NODE,
      nodeName: 'Writer',
      point: 'output' as const,
      checkType: 'pii' as const,
      reason: 'An email address in the output.',
      preview: 'Contact me at …',
      requestedAt: '2026-10-03T10:00:00.000Z',
    };
    useRunStore
      .getState()
      .adopt(
        WF,
        { id: RUN, status: 'RUNNING', totals: usage },
        [{ id: NODE_RUN, nodeId: NODE, iteration: 1, attempt: 1, status: 'WAITING', usage }],
        [request],
      );

    const store = useRunStore.getState();
    expect(store.nodeState(NODE)).toBe('WAITING');
    expect(store.approvals()).toEqual([request]);
  });

  it('adopts no approval when none is pending', () => {
    useRunStore.getState().adopt(WF, { id: RUN, status: 'RUNNING', totals: usage }, []);
    expect(useRunStore.getState().approvals()).toEqual([]);
  });
});
