import type { ServerFrame } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { RunEventBuffer } from '../run-view.js';

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const A = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const B = '01ARZ3NDEKTSV4RRFFQ69G5FA2';
const RA = '01ARZ3NDEKTSV4RRFFQ69G5FR1';
const RB = '01ARZ3NDEKTSV4RRFFQ69G5FR2';
const EDGE = '01ARZ3NDEKTSV4RRFFQ69G5FE1';
const NOW = '2026-09-23T00:00:00.000Z';

const usage = (tokensIn = 0, tokensOut = 0, costUsd = 0) => ({ tokensIn, tokensOut, costUsd });

const state = (seq: number, nodeId: string, nodeRunId: string, status: string): ServerFrame =>
  ({
    type: 'node.state',
    payload: { runId: RUN, nodeRunId, nodeId, iteration: 1, attempt: 1, status },
    seq,
  }) as ServerFrame;

const token = (nodeRunId: string, delta: string): ServerFrame =>
  ({ type: 'node.token', payload: { runId: RUN, nodeRunId, delta } }) as ServerFrame;

const output = (seq: number, nodeId: string, nodeRunId: string, text: string): ServerFrame =>
  ({
    type: 'node.output',
    payload: {
      runId: RUN,
      nodeRunId,
      nodeId,
      output: [{ type: 'text', text }],
      usage: usage(10, 20, 0.002),
      modelUsed: { providerId: A, modelId: 'mock-1', viaFallback: true },
    },
    seq,
  }) as ServerFrame;

/** The scenario every live-run test replays: A streams, hands to B, the run completes. */
const linear: ServerFrame[] = [
  {
    type: 'run.started',
    payload: {
      run: {
        id: RUN,
        workflowId: B,
        status: 'RUNNING',
        startedAt: NOW,
        totals: usage(),
      },
    },
    seq: 1,
  } as ServerFrame,
  state(2, A, RA, 'RUNNING'),
  token(RA, 'Hel'),
  token(RA, 'lo'),
  output(3, A, RA, 'Hello'),
  state(4, A, RA, 'COMPLETED'),
  {
    type: 'edge.transfer',
    payload: {
      runId: RUN,
      edgeId: EDGE,
      fromNodeId: A,
      toNodeId: B,
      iteration: 1,
      summary: 'Hello',
    },
    seq: 5,
  } as ServerFrame,
  state(6, B, RB, 'RUNNING'),
  {
    type: 'usage.updated',
    payload: { runId: RUN, totals: usage(10, 20, 0.002) },
    seq: 7,
  } as ServerFrame,
  state(8, B, RB, 'COMPLETED'),
  {
    type: 'run.completed',
    payload: { runId: RUN, status: 'COMPLETE', totals: usage(20, 40, 0.004) },
    seq: 9,
  } as ServerFrame,
];

