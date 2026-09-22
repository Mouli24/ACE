import type {
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
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  durationMs?: number;
}

export interface NodeRunRepository {
  create(scope: Scope, nodeRun: NodeRun): Promise<NodeRun>;
  get(scope: Scope, id: Id): Promise<NodeRun | null>;
  /** In the order they were created, which is the order they were dispatched. */
  listByRun(scope: Scope, runId: Id): Promise<NodeRun[]>;
  update(scope: Scope, id: Id, patch: NodeRunPatch): Promise<NodeRun | null>;
}

/** The data types a model must cover — used by `ModelQuery` filtering in the store. */
export type ModelTypeFilter = DataType;
