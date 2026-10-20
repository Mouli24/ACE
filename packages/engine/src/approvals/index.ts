import type {
  ApprovalCommand,
  ApprovalDecision,
  ApprovalDecisionKind,
  GuardrailCheckType,
  GuardrailPoint,
  Id,
  NodeRun,
} from '@ace/contracts';

import { userCancelledError } from '../errors/index.js';
import type { EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import type { RunApprovalRequest, Scope } from '../ports/index.js';
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
 *
 * And one the round file does not, which D-054 found: **the wait listens to the run's abort.** A
 * Stop or a shutdown while a node is WAITING must end the run within FR-CTL-003's two seconds, and
 * nobody is going to answer an approval on a run that is ending — so the wait throws the
 * cancellation the moment the run is aborted, rather than holding the drive for ever. The request
 * itself is rejected by whoever ends the run (`cancelPending`), and a decision that still reaches it
 * does not wake, or move, a node that has stopped waiting.
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
  /** D376: an agentic node's `run_command`, already masked and cut by the caller. */
  command?: ApprovalCommand;
  /**
   * The run's abort signal (FR-CTL-003, D110). Aborted — by a Stop or a shutdown — the wait throws a
   * `user_cancelled` error at once instead of waiting for a decision nobody will make (D-054).
   * Never stored: it is how the wait ends, not part of the request.
   */
  signal?: AbortSignal;
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

/** What the routes answer 400 `validation_failed` with when `always: true` has nothing to save (D376). */
export const CANNOT_ALWAYS_ALLOW = "This command can't be always-allowed.";

/**
 * D376: `always: true` on a request whose card offers no Always allow — no command, no prefix (a
 * compound or unreadable line, a denylist hit) — or on a reject. The request stays pending.
 */
export class ApprovalAlwaysRefusedError extends Error {
  override readonly name = 'ApprovalAlwaysRefusedError';

  constructor(message: string = CANNOT_ALWAYS_ALLOW) {
    super(message);
  }
}

/** How a person decided, beyond approve or reject (FR-GRD-013, D376). */
export interface ApprovalDecisionOptions {
  note?: string;
  /** Approve and save the request's `command.allowPrefix` on the node (D376). */
  always?: boolean;
}

export class ApprovalAlreadyDecidedError extends Error {
  override readonly name = 'ApprovalAlreadyDecidedError';

  constructor(readonly requestId: Id) {
    super(`Approval ${requestId} has already been decided.`);
  }
}

export interface ApprovalService extends ApprovalGate {
  /** `GET /runs/:id/approvals` — the pending ones, as a bare array (§2.5, D78). */
  listPending(runId: Id): Promise<RunApprovalRequest[]>;
  /**
   * `POST /node-runs/:id/approve` and `/reject`. The route is the decision (§2.5); the answer is the
   * node run, which the caller reads back once the decision is stored. D376: `always` on an approve
   * records the request's `command.allowPrefix` with the decision and hands it to `onAlways`; with
   * nothing to save it throws `ApprovalAlwaysRefusedError` and decides nothing.
   */
  decide(
    nodeRunId: Id,
    kind: ApprovalDecisionKind,
    options?: ApprovalDecisionOptions,
  ): Promise<{ request: RunApprovalRequest; decision: ApprovalDecision; nodeRun: NodeRun | null }>;
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
  onWaiting?: (request: RunApprovalRequest) => Promise<void>;
  /**
   * Called once a decision is stored, before the paused evaluation resumes. Not called for a request
   * nobody in this process is waiting on — one whose wait the run's abort ended (D-054), or one a
   * dead process left pending (D-061): there is no paused evaluation to resume, and the node it
   * would move is STOPPED (D111).
   */
  onDecided?: (request: RunApprovalRequest, decision: ApprovalDecision) => Promise<void>;
  /**
   * D376: an approve with Always allow, once it is stored and before the paused evaluation resumes —
   * the server adds the prefix to the live run's allowlist and saves it on the workflow's node, so
   * the node's next identical command runs without a card.
   */
  onAlways?: (runId: Id, nodeId: Id, prefix: string) => Promise<void>;
  now?: () => string;
  nextId?: () => string;
}

/** What a wait the run's abort ended throws: a cancellation, so the node ends STOPPED (FR-ERR-007). */
function cancelledWait(): Error {
  return userCancelledError('The run was stopped while this node waited for an approval.');
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const { scope, approvals, nodeRuns, bus } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  /**
   * requestId → the resolver of the promise a suspended node is sitting on. A request with no entry
   * is one nobody in this process waits on: its wait was ended by the run's abort (D-054), or the
   * process that asked is gone (D-061).
   */
  const waiting = new Map<Id, (decision: ApprovalDecision) => void>();
  /**
   * runId → workflowId, learnt when the request was made. `ApprovalRequest` does not carry the
   * workflow, and a run-scoped frame is routed by `runId` anyway, so a decision that arrives with
   * this unknown (after a restart) simply emits without it rather than inventing one.
   */
  const workflowOfRun = new Map<Id, Id>();

  async function store(
    request: RunApprovalRequest,
    kind: ApprovalDecisionKind,
    note: string | undefined,
    /** D376: the prefix an Always allow saves; only ever set on an approve. */
    alwaysPrefix?: string,
  ): Promise<ApprovalDecision> {
    const decision: ApprovalDecision = {
      requestId: request.id,
      decision: kind,
      ...(note === undefined ? {} : { note }),
      ...(alwaysPrefix === undefined ? {} : { always: true, prefix: alwaysPrefix }),
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

    /*
     * Only a node that is still suspended here resumes, so only then may its row move. A request
     * nobody waits on — its wait ended by a Stop (D-054), or left by a process that died (D-061) —
     * belongs to a node that is STOPPED, and "approved" moving that back to RUNNING would leave a
     * row nothing will ever finish inside a HALTED run (D111). The decision is still recorded.
     */
    const waiter = waiting.get(request.id);
    waiting.delete(request.id);

    try {
      // D376: saved before the node wakes, so its next identical command already finds the prefix.
      if (alwaysPrefix !== undefined) {
        await deps.onAlways?.(request.runId, request.nodeId, alwaysPrefix);
      }
      if (waiter !== undefined) await deps.onDecided?.(request, decision);
    } finally {
      // Woken even if a hook failed: a node left suspended for ever is the worse outcome.
      waiter?.(decision);
    }

    return decision;
  }

  return {
    async request(input) {
      const { signal } = input;
      // Read afresh each time: the run can be aborted during any of the awaits below.
      const aborted = (): boolean => signal?.aborted === true;
      // A run already stopped asks nobody anything: no card for a run that is ending (D-054).
      if (aborted()) throw cancelledWait();

      const request: RunApprovalRequest = {
        id: nextId(),
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        nodeId: input.nodeId,
        nodeName: input.nodeName,
        point: input.point,
        checkType: input.checkType,
        reason: input.reason,
        preview: input.preview,
        ...(input.command === undefined ? {} : { command: input.command }),
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

      let abandon = (): void => undefined;
      const decision = new Promise<ApprovalDecision>((resolve, reject) => {
        abandon = () => {
          waiting.delete(stored.id);
          reject(cancelledWait());
        };
        waiting.set(stored.id, (decided) => {
          signal?.removeEventListener('abort', abandon);
          resolve(decided);
        });
      });

      /*
       * D-054: a Stop or a shutdown ends the wait. Checked again here because the run may have been
       * aborted while the request was being stored — and then the node is not put in WAITING at
       * all: the stop has already ended it STOPPED, and a WAITING row written after that would be
       * a live approval card on a dead run (D111).
       */
      if (aborted()) {
        abandon();
        return decision;
      }
      signal?.addEventListener('abort', abandon, { once: true });

      await deps.onWaiting?.(stored);

      return decision;
    },

    listPending: (runId) => approvals.listPendingByRun(scope, runId),

    async decide(nodeRunId, kind, options = {}) {
      const request = await approvals.findPendingByNodeRun(scope, nodeRunId);
      if (request === null) throw new ApprovalNotFoundError(`Node run ${nodeRunId}`);

      let alwaysPrefix: string | undefined;
      if (options.always === true) {
        if (kind !== 'approve') {
          throw new ApprovalAlwaysRefusedError('Always allow goes with an approve, not a reject.');
        }
        alwaysPrefix = request.command?.allowPrefix;
        if (alwaysPrefix === undefined) throw new ApprovalAlwaysRefusedError();
      }

      const decision = await store(request, kind, options.note, alwaysPrefix);
      return { request, decision, nodeRun: await nodeRuns.get(scope, nodeRunId) };
    },

    async cancelPending(runId, note) {
      const pending = await approvals.listPendingByRun(scope, runId);
      const decisions: ApprovalDecision[] = [];

      for (const request of pending) {
        // A reject, not an approve: nobody looked at this content, so nothing about it is approved.
        try {
          decisions.push(await store(request, 'reject', note));
        } catch (error) {
          // Someone decided it between the listing and this write (D120). It is not pending any
          // more, which is all a cancellation wants — and a Stop must not fail over it (D-054).
          if (!(error instanceof ApprovalAlreadyDecidedError)) throw error;
        }
      }

      return decisions;
    },
  };
}
