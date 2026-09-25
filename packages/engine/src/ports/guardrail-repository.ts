import type {
  ApprovalDecision,
  ApprovalRequest,
  GuardrailCheck,
  GuardrailPolicy,
  Id,
  Node,
  Timestamp,
  Verdict,
} from '@ace/contracts';

import type { Scope } from './scope.js';

/**
 * The round 3 half of the relational store (Arch §15.3): guardrail policies, verdicts and
 * approvals. `packages/storage-local` provides the SQLite adapter.
 *
 * Three rules shape these interfaces.
 *
 * A policy is **versioned, never edited in place** (FR-GRD-001): `update` writes the version it is
 * given, so the service decides that version + 1 is the next one and the store just records it.
 *
 * A verdict **cannot carry the value it redacted** (FR-GRD-014). `Verdict` has no value field, the
 * table has no value column, and `append` is the only way a verdict is written — it also keeps the
 * node run's `verdicts` list in step inside the same transaction, so the two copies the `NodeRun`
 * contract and Arch §15.2 both ask for can never drift.
 *
 * An approval is **one row with a nullable decision** (FR-GRD-013): pending is
 * `decision IS NULL`, which is what `GET /runs/:id/approvals` filters on.
 */

/** What a PATCH may change. The caller supplies the new version number (FR-GRD-001). */
export interface GuardrailPolicyPatch {
  name?: string;
  /** The next version. A patch that omits it leaves the stored version alone. */
  version?: number;
  checks?: GuardrailCheck[];
  updatedAt?: Timestamp;
}

export interface GuardrailPolicyRepository {
  create(scope: Scope, policy: GuardrailPolicy): Promise<GuardrailPolicy>;
  get(scope: Scope, id: Id): Promise<GuardrailPolicy | null>;
  /** Oldest first, the order they were created. */
  listByProject(scope: Scope, projectId: Id): Promise<GuardrailPolicy[]>;
  /** The project's default, which FR-GRD-018 guarantees exists for every project. */
  getProjectDefault(scope: Scope, projectId: Id): Promise<GuardrailPolicy | null>;
  update(scope: Scope, id: Id, patch: GuardrailPolicyPatch): Promise<GuardrailPolicy | null>;
  /**
   * Moves the default flag to this policy inside one transaction, so a project never has two
   * defaults and never briefly has none. Null when there is no such policy.
   */
  setDefault(scope: Scope, id: Id): Promise<GuardrailPolicy | null>;
  delete(scope: Scope, id: Id): Promise<boolean>;
  /**
   * Every node, in any workflow, whose config names this policy — what the 409 `policy_in_use`
   * guard on `DELETE /guardrail-policies/:id` reports before it refuses (§2.5).
   */
  nodesUsing(scope: Scope, id: Id): Promise<Node[]>;
}

export interface GuardrailVerdictRepository {
  /**
   * Appends a verdict and mirrors it onto its node run's `verdicts` list in the same transaction.
   * Never updates or deletes: a verdict is a record of what a check decided (FR-GRD-015).
   */
  append(scope: Scope, verdict: Verdict): Promise<Verdict>;
  /** In the order they were recorded, which is the order the points were evaluated. */
  listByNodeRun(scope: Scope, nodeRunId: Id): Promise<Verdict[]>;
}

/** An approval request together with the decision, once there is one (FR-GRD-013). */
export interface StoredApproval {
  request: ApprovalRequest;
  /** Absent while the node is WAITING. */
  decision?: ApprovalDecision;
}

export interface ApprovalRepository {
  /** Creates a pending request. The preview must already be redacted — BR-07 refuses otherwise. */
  create(scope: Scope, request: ApprovalRequest): Promise<ApprovalRequest>;
  get(scope: Scope, id: Id): Promise<StoredApproval | null>;
  /**
   * The undecided request of this node run, which is what `POST /node-runs/:id/approve` and
   * `/reject` have to find: the route names the node run, not the request.
   */
  findPendingByNodeRun(scope: Scope, nodeRunId: Id): Promise<ApprovalRequest | null>;
  /** `GET /runs/:id/approvals` — the pending ones, oldest first. */
  listPendingByRun(scope: Scope, runId: Id): Promise<ApprovalRequest[]>;
  /**
   * Records the decision, its note and its time, and mirrors it onto the node run's `approvals`
   * list in the same transaction. Null when there is no such request; a request that was already
   * decided keeps its first decision.
   */
  decide(scope: Scope, decision: ApprovalDecision): Promise<StoredApproval | null>;
}
