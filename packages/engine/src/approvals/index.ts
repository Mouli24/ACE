import type {
  ApprovalDecision,
  ApprovalDecisionKind,
  ApprovalRequest,
  GuardrailCheckType,
  GuardrailPoint,
  Id,
  NodeRun,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import type { Scope } from '../ports/index.js';
import type { ApprovalRepository, NodeRunLookup } from '../guardrails/ports.js';

/**
 * Approvals — the `ask_user` guardrail action (FR-GRD-013, Arch §21.2, §19.1).
 *
 * What makes this more than a table: the node is *suspended* mid-evaluation. `request()` stores the
 * request, announces it, and does not settle until someone decides, so the guardrail evaluator that
 * awaited it resumes exactly where it paused — the checks after the one that asked still run, and
 * the output that was being judged is still the output that flows on.
 *
 * Two consequences the round file calls out:
 *
 * - **The provider slot must already be free.** Output evaluation runs *after* `runGated` has
 *   returned, so the node holds no provider concurrency while it waits (D66, FR-PRV-009). Nothing
 *   here enforces that; the wiring list does, and `WAITING` is a node state precisely so the
 *   scheduler can dispatch someone else meanwhile (Arch §19.1).
 * - **The wait lives in this process.** A pending approval's promise does not survive a restart, so
 *   crash recovery (FR-SYS-009) has to reject what it finds pending, which is what `cancelPending`
 *   is for.
 */

/** What the evaluator hands over: everything but the id and the time. */
export interface ApprovalRequestInput {
  runId: Id;
  workflowId: Id;
  nodeRunId: Id;
  nodeId: Id;
  nodeName: string;
  point: GuardrailPoint;
  checkType: GuardrailCheckType;
  reason: string;
  /** Already truncated to `APPROVAL_PREVIEW_MAX` by the caller (§2.2). */
  preview: string;
}

/**
 * The narrow view the guardrail evaluator needs. It asks and waits; it never lists, decides or
 * cancels, so it cannot accidentally answer its own question.
 */
export interface ApprovalGate {
  request(input: ApprovalRequestInput): Promise<ApprovalDecision>;
}

export class ApprovalNotFoundError extends Error {
  override readonly name = 'ApprovalNotFoundError';

  constructor(readonly what: string) {
    super(`${what} has no approval waiting for a decision.`);
  }
}

export class ApprovalAlreadyDecidedError extends Error {
  override readonly name = 'ApprovalAlreadyDecidedError';

  constructor(readonly requestId: Id) {
    super(`Approval ${requestId} has already been decided.`);
  }
}

export interface ApprovalService extends ApprovalGate {
  /** `GET /runs/:id/approvals` — the pending ones, as a bare array (§2.5, D78). */
  listPending(runId: Id): Promise<ApprovalRequest[]>;
  /**
   * `POST /node-runs/:id/approve` and `/reject`. The route is the decision (§2.5); the answer is the
   * node run, which the caller reads back once the decision is stored.
   */
  decide(
    nodeRunId: Id,
    kind: ApprovalDecisionKind,
    note?: string,
  ): Promise<{ request: ApprovalRequest; decision: ApprovalDecision; nodeRun: NodeRun | null }>;
  /**
   * Reject everything still waiting on a run, without a user: a Stop, a shutdown or crash recovery
   * must not leave a node awaiting an answer nobody will give (FR-CTL-003, FR-SYS-009).
   */
  cancelPending(runId: Id, note: string): Promise<ApprovalDecision[]>;
}

export interface ApprovalServiceDeps {
  scope: Scope;
  approvals: ApprovalRepository;
  nodeRuns: NodeRunLookup;
  bus: EventBus;
  /**
   * Called after the request is stored and emitted, before the wait begins: the scheduler moves the
   * node run to `WAITING` and emits `node.state`. It is a hook rather than a write from here because
   * node run rows have exactly one writer (the scheduler), which is what keeps concurrent nodes from
   * interleaving on one row.
   */
  onWaiting?: (request: ApprovalRequest) => Promise<void>;
  /** Called once a decision is stored, before the paused evaluation resumes. */
  onDecided?: (request: ApprovalRequest, decision: ApprovalDecision) => Promise<void>;
  now?: () => string;
  nextId?: () => string;
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const { scope, approvals, nodeRuns, bus } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  /** requestId → the resolver of the promise a suspended node is sitting on. */
  const waiting = new Map<Id, (decision: ApprovalDecision) => void>();
  /**
   * runId → workflowId, learnt when the request was made. `ApprovalRequest` does not carry the
   * workflow, and a run-scoped frame is routed by `runId` anyway, so a decision that arrives with
   * this unknown (after a restart) simply emits without it rather than inventing one.
   */
  const workflowOfRun = new Map<Id, Id>();

  async function store(
    request: ApprovalRequest,
    kind: ApprovalDecisionKind,
    note: string | undefined,
  ): Promise<ApprovalDecision> {
    const decision: ApprovalDecision = {
      requestId: request.id,
      decision: kind,
      ...(note === undefined ? {} : { note }),
      // FR-GRD-013: the decision is logged with its time, which is the audit trail, not a nicety.
      decidedAt: now(),
    };

    if (!(await approvals.recordDecision(scope, request.id, decision))) {
      throw new ApprovalAlreadyDecidedError(request.id);
    }

    const workflowId = workflowOfRun.get(request.runId);

    await bus.emit({
      type: 'node.approval_decided',
      ...(workflowId === undefined ? {} : { workflowId }),
      runId: request.runId,
      payload: { runId: request.runId, nodeRunId: request.nodeRunId, decision },
    });

    await deps.onDecided?.(request, decision);

    // Release the node that was waiting. Absent when the decision arrived in another process or
    // after a restart — the row is still correct, there is simply nobody left to wake.
    waiting.get(request.id)?.(decision);
    waiting.delete(request.id);

    return decision;
  }

  return {
    async request(input) {
      const request: ApprovalRequest = {
        id: nextId(),
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        nodeId: input.nodeId,
        nodeName: input.nodeName,
        point: input.point,
        checkType: input.checkType,
        reason: input.reason,
        preview: input.preview,
        requestedAt: now(),
      };

      const stored = await approvals.create(scope, request);
      workflowOfRun.set(input.runId, input.workflowId);

      // Stored before it is announced, so a client that reacts to the event and immediately calls
      // `GET /runs/:id/approvals` finds it there (the same ordering rule as the event log).
      await bus.emit({
        type: 'node.approval_required',
        workflowId: input.workflowId,
        runId: input.runId,
        payload: { runId: input.runId, request: stored },
      });

      const decision = new Promise<ApprovalDecision>((resolve) => {
        waiting.set(stored.id, resolve);
      });

      await deps.onWaiting?.(stored);

      return decision;
    },

    listPending: (runId) => approvals.listPendingByRun(scope, runId),

    async decide(nodeRunId, kind, note) {
      const request = await approvals.findPendingByNodeRun(scope, nodeRunId);
      if (request === null) throw new ApprovalNotFoundError(`Node run ${nodeRunId}`);

      const decision = await store(request, kind, note);
      return { request, decision, nodeRun: await nodeRuns.get(scope, nodeRunId) };
    },

    async cancelPending(runId, note) {
      const pending = await approvals.listPendingByRun(scope, runId);
      const decisions: ApprovalDecision[] = [];

      for (const request of pending) {
        // A reject, not an approve: nobody looked at this content, so nothing about it is approved.
        decisions.push(await store(request, 'reject', note));
      }

      return decisions;
    },
  };
}
