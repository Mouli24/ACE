import type { ApprovalRequest, ServerFrame, Verdict } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { RunEventBuffer } from '../run-view.js';

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const OTHER_RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB8';
const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const A = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const RA = '01ARZ3NDEKTSV4RRFFQ69G5FR1';
const RA2 = '01ARZ3NDEKTSV4RRFFQ69G5FR3';
const LOOP_EDGE = '01ARZ3NDEKTSV4RRFFQ69G5FE2';
const REQUEST = '01ARZ3NDEKTSV4RRFFQ69G5FC2';
const VERDICT = '01ARZ3NDEKTSV4RRFFQ69G5FC3';
const NOW = '2026-09-26T00:00:00.000Z';

const usage = (tokensIn = 0, tokensOut = 0, costUsd = 0) => ({ tokensIn, tokensOut, costUsd });

const state = (seq: number, nodeRunId: string, status: string, iteration = 1): ServerFrame =>
  ({
    type: 'node.state',
    payload: { runId: RUN, nodeRunId, nodeId: A, iteration, attempt: 1, status },
    seq,
  }) as ServerFrame;

const request: ApprovalRequest = {
  id: REQUEST,
  runId: RUN,
  nodeRunId: RA,
  nodeId: A,
  nodeName: 'Reviewer',
  point: 'tool',
  checkType: 'destructive_action',
  reason: 'the tool would delete a folder',
  preview: 'rm -rf /tmp/demo',
  requestedAt: NOW,
};

const verdict: Verdict = {
  id: VERDICT,
  nodeRunId: RA,
  point: 'output',
  checkType: 'pii',
  action: 'redact',
  passed: true,
  reason: 'one email address was redacted',
  redactedTypes: ['email'],
  at: NOW,
};

/**
 * The round 3 scenario every test below replays: a run pauses and resumes, an `ask_user` check
 * puts the node in WAITING, the approval is granted, a verdict is recorded, a loop runs a second
 * iteration and stops at its maximum, and the run completes (§2.6).
 */
const scenario: ServerFrame[] = [
  {
    type: 'run.started',
    payload: {
      run: { id: RUN, workflowId: WF, status: 'RUNNING', startedAt: NOW, totals: usage() },
    },
    seq: 1,
  } as ServerFrame,
  state(2, RA, 'RUNNING'),
  { type: 'run.paused', payload: { runId: RUN }, seq: 3 } as ServerFrame,
  { type: 'run.resumed', payload: { runId: RUN }, seq: 4 } as ServerFrame,
  {
    type: 'node.approval_required',
    payload: { runId: RUN, request },
    seq: 5,
  } as ServerFrame,
  state(6, RA, 'WAITING'),
  {
    type: 'node.approval_decided',
    payload: {
      runId: RUN,
      nodeRunId: RA,
      decision: { requestId: REQUEST, decision: 'approve', decidedAt: NOW },
    },
    seq: 7,
  } as ServerFrame,
  {
    type: 'guardrail.verdict',
    payload: { runId: RUN, nodeRunId: RA, verdict },
    seq: 8,
  } as ServerFrame,
  state(9, RA, 'RUNNING'),
  state(10, RA, 'COMPLETED'),
  {
    type: 'loop.iteration',
    payload: { runId: RUN, edgeId: LOOP_EDGE, targetNodeId: A, iteration: 2 },
    seq: 11,
  } as ServerFrame,
  state(12, RA2, 'RUNNING', 2),
  state(13, RA2, 'COMPLETED', 2),
  {
    type: 'loop.iteration',
    payload: {
      runId: RUN,
      edgeId: LOOP_EDGE,
      targetNodeId: A,
      iteration: 2,
      stop: 'max_iterations',
    },
    seq: 14,
  } as ServerFrame,
  {
    type: 'run.completed',
    payload: { runId: RUN, status: 'COMPLETE', totals: usage(10, 20, 0.002) },
    seq: 15,
  } as ServerFrame,
];

const upTo = (seq: number): RunEventBuffer => {
  const buffer = new RunEventBuffer();
  for (const frame of scenario) {
    if ('seq' in frame && frame.seq <= seq) buffer.apply(frame);
  }
  return buffer;
};

const fold = (frames: ServerFrame[]): RunEventBuffer => {
  const buffer = new RunEventBuffer();
  for (const frame of frames) buffer.apply(frame);
  return buffer;
};

describe('FR-CTL-001/002 pause and resume in the RunView (round 3 §2.6)', () => {
  it('TC-CTL-001 a paused run says when it paused and offers resume and stop', () => {
    const view = upTo(3).view;
    expect(view.status).toBe('PAUSED');
    expect(view.pausedAt).toBeDefined();
    expect(view.allowedActions).toEqual(['resume', 'stop']);
  });

  it('TC-CTL-002 resuming clears pausedAt and offers pause and stop again', () => {
    const view = upTo(4).view;
    expect(view.status).toBe('RUNNING');
    expect(view.pausedAt).toBeUndefined();
    expect(view.allowedActions).toEqual(['pause', 'stop']);
  });

  it('TC-CTL-006 the actions are undefined before any frame and restart once it ended', () => {
    expect(new RunEventBuffer().view.allowedActions).toBeUndefined();
    const ended = fold(scenario).view;
    expect(ended.status).toBe('COMPLETE');
    expect(ended.allowedActions).toEqual(['restart']);
    expect(ended.pausedAt).toBeUndefined();
  });

  it('a run stopped while paused is no longer paused (D76)', () => {
    const buffer = upTo(3);
    buffer.apply({
      type: 'run.completed',
      payload: { runId: RUN, status: 'HALTED', haltReason: 'stopped', totals: usage() },
      seq: 20,
    } as ServerFrame);
    expect(buffer.view.pausedAt).toBeUndefined();
    expect(buffer.view.haltReason).toBe('stopped');
  });
});

