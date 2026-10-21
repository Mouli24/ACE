import type {
  ApprovalDecision,
  BlockedReason,
  BudgetHalt,
  CursorQuery,
  FailureReason,
  HaltReason,
  Id,
  NodeError,
  NodeRun,
  NodeState,
  Page,
  Part,
  Run,
  RunAction,
  RunState,
  Timestamp,
  Usage,
  ValidationIssue,
  Verdict,
} from '@ace/contracts';

import type { Repository, Scope } from '../../ports/index.js';

/**
 * The slice of the store the run controls need, and the patch fields they write.
 *
 * Two reasons this is not just `Repository`. The controls are unit-tested against a handful of
 * rows rather than a whole repository, and — more importantly — round 3 adds four fields to
 * `RunPatch` and six to `NodeRunPatch` in `ports/run-repository.ts`, which is not this module's to
 * edit. `ControlRunPatch` and `ControlNodeRunPatch` below are **the shape being asked for**: once
 * the port carries these fields, `runStoreFor` and `nodeRunStoreFor` bind straight to it, and
 * until then a fake store in the tests honours them.
 */

/** `RunPatch` as the controls need it. The four round-3 fields are the ones the port still lacks. */
export interface ControlRunPatch {
  status?: RunState;
  /** `null` clears it when a reopen makes the run RUNNING again (D81, D388). */
  haltReason?: HaltReason | null;
  preflightIssues?: ValidationIssue[];
  totals?: Usage;
  endedAt?: Timestamp;
  durationMs?: number;
  finalOutput?: Record<Id, Part[]>;

  /* Round 3 (§2.1, §2.3, D71, D80). */

  /**
   * When the run was paused. `null` clears it, which is what `resume` writes: `pausedAt` means
   * "paused since", so a resumed run must not look paused to the UI (D95).
   */
  pausedAt?: Timestamp | null;
  /** `allowedRunActions(status)`, rewritten on every status change so the UI never guesses (D76). */
  allowedActions?: RunAction[];
  /** Set only alongside `haltReason: 'budget_exceeded'` (D80); `null` clears it with it. */
  budgetHalt?: BudgetHalt | null;
  /** Set once, on the run a restart creates (FR-CTL-004). */
  restartedFromRunId?: Id;

  /* Domain (D305). */
  /** Why the run is BLOCKED mid-run; `null` clears it on a resume. */
  blockedReason?: BlockedReason | null;
}

/** `NodeRunPatch` as the controls need it. */
export interface ControlNodeRunPatch {
  status?: NodeState;
  failureReason?: FailureReason;
  error?: NodeError;
  output?: Part[];
  usage?: Usage;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  durationMs?: number;

  /* Round 3 (§2.1, §2.2). */
  verdicts?: Verdict[];
  approvals?: ApprovalDecision[];
}

export interface ControlRunStore {
  get(runId: Id): Promise<Run | null>;
  create(run: Run): Promise<Run>;
  update(runId: Id, patch: ControlRunPatch): Promise<Run | null>;
  /** The workflow's runs, newest first — what Start from node walks back through (D83). */
  recentForWorkflow(workflowId: Id, limit: number): Promise<Run[]>;
}

export interface ControlNodeRunStore {
  get(id: Id): Promise<NodeRun | null>;
  create(nodeRun: NodeRun): Promise<NodeRun>;
  listByRun(runId: Id): Promise<NodeRun[]>;
  update(id: Id, patch: ControlNodeRunPatch): Promise<NodeRun | null>;
}

/**
 * The repository shape `runStoreFor` binds to. Structurally satisfied by `RunRepository` today
 * (TypeScript compares method parameters bivariantly), and soundly satisfied once `RunPatch`
 * carries the round-3 fields above.
 */
interface RunRows {
  create(scope: Scope, run: Run): Promise<Run>;
  get(scope: Scope, id: Id): Promise<Run | null>;
  listByWorkflow(scope: Scope, workflowId: Id, page: CursorQuery): Promise<Page<Run>>;
  update(scope: Scope, id: Id, patch: ControlRunPatch): Promise<Run | null>;
}

interface NodeRunRows {
  create(scope: Scope, nodeRun: NodeRun): Promise<NodeRun>;
  get(scope: Scope, id: Id): Promise<NodeRun | null>;
  listByRun(scope: Scope, runId: Id): Promise<NodeRun[]>;
  update(scope: Scope, id: Id, patch: ControlNodeRunPatch): Promise<NodeRun | null>;
}

export function runStoreFor(rows: RunRows, scope: Scope): ControlRunStore {
  return {
    get: (runId) => rows.get(scope, runId),
    create: (run) => rows.create(scope, run),
    update: (runId, patch) => rows.update(scope, runId, patch),
    recentForWorkflow: async (workflowId, limit) =>
      (await rows.listByWorkflow(scope, workflowId, { limit })).items,
  };
}

export function nodeRunStoreFor(rows: NodeRunRows, scope: Scope): ControlNodeRunStore {
  return {
    get: (id) => rows.get(scope, id),
    create: (nodeRun) => rows.create(scope, nodeRun),
    listByRun: (runId) => rows.listByRun(scope, runId),
    update: (id, patch) => rows.update(scope, id, patch),
  };
}

/** Both stores from one repository — the single call the composition root makes. */
export function controlStoresFor(
  repository: Repository,
  scope: Scope,
): { runs: ControlRunStore; nodeRuns: ControlNodeRunStore } {
  return {
    runs: runStoreFor(repository.runs, scope),
    nodeRuns: nodeRunStoreFor(repository.nodeRuns, scope),
  };
}
