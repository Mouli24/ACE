import type { ApprovalRequest } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { nodeErrorOf } from '../../errors/index.js';
import { FakeGuardrailStore, RecordingBus, id } from '../../guardrails/__tests__/fakes.js';
import type { ApprovalRepository } from '../../guardrails/ports.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import { createApprovalService, type ApprovalRequestInput } from '../index.js';

/**
 * D-054 at the approval service's own seam (FR-CTL-003, FR-GRD-013, D111, D120): the wait listens
 * to the run's abort. A run that is stopped or shut down while a node waits must not hold its drive
 * for ever, must not grow a WAITING row after the stop, and a decision that still arrives must not
 * move the stopped node. The run-level behaviour is `__tests__/stop-while-waiting.test.ts`.
 */

function harness(approvalsFor: (store: FakeGuardrailStore) => ApprovalRepository = (s) => s.approvals) {
  const store = new FakeGuardrailStore();
  const bus = new RecordingBus();
  const waited: ApprovalRequest[] = [];
  const decided: string[] = [];
  const approvals = createApprovalService({
    scope: LOCAL_SCOPE,
    approvals: approvalsFor(store),
    nodeRuns: store.nodeRuns,
    bus,
    onWaiting: async (request) => {
      waited.push(request);
    },
    onDecided: async (_request, decision) => {
      decided.push(decision.decision);
    },
  });
  return { store, bus, approvals, waited, decided };
}

const input = (signal: AbortSignal, runId = id()): ApprovalRequestInput => ({
  runId,
  workflowId: id(),
  nodeRunId: id(),
  nodeId: id(),
  nodeName: 'Writer',
  point: 'output',
  checkType: 'pii',
  reason: 'Personal data found: email.',
  preview: 'Reach me at jane@example.com.',
  signal,
});

/**
 * The `NodeError` a rejected wait carries: a cancellation, which the executor ends STOPPED. Bounded,
 * so a wait that ignores the abort fails the test rather than hanging it.
 */
async function cancellation(wait: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('the wait did not end within 1 s of the abort'), 1_000);
  });
  const error: unknown = await Promise.race([
    wait.then(
      () => 'the wait resolved instead of ending as a cancellation',
      (reason: unknown) => reason,
    ),
    hung,
  ]);
  clearTimeout(timer);
  if (typeof error === 'string') throw new Error(error);
  return nodeErrorOf(error);
}

describe('FR-CTL-003 FR-GRD-013 D-054 an approval wait ends when its run is aborted', () => {
  it('asks nothing when the run is already aborted: no request, no card, no WAITING', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const asked = input(controller.signal);

    expect(await cancellation(h.approvals.request(asked))).toMatchObject({
      kind: 'user_cancelled',
    });
    expect(await h.approvals.listPending(asked.runId)).toEqual([]);
    expect(h.bus.events).toEqual([]);
    expect(h.waited).toEqual([]);
  });

  it('does not put the node in WAITING when the abort lands while the request is being stored', async () => {
    const controller = new AbortController();
    // The stop arrives between the entry check and the wait: during the write of the request.
    const h = harness((store) => ({
      ...store.approvals,
      create: async (scope, request) => {
        controller.abort();
        return store.approvals.create(scope, request);
      },
    }));
    const asked = input(controller.signal);

    expect(await cancellation(h.approvals.request(asked))).toMatchObject({
      kind: 'user_cancelled',
    });
    expect(h.waited).toEqual([]);

    // Stored before the abort, so it is pending until the run's ending rejects it.
    expect(await h.approvals.cancelPending(asked.runId, 'stopped')).toHaveLength(1);
    expect(await h.approvals.listPending(asked.runId)).toEqual([]);
  });

  it('throws a cancellation the moment the run is aborted, and a late approve moves nothing', async () => {
    const h = harness();
    const controller = new AbortController();
    const asked = input(controller.signal);

    const wait = h.approvals.request(asked);
    await expect.poll(() => h.waited.length).toBe(1);

    controller.abort();
    expect(await cancellation(wait)).toMatchObject({ kind: 'user_cancelled' });

    // The approve still finds the request (nobody cancelled it yet) and records it, but there is
    // no suspended node to wake and no row to move back to RUNNING (D111).
    await h.approvals.decide(asked.nodeRunId, 'approve');
    expect(h.decided).toEqual([]);
    expect(await h.approvals.listPending(asked.runId)).toEqual([]);
  });

  it('a decision made before the abort still wakes the node, and a later abort changes nothing', async () => {
    const h = harness();
    const controller = new AbortController();
    const asked = input(controller.signal);

    const wait = h.approvals.request(asked);
    await expect.poll(() => h.waited.length).toBe(1);
    await h.approvals.decide(asked.nodeRunId, 'approve');
    controller.abort();

    expect((await wait).decision).toBe('approve');
    expect(h.decided).toEqual(['approve']);
  });

  it('cancelPending skips a request decided between its listing and its write (D120)', async () => {
    const controller = new AbortController();
    const runId = id();
    let raced = false;
    // The first write loses to a concurrent decision; the second goes through.
    const h = harness((store) => ({
      ...store.approvals,
      recordDecision: async (scope, requestId, decision) => {
        if (!raced) {
          raced = true;
          return false;
        }
        return store.approvals.recordDecision(scope, requestId, decision);
      },
    }));

    void h.approvals.request(input(controller.signal, runId)).catch(() => undefined);
    void h.approvals.request(input(controller.signal, runId)).catch(() => undefined);
    await expect.poll(() => h.waited.length).toBe(2);

    const cancelled = await h.approvals.cancelPending(runId, 'The run was stopped.');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.decision).toBe('reject');
  });
});