describe('TC-GRD-008 approvals in the RunView (FR-GRD-013)', () => {
  it('an approval is pending from the request until the decision arrives', () => {
    expect(upTo(6).view.approvals()).toEqual([request]);
    expect(upTo(7).view.approvals()).toEqual([]);
  });

  it('a decision for another request leaves this one pending', () => {
    const buffer = upTo(6);
    buffer.apply({
      type: 'node.approval_decided',
      payload: {
        runId: RUN,
        nodeRunId: RA,
        decision: {
          requestId: '01ARZ3NDEKTSV4RRFFQ69G5FC9',
          decision: 'reject',
          decidedAt: NOW,
        },
      },
      seq: 30,
    } as ServerFrame);
    expect(buffer.view.approvals().map((a) => a.id)).toEqual([REQUEST]);
  });
});

describe('TC-GRD-019 verdicts in the RunView (FR-GRD-015)', () => {
  it('verdicts are kept per node run and name the type, never the value (FR-GRD-014)', () => {
    const view = fold(scenario).view;
    expect(view.verdicts(RA)).toEqual([verdict]);
    expect(view.verdicts(RA)[0]?.redactedTypes).toEqual(['email']);
    expect(view.verdicts(RA2)).toEqual([]);
  });

  it('the list handed out is a copy, so a caller cannot grow the buffer', () => {
    const buffer = fold(scenario);
    buffer.view.verdicts(RA).push(verdict);
    expect(buffer.view.verdicts(RA)).toHaveLength(1);
  });
});

describe('TC-PAR-006 iterations in the RunView (FR-PAR-005)', () => {
  it('the highest iteration a node reached, from node.state and loop.iteration', () => {
    expect(fold(scenario).view.iterations(A)).toBe(2);
    expect(upTo(10).view.iterations(A)).toBe(1);
  });

  it('a node the run has not reached has run no iterations', () => {
    expect(new RunEventBuffer().view.iterations(A)).toBe(0);
  });

  it('a loop.iteration alone is enough, before the first node.state of that iteration', () => {
    expect(upTo(11).view.iterations(A)).toBe(2);
  });

  it('a later frame never lowers the count (frames can arrive out of order on a replay)', () => {
    const buffer = fold(scenario);
    buffer.apply(state(40, RA, 'COMPLETED', 1));
    expect(buffer.view.iterations(A)).toBe(2);
  });
});

describe('FR-EXE-014 the round 3 frames fold idempotently', () => {
  it('repeating a persisted frame changes nothing', () => {
    const once = fold(scenario).view;
    const twice = fold([...scenario, ...scenario.slice(4)]).view;

    expect(twice.approvals()).toEqual(once.approvals());
    expect(twice.verdicts(RA)).toEqual(once.verdicts(RA));
    expect(twice.iterations(A)).toBe(once.iterations(A));
    expect(twice.status).toBe(once.status);
    expect(twice.lastSeq).toBe(once.lastSeq);
  });

  it('a drop and a resume mid-scenario produce the same view as an uninterrupted run', () => {
    const uninterrupted = fold(scenario).view;

    // the socket drops after the approval was raised, then the engine replays everything after
    // the last seq this client saw (§2.9)
    const dropped = upTo(6);
    const anchor = dropped.view.lastSeq;
    expect(anchor).toBe(6);
    for (const frame of scenario) {
      if ('seq' in frame && frame.seq > anchor) dropped.apply(frame);
    }
    const resumed = dropped.view;

    expect(resumed.status).toBe(uninterrupted.status);
    expect(resumed.pausedAt).toBe(uninterrupted.pausedAt);
    expect(resumed.allowedActions).toEqual(uninterrupted.allowedActions);
    expect(resumed.approvals()).toEqual(uninterrupted.approvals());
    expect(resumed.verdicts(RA)).toEqual(uninterrupted.verdicts(RA));
    expect(resumed.iterations(A)).toBe(uninterrupted.iterations(A));
    expect(resumed.lastSeq).toBe(uninterrupted.lastSeq);
  });

  it('frames belonging to another run are ignored, verdicts and approvals included', () => {
    const buffer = fold(scenario);
    buffer.apply({
      type: 'guardrail.verdict',
      payload: { runId: OTHER_RUN, nodeRunId: RA, verdict },
      seq: 50,
    } as ServerFrame);
    buffer.apply({
      type: 'node.approval_required',
      payload: { runId: OTHER_RUN, request: { ...request, runId: OTHER_RUN } },
      seq: 51,
    } as ServerFrame);
    buffer.apply({ type: 'run.paused', payload: { runId: OTHER_RUN }, seq: 52 } as ServerFrame);

    expect(buffer.view.verdicts(RA)).toHaveLength(1);
    expect(buffer.view.approvals()).toEqual([]);
    expect(buffer.view.status).toBe('COMPLETE');
  });

  it('reset clears the round 3 state too', () => {
    const buffer = upTo(8);
    buffer.reset();
    const view = buffer.view;
    expect(view.pausedAt).toBeUndefined();
    expect(view.allowedActions).toBeUndefined();
    expect(view.approvals()).toEqual([]);
    expect(view.verdicts(RA)).toEqual([]);
    expect(view.iterations(A)).toBe(0);
  });
});
