import type {
  ApprovalDecision,
  GuardrailPolicy,
  Id,
  Node,
  NodeRun,
  Project,
  Settings,
  Verdict,
} from '@ace/contracts';

import type { RunApprovalRequest, Scope } from '../ports/index.js';

/**
 * The storage this round's guardrail engine needs (Arch §7, §15.3).
 *
 * These interfaces are declared here rather than in `src/ports/` because `packages/storage-local`
 * and `src/ports/**` are being written in parallel; they are shaped exactly like the round-2 ports
 * — every method takes a `Scope` (BR-18), nothing returns a key, nothing updates an immutable row —
 * so folding them into `Repository` is a rename, not a redesign. The report lists them verbatim.
 *
 * One rule shapes all of them: **a policy version is never updated**. A PATCH inserts version + 1
 * (FR-GRD-001, Arch §13.4), so a node run's `guardrailPolicy: { id, version }` can still be read
 * back years later and answer what the run was actually checked against (FR-GRD-002, BR-04).
 */

export interface GuardrailPolicyRepository {
  /**
   * Insert one version row. Versions of a policy share an `id` and differ by `version`; inserting a
   * version that already exists is a programming error and the store may reject it.
   */
  insert(scope: Scope, policy: GuardrailPolicy): Promise<GuardrailPolicy>;
  /** The highest version of that policy — what every read of `/guardrail-policies/:id` answers. */
  getLatest(scope: Scope, id: Id): Promise<GuardrailPolicy | null>;
  /** One exact version: what a node run's `guardrailPolicy` ref resolves to. */
  getVersion(scope: Scope, id: Id, version: number): Promise<GuardrailPolicy | null>;
  /** The latest version of every policy, oldest policy first, filtered by project when given. */
  listLatest(scope: Scope, projectId?: Id): Promise<GuardrailPolicy[]>;
  /** The project's default, at its latest version (FR-GRD-002). */
  getProjectDefault(scope: Scope, projectId: Id): Promise<GuardrailPolicy | null>;
  /**
   * Move the flag: set `isProjectDefault` on every version of `id` and clear it on every version of
   * every other policy of that project, in one transaction. A project has exactly one default.
   */
  setProjectDefault(scope: Scope, projectId: Id, id: Id): Promise<void>;
  /** Remove every version. `false` when there was nothing to remove. */
  deleteAllVersions(scope: Scope, id: Id): Promise<boolean>;
}

/** A pending request, or one already decided. The decision is written once (FR-GRD-013). */
export interface StoredApproval {
  request: RunApprovalRequest;
  decision?: ApprovalDecision;
}

export interface ApprovalRepository {
  create(scope: Scope, request: RunApprovalRequest): Promise<RunApprovalRequest>;
  get(scope: Scope, id: Id): Promise<StoredApproval | null>;
  /** `GET /runs/:id/approvals` — the undecided ones, oldest first (§2.5, D78). */
  listPendingByRun(scope: Scope, runId: Id): Promise<RunApprovalRequest[]>;
  /** The routes are addressed by node run, not by request id (§2.5). */
  findPendingByNodeRun(scope: Scope, nodeRunId: Id): Promise<RunApprovalRequest | null>;
  /** Refused when the request already carries a decision — a decision is final. */
  recordDecision(scope: Scope, requestId: Id, decision: ApprovalDecision): Promise<boolean>;
}

export interface GuardrailVerdictRepository {
  /** Append-only, like the event log: a verdict is a record of what happened (FR-GRD-015). */
  append(scope: Scope, verdict: Verdict): Promise<Verdict>;
  listByNodeRun(scope: Scope, nodeRunId: Id): Promise<Verdict[]>;
}

/**
 * Today's spend (FR-GRD-008, §2.3): the sum of `node_runs.usage.costUsd` for the node runs that
 * ended on one UTC day. Aggregated in the store, never by reading every node run into memory —
 * a daily budget is checked before every dispatch.
 */
export interface UsageAggregateRepository {
  /** `day` is an ISO calendar date, `YYYY-MM-DD`, in UTC. */
  costUsdForDay(scope: Scope, day: string): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* The narrow reads the services need from rows someone else owns              */
/* -------------------------------------------------------------------------- */

/** What the policy service needs of the project store: the cap, and that the project exists. */
export interface ProjectLookup {
  get(scope: Scope, id: Id): Promise<Project | null>;
}

/** What the delete guard needs: the agents that name a policy, across every workflow (D78). */
export interface PolicyUsageLookup {
  /** Every node whose `config.guardrailPolicyId` is this policy — the 409's `{ nodeIds }`. */
  listByGuardrailPolicy(scope: Scope, policyId: Id): Promise<Node[]>;
}

/** What the approval routes need to answer with a `NodeRun` (§2.5). */
export interface NodeRunLookup {
  get(scope: Scope, id: Id): Promise<NodeRun | null>;
}

/** Read-only settings, for `dailyBudgetUsd` (§2.3). */
export interface SettingsLookup {
  get(scope: Scope): Promise<Settings>;
}

/** Everything this round's guardrail services read and write, in one bag. */
export interface GuardrailStore {
  policies: GuardrailPolicyRepository;
  approvals: ApprovalRepository;
  verdicts: GuardrailVerdictRepository;
  usage: UsageAggregateRepository;
  projects: ProjectLookup;
  policyUsage: PolicyUsageLookup;
  nodeRuns: NodeRunLookup;
  settings: SettingsLookup;
}
