import type { RunApprovalRequest } from '../../ports/index.js';
import { APPROVAL_PREVIEW_MAX, type NodeRun, type Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  FakeGuardrailStore,
  RecordingBus,
  check,
  fakeChecks,
  fakeMasker,
  id,
  policy,
} from '../../guardrails/__tests__/fakes.js';
import {
  createGuardrailEvaluator,
  type EvaluationTarget,
  type GuardrailEvaluator,
} from '../../guardrails/evaluator.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  createApprovalService,
  type ApprovalService,
} from '../index.js';

/**
 * FR-GRD-013 and Arch §21.2, end to end inside the engine: a check asks, the node waits, a decision
 * arrives, the evaluation resumes from where it paused.
 */

interface Harness {
  approvals: ApprovalService;
  evaluator: GuardrailEvaluator;
  store: FakeGuardrailStore;
  bus: RecordingBus;
  target: EvaluationTarget;
  waited: RunApprovalRequest[];
  decided: RunApprovalRequest[];
}

function harness(action: 'ask_user' | 'block' = 'ask_user'): Harness {
  const store = new FakeGuardrailStore();
  const bus = new RecordingBus();
  const waited: RunApprovalRequest[] = [];
  const decided: RunApprovalRequest[] = [];

  const approvals = createApprovalService({
    scope: LOCAL_SCOPE,
    approvals: store.approvals,
    nodeRuns: store.nodeRuns,
    bus,
    onWaiting: async (request) => {
      waited.push(request);
    },
    onDecided: async (request) => {
      decided.push(request);
    },
  });

  const evaluator = createGuardrailEvaluator({
    scope: LOCAL_SCOPE,
    checks: fakeChecks,
    masker: fakeMasker,
    verdicts: store.verdicts,
    bus,
    approvals,
  });

  const target: EvaluationTarget = {
    runId: id(),
    workflowId: id(),
    nodeRunId: id(),
    nodeId: id(),
    nodeName: 'Writer',
    iteration: 1,
    policy: policy({ checks: [check({ point: 'output', type: 'pii', action })] }),
  };

  const nodeRun: NodeRun = {
    id: target.nodeRunId,
    runId: target.runId,
    nodeId: target.nodeId,
    iteration: 1,
    attempt: 1,
    status: 'WAITING',
    inputEnvelopes: [],
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    verdicts: [],
    toolCalls: [],
  };
  store.nodeRunRows.set(nodeRun.id, nodeRun);

  return { approvals, evaluator, store, bus, target, waited, decided };
}

const text = (value: string): Part[] => [{ type: 'text', text: value }];
const EMAIL_TEXT = 'Write to nobody@example.com about the launch.';

/** Wait until the approval card exists, without racing a fixed timeout. */
async function pending(approvals: ApprovalService, runId: string): Promise<RunApprovalRequest> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [request] = await approvals.listPending(runId);
    if (request !== undefined) return request;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('No approval was ever requested.');
}

describe('TC-GRD-008 Approval approve', () => {
  it('asks, waits, and continues from where it paused once approved', async () => {
    const { approvals, evaluator, target, bus, waited, decided } = harness();

    const evaluation = evaluator.evaluateOutput({ target, parts: text(EMAIL_TEXT) });
    const request = await pending(approvals, target.runId);

    // The card exists, is announced, and the scheduler was told to move the node to WAITING.
    expect(bus.ofType('node.approval_required')).toHaveLength(1);
    expect(waited.map((entry) => entry.id)).toEqual([request.id]);
    expect(request.nodeName).toBe('Writer');
    expect(request.checkType).toBe('pii');
    expect(request.point).toBe('output');
    expect(request.preview).toBe(EMAIL_TEXT);
    expect(request.reason).toContain('email');

    const { decision, nodeRun } = await approvals.decide(target.nodeRunId, 'approve', {
      note: 'Fine by me',
    });

    // FR-GRD-013: the decision is logged with its time.
    expect(decision).toMatchObject({
      requestId: request.id,
      decision: 'approve',
      note: 'Fine by me',
    });
    expect(Date.parse(decision.decidedAt)).not.toBeNaN();
    expect(nodeRun?.id).toBe(target.nodeRunId);
    expect(decided.map((entry) => entry.id)).toEqual([request.id]);
    expect(bus.ofType('node.approval_decided')).toHaveLength(1);

    const outcome = await evaluation;

    expect(outcome.kind).toBe('continue');
    // Approved means the output is unchanged: the user looked at this text and said yes.
    expect(outcome.parts).toEqual(text(EMAIL_TEXT));
    // The pending list is empty once decided, so the UI stops showing the card.
    expect(await approvals.listPending(target.runId)).toEqual([]);
  });

  it('the remaining checks still run after an approval', async () => {
    const { approvals, evaluator, target } = harness();
    target.policy = policy({
      checks: [
        check({ point: 'output', type: 'pii', action: 'ask_user' }),
        check({ point: 'output', type: 'required_citations', action: 'block' }),
      ],
    });

    const evaluation = evaluator.evaluateOutput({ target, parts: text(EMAIL_TEXT) });
    await pending(approvals, target.runId);
    await approvals.decide(target.nodeRunId, 'approve');

    const outcome = await evaluation;

    // Approving the PII did not approve everything else: the citation check still failed the node.
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.verdicts.map((verdict) => verdict.checkType)).toEqual([
      'pii',
      'required_citations',
    ]);
  });

  it('truncates a long preview to the contract’s limit', async () => {
    const { approvals, evaluator, target } = harness();

    const evaluation = evaluator.evaluateOutput({
      target,
      parts: text(`nobody@example.com ${'x'.repeat(2_000)}`),
    });
    const request = await pending(approvals, target.runId);
    await approvals.decide(target.nodeRunId, 'approve');
    await evaluation;

    expect(request.preview).toHaveLength(APPROVAL_PREVIEW_MAX);
  });
});