describe('RunEventBuffer folds run events into a RunView (§2.4)', () => {
  it('tracks node states, streamed text, usage and the final status', () => {
    const buffer = new RunEventBuffer();
    for (const frame of linear) buffer.apply(frame);
    const view = buffer.view;

    expect(view.runId).toBe(RUN);
    expect(view.status).toBe('COMPLETE');
    expect(view.nodeState(A)).toBe('COMPLETED');
    expect(view.nodeState(B)).toBe('COMPLETED');
    expect(view.streamedText(RA)).toBe('Hello');
    expect(view.totals).toEqual(usage(20, 40, 0.004));
    expect(view.lastSeq).toBe(9);
  });

  it('keeps the model used and flags a fallback (FR-RTR-006)', () => {
    const buffer = new RunEventBuffer();
    for (const frame of linear) buffer.apply(frame);
    expect(buffer.view.nodeRun(A)?.modelUsed).toEqual({
      providerId: A,
      modelId: 'mock-1',
      viaFallback: true,
    });
    expect(buffer.view.nodeRun(A)?.output).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('records an edge transfer so the Canvas can animate it (FR-EXE-015)', () => {
    const buffer = new RunEventBuffer();
    for (const frame of linear) buffer.apply(frame);
    const transfer = buffer.view.lastTransfer(EDGE);
    expect(transfer?.summary).toBe('Hello');
    expect(transfer?.at).toBeGreaterThan(0);
  });

  it('an error leaves the node FAILED with its reason and error intact (BR-03)', () => {
    const buffer = new RunEventBuffer();
    buffer.apply(state(1, A, RA, 'RUNNING'));
    buffer.apply({
      type: 'node.error',
      payload: {
        runId: RUN,
        nodeRunId: RA,
        nodeId: A,
        error: { kind: 'agent', code: 'contract', message: 'bad json', retryable: false },
        failureReason: 'CONTRACT_VIOLATION',
      },
      seq: 2,
    } as ServerFrame);
    buffer.apply(state(3, A, RA, 'FAILED'));

    expect(buffer.view.nodeState(A)).toBe('FAILED');
    expect(buffer.view.nodeRun(A)?.failureReason).toBe('CONTRACT_VIOLATION');
    expect(buffer.view.nodeRun(A)?.error?.message).toBe('bad json');
  });

  it('a node not yet seen is IDLE, so the Canvas can render before the first frame', () => {
    expect(new RunEventBuffer().view.nodeState(A)).toBe('IDLE');
  });

  it('replaying the same frames twice gives the same view (a resume must be idempotent)', () => {
    const once = new RunEventBuffer();
    for (const frame of linear) once.apply(frame);

    const twice = new RunEventBuffer();
    for (const frame of linear) twice.apply(frame);
    // the server replays everything after the last seq the client saw; overlap is possible
    for (const frame of linear.slice(4)) twice.apply(frame);

    expect(twice.view.nodeState(A)).toBe(once.view.nodeState(A));
    expect(twice.view.totals).toEqual(once.view.totals);
    expect(twice.view.lastSeq).toBe(once.view.lastSeq);
    // tokens are transient and are not replayed, so the text must not double up
    expect(twice.view.streamedText(RA)).toBe('Hello');
  });

  it('a drop mid-scenario and a resume produce the same view as an uninterrupted run', () => {
    const uninterrupted = new RunEventBuffer();
    for (const frame of linear) uninterrupted.apply(frame);

    const dropped = new RunEventBuffer();
    for (const frame of linear.slice(0, 5)) dropped.apply(frame);
    const anchor = dropped.view.lastSeq;
    // the socket reconnects and the engine replays everything after `anchor`
    for (const frame of linear) {
      if (frame.type !== 'node.token' && 'seq' in frame && frame.seq > anchor) dropped.apply(frame);
    }

    expect(dropped.view.status).toBe(uninterrupted.view.status);
    expect(dropped.view.nodeState(A)).toBe(uninterrupted.view.nodeState(A));
    expect(dropped.view.nodeState(B)).toBe(uninterrupted.view.nodeState(B));
    expect(dropped.view.totals).toEqual(uninterrupted.view.totals);
  });

  it('ignores frames belonging to another run', () => {
    const buffer = new RunEventBuffer();
    for (const frame of linear) buffer.apply(frame);
    const other = { ...state(20, A, RA, 'FAILED') } as ServerFrame & { payload: { runId: string } };
    other.payload = { ...other.payload, runId: B };
    buffer.apply(other);
    expect(buffer.view.nodeState(A)).toBe('COMPLETED');
  });

  it('reset clears everything for the next run', () => {
    const buffer = new RunEventBuffer();
    for (const frame of linear) buffer.apply(frame);
    buffer.reset();
    expect(buffer.view.runId).toBeUndefined();
    expect(buffer.view.nodeState(A)).toBe('IDLE');
    expect(buffer.view.totals).toEqual(usage());
  });
});
