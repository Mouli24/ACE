import type {
  BudgetHalt,
  CliPermission,
  CursorQuery,
  DataType,
  HaltReason,
  Id,
  Model,
  ModelQuery,
  NodeError,
  NodeRun,
  NodeState,
  Page,
  Part,
  Provider,
  ProviderState,
  Run,
  RunAction,
  RunState,
  Timestamp,
  Usage,
  ValidationIssue,
} from '@ace/contracts';

import type { Scope } from './scope.js';

/**
 * The round 2 half of the relational store (Arch §15.3): providers, the model catalog, the price
 * tables, runs and node runs.
 *
 * Two rules shape these interfaces. A provider row has **no key column** — the key lives in the
 * `SecretStore` and only `keySet` is persisted (FR-PRV-002, BR-07). And a run's `snapshot` is
 * written by `create` and never appears in an update patch, because BR-04 makes it immutable.
 */

/** Everything about a provider except the things the user cannot change. */
export interface ProviderPatch {
  name?: string;
  baseUrl?: string | null;
  keySet?: boolean;
  status?: ProviderState;
  statusMessage?: string | null;
  lastCheckedAt?: Timestamp;
  concurrency?: number;
  /** X1 (D262): a CLI provider's permission preset. */
  cliPermission?: CliPermission | null;
  updatedAt?: Timestamp;
}

export interface ProviderRepository {
  create(scope: Scope, provider: Provider): Promise<Provider>;
  get(scope: Scope, id: Id): Promise<Provider | null>;
  /** Oldest first: the order a user added them, which is the order they expect to see. */
  list(scope: Scope): Promise<Provider[]>;
  update(scope: Scope, id: Id, patch: ProviderPatch): Promise<Provider | null>;
  delete(scope: Scope, id: Id): Promise<boolean>;
}

export interface ModelRepository {
  /** A refresh replaces a provider's catalog wholesale, so a withdrawn model disappears. */
  replaceForProvider(scope: Scope, providerId: Id, models: readonly Model[]): Promise<void>;
  list(scope: Scope, query: ModelQuery): Promise<Model[]>;
  find(scope: Scope, providerId: Id, modelId: string): Promise<Model | null>;
  deleteForProvider(scope: Scope, providerId: Id): Promise<void>;
}

/** One frozen price table (FR-OBS-003). Written once per version and never updated. */
export interface PriceTable {
  version: string;
  data: Record<string, { inputPer1k: number; outputPer1k: number }>;
  createdAt: Timestamp;
}

export interface PriceTableRepository {
  /** Ignores a version that already exists — an old estimate must stay reproducible. */
  put(scope: Scope, table: PriceTable): Promise<void>;
  get(scope: Scope, version: string): Promise<PriceTable | null>;
  list(scope: Scope): Promise<PriceTable[]>;
}

/** Everything a run may change after it starts. The snapshot is deliberately absent (BR-04). */
export interface RunPatch {
  status?: RunState;
  /**
   * Written exactly once, by the run service, the moment pre-flight finishes. It is a patch
   * rather than part of `create` because the snapshot has to exist before pre-flight can check
   * it, and BR-04 puts the snapshot in the same transaction as the row.
   */
  preflightIssues?: ValidationIssue[];
  haltReason?: HaltReason;
  totals?: Usage;
  endedAt?: Timestamp;
  durationMs?: number;
  finalOutput?: Record<Id, Part[]>;
  /** "Paused since"; `null` removes it on a resume (round 3 §2.1, D106, following D72). */
  pausedAt?: Timestamp | null;
  /** `allowedRunActions(status)`, stamped wherever the status changes (FR-CTL-006, D71). */
  allowedActions?: RunAction[];
  /** Set only alongside `haltReason: 'budget_exceeded'` (FR-GRD-008, D80). */
  budgetHalt?: BudgetHalt;
  /** Set on the run a restart created: same snapshot, same inputs (FR-CTL-004). */
  restartedFromRunId?: Id;
}

export interface RunRepository {
  create(scope: Scope, run: Run): Promise<Run>;
  get(scope: Scope, id: Id): Promise<Run | null>;
  /** Newest first (FR-EXE-012). */
  listByWorkflow(scope: Scope, workflowId: Id, page: CursorQuery): Promise<Page<Run>>;
  /** Runs that were mid-flight — what crash recovery has to finish off (FR-SYS-009). */
  listActive(scope: Scope): Promise<Run[]>;
  update(scope: Scope, id: Id, patch: RunPatch): Promise<Run | null>;
}

export interface NodeRunPatch {
  status?: NodeState;
  failureReason?: NodeRun['failureReason'];
  error?: NodeError;
  modelUsed?: NodeRun['modelUsed'];
  output?: Part[];
  prompt?: NodeRun['prompt'];
  usage?: Usage;
  /** The policy and version this node run was checked against (round 3 §2.1, FR-GRD-002). */
  guardrailPolicy?: NodeRun['guardrailPolicy'];
  /** On a loop's last iteration: why the loop stopped (round 3 §2.4). */
  loopStop?: NodeRun['loopStop'];
  /** Start from node reused an earlier node run instead of executing (FR-EXE-013, D83). */
  reusedFromNodeRunId?: Id;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  durationMs?: number;
  /** Round 5: the chunks the node's context used, best first (§2.4, FR-RAG-007). */
  sources?: NodeRun['sources'];
  /** Round 5: chunks the search found that did not fit the context budget (§4 item 7, D233). */
  droppedSources?: NodeRun['droppedSources'];
  /** Round 5: the `__memory` ops the node run applied, in order (§2.2, FR-MEM-002). */
  memoryOps?: NodeRun['memoryOps'];
  /**
   * Round 5: the envelopes the node actually read, once its context step placed retrieved chunks or
   * memory on them (FR-RAG-007, FR-MEM-003). The row is created with the envelopes as delivered;
   * this replaces them, so `GET /node-runs/:id` shows what the prompt was built from.
   */
  inputEnvelopes?: NodeRun['inputEnvelopes'];
}
/**
 * `verdicts` and `approvals` are deliberately absent: they are written through
 * `GuardrailVerdictRepository.append` and `ApprovalRepository.decide`, which keep the node run's
 * copy and the table of record in step. One write path means they cannot drift.
 */

export interface NodeRunRepository {
  create(scope: Scope, nodeRun: NodeRun): Promise<NodeRun>;
  get(scope: Scope, id: Id): Promise<NodeRun | null>;
  /** In the order they were created, which is the order they were dispatched. */
  listByRun(scope: Scope, runId: Id): Promise<NodeRun[]>;
  update(scope: Scope, id: Id, patch: NodeRunPatch): Promise<NodeRun | null>;
  /**
   * What every node run that started on one UTC day cost, summed (round 3 §2.3, FR-GRD-008).
   *
   * `day` is a calendar date, `YYYY-MM-DD`. This is the number the `daily_budget` check compares
   * with `Settings.dailyBudgetUsd`, and it is aggregated in SQL rather than by reading a day's node
   * runs into memory. A day with no node runs is 0, never null.
   */
  dailyCostUsd(scope: Scope, day: string): Promise<number>;
}

/** The data types a model must cover — used by `ModelQuery` filtering in the store. */
export type ModelTypeFilter = DataType;