describe('TC-GRD-009 Approval reject', () => {
  it('fails the node GUARDRAIL_VIOLATION and keeps the note', async () => {
    const { approvals, evaluator, target, store } = harness();

    const evaluation = evaluator.evaluateOutput({ target, parts: text(EMAIL_TEXT) });
    const request = await pending(approvals, target.runId);
    await approvals.decide(target.nodeRunId, 'reject', { note: 'Do not send personal data' });

    const outcome = await evaluation;

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.failureReason).toBe('GUARDRAIL_VIOLATION');
    expect(outcome.error.kind).toBe('guardrail');
    expect(outcome.error.code).toBe('approval_rejected');
    expect(outcome.error.message).toContain('Do not send personal data');

    // The decision is stored against the request, with its time (FR-GRD-013).
    const stored = await store.approvals.get(LOCAL_SCOPE, request.id);
    expect(stored?.decision).toMatchObject({ decision: 'reject' });
  });
});

describe('FR-GRD-013 Deciding twice, and deciding nothing', () => {
  it('refuses a second decision on one request', async () => {
    const { approvals, evaluator, target } = harness();

    const evaluation = evaluator.evaluateOutput({ target, parts: text(EMAIL_TEXT) });
    await pending(approvals, target.runId);
    await approvals.decide(target.nodeRunId, 'approve');
    await evaluation;

    // The first decision cleared the pending row, so the second call finds nothing to decide.
    await expect(approvals.decide(target.nodeRunId, 'reject')).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );
  });

  it('refuses a decision for a node run that is not waiting', async () => {
    const { approvals } = harness();
    await expect(approvals.decide(id(), 'approve')).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });

  it('a stop rejects everything still waiting, so no node hangs (FR-CTL-003)', async () => {
    const { approvals, evaluator, target } = harness();

    const evaluation = evaluator.evaluateOutput({ target, parts: text(EMAIL_TEXT) });
    await pending(approvals, target.runId);

    const cancelled = await approvals.cancelPending(target.runId, 'The run was stopped.');

    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.decision).toBe('reject');
    const outcome = await evaluation;
    expect(outcome.kind).toBe('failed');
    expect(await approvals.listPending(target.runId)).toEqual([]);
  });

  it('cancelPending on a run with nothing waiting does nothing', async () => {
    const { approvals, target } = harness();
    expect(await approvals.cancelPending(target.runId, 'stopped')).toEqual([]);
  });

  it('refuses when the row was decided between the lookup and the write (a two-client race)', async () => {
    const store = new FakeGuardrailStore();
    const bus = new RecordingBus();
    const runId = id();
    const nodeRunId = id();

    const request: RunApprovalRequest = {
      id: id(),
      runId,
      nodeRunId,
      nodeId: id(),
      nodeName: 'Writer',
      point: 'output',
      checkType: 'pii',
      reason: 'Personal data found: email.',
      preview: EMAIL_TEXT,
      requestedAt: '2026-09-26T09:00:00.000Z',
    };
    await store.approvals.create(LOCAL_SCOPE, request);

    const approvals = createApprovalService({
      scope: LOCAL_SCOPE,
      // The lookup still sees it pending; the write loses the race. Two clients pressing Approve and
      // Reject at once is exactly this, and the second must be told rather than silently ignored.
      approvals: { ...store.approvals, recordDecision: async () => false },
      nodeRuns: store.nodeRuns,
      bus,
    });

    await expect(approvals.decide(nodeRunId, 'approve')).rejects.toBeInstanceOf(
      ApprovalAlreadyDecidedError,
    );
    expect(bus.ofType('node.approval_decided')).toEqual([]);
  });
});
