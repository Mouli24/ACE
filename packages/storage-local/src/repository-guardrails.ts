import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  GuardrailPolicySchema,
  NodeSchema,
  VerdictSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type GuardrailPolicy,
  type Id,
  type Node,
  type Verdict,
} from '@ace/contracts';
import type {
  ApprovalRepository,
  GuardrailPolicyPatch,
  GuardrailPolicyRepository,
  GuardrailVerdictRepository,
  Scope,
  StoredApproval,
} from '@ace/engine';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type * as schema from './schema.js';
import { approvals, guardrailPolicies, guardrailVerdicts, nodeRuns, nodes } from './schema.js';
import { assertNoSecrets, toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * The round 3 repositories (Arch §15.3): guardrail policies, verdicts and approvals.
 *
 * Two of these write two rows at once — a verdict and its node run's copy, a decision and its node
 * run's copy — so they take the repository's transaction runner rather than opening their own. That
 * is what makes the denormalised copy on `node_runs` safe: there is one write path, and it commits
 * both halves or neither.
 */

/** Runs a body inside the repository's transaction, joining one that is already open. */
export type InTransaction = <T>(fn: () => Promise<T>) => Promise<T>;

/* -------------------------------------------------------------------------- */
/* Row <-> domain                                                              */
/* -------------------------------------------------------------------------- */

type PolicyRow = typeof guardrailPolicies.$inferSelect;
type VerdictRow = typeof guardrailVerdicts.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

function toPolicy(row: PolicyRow): GuardrailPolicy {
  return GuardrailPolicySchema.parse({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    version: row.version,
    isProjectDefault: row.isProjectDefault,
    checks: JSON.parse(row.checks),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toVerdict(row: VerdictRow): Verdict {
  return VerdictSchema.parse({
    id: row.id,
    nodeRunId: row.nodeRunId,
    point: row.point,
    checkType: row.checkType,
    action: row.action,
    passed: row.passed,
    reason: row.reason,
    ...(row.redactedTypes === null ? {} : { redactedTypes: JSON.parse(row.redactedTypes) }),
    at: row.at,
  });
}

function toApprovalRequest(row: ApprovalRow): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    id: row.id,
    runId: row.runId,
    nodeRunId: row.nodeRunId,
    nodeId: row.nodeId,
    nodeName: row.nodeName,
    point: row.point,
    checkType: row.checkType,
    reason: row.reason,
    preview: row.preview,
    requestedAt: row.requestedAt,
  });
}

function toStoredApproval(row: ApprovalRow): StoredApproval {
  const request = toApprovalRequest(row);
  if (row.decision === null || row.decidedAt === null) return { request };

  return {
    request,
    decision: ApprovalDecisionSchema.parse({
      requestId: row.id,
      decision: row.decision,
      ...(row.note === null ? {} : { note: row.note }),
      decidedAt: row.decidedAt,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Policies (FR-GRD-001, 002, 018)                                             */
/* -------------------------------------------------------------------------- */

export function createGuardrailPolicyRepository(
  db: Db,
  inTransaction: InTransaction,
): GuardrailPolicyRepository {
  const rowFor = (scope: Scope, policy: GuardrailPolicy): typeof guardrailPolicies.$inferInsert => ({
    id: policy.id,
    workspaceId: scope.workspaceId,
    projectId: policy.projectId,
    name: policy.name,
    version: policy.version,
    isProjectDefault: policy.isProjectDefault,
    checks: toJsonColumn(policy.checks, `guardrailPolicy(${policy.id}).checks`),
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  });

  const read = (scope: Scope, id: Id): GuardrailPolicy | null => {
    const row = db
      .select()
      .from(guardrailPolicies)
      .where(and(eq(guardrailPolicies.workspaceId, scope.workspaceId), eq(guardrailPolicies.id, id)))
      .get();
    return row === undefined ? null : toPolicy(row);
  };

  return {
    create: async (scope: Scope, policy: GuardrailPolicy) => {
      db.insert(guardrailPolicies).values(rowFor(scope, policy)).run();
      return policy;
    },

    get: async (scope: Scope, id: Id) => read(scope, id),

    listByProject: async (scope: Scope, projectId: Id) =>
      db
        .select()
        .from(guardrailPolicies)
        .where(
          and(
            eq(guardrailPolicies.workspaceId, scope.workspaceId),
            eq(guardrailPolicies.projectId, projectId),
          ),
        )
        .orderBy(asc(guardrailPolicies.id))
        .all()
        .map(toPolicy),

    getProjectDefault: async (scope: Scope, projectId: Id) => {
      const row = db
        .select()
        .from(guardrailPolicies)
        .where(
          and(
            eq(guardrailPolicies.workspaceId, scope.workspaceId),
            eq(guardrailPolicies.projectId, projectId),
            eq(guardrailPolicies.isProjectDefault, true),
          ),
        )
        .get();
      return row === undefined ? null : toPolicy(row);
    },

    update: async (scope: Scope, id: Id, patch: GuardrailPolicyPatch) => {
      const values = {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.version === undefined ? {} : { version: patch.version }),
        ...(patch.checks === undefined
          ? {}
          : { checks: toJsonColumn(patch.checks, `guardrailPolicy(${id}).checks`) }),
        ...(patch.updatedAt === undefined ? {} : { updatedAt: patch.updatedAt }),
      };

      if (Object.keys(values).length > 0) {
        db.update(guardrailPolicies)
          .set(values)
          .where(
            and(eq(guardrailPolicies.workspaceId, scope.workspaceId), eq(guardrailPolicies.id, id)),
          )
          .run();
      }

      return read(scope, id);
    },

    /**
     * Clears the project's flag before setting the new one: the partial unique index would refuse
     * the other order, and a reader between the two statements must never see two defaults.
     */
    setDefault: async (scope: Scope, id: Id) =>
      inTransaction(async () => {
        const current = read(scope, id);
        if (current === null) return null;

        db.update(guardrailPolicies)
          .set({ isProjectDefault: false })
          .where(
            and(
              eq(guardrailPolicies.workspaceId, scope.workspaceId),
              eq(guardrailPolicies.projectId, current.projectId),
              eq(guardrailPolicies.isProjectDefault, true),
            ),
          )
          .run();

        db.update(guardrailPolicies)
          .set({ isProjectDefault: true })
          .where(
            and(eq(guardrailPolicies.workspaceId, scope.workspaceId), eq(guardrailPolicies.id, id)),
          )
          .run();

        return read(scope, id);
      }),

    delete: async (scope: Scope, id: Id) =>
      db
        .delete(guardrailPolicies)
        .where(and(eq(guardrailPolicies.workspaceId, scope.workspaceId), eq(guardrailPolicies.id, id)))
        .run().changes > 0,

    /**
     * `config` is a JSON column, so this is a substring match on the stored policy id, re-checked in
     * TypeScript — the same shape as `nodes.listByProvider`, because a LIKE could match an id that
     * happens to appear elsewhere in the config.
     */
    nodesUsing: async (scope: Scope, id: Id): Promise<Node[]> =>
      db
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, scope.workspaceId), sql`${nodes.config} LIKE ${`%"${id}"%`}`))
        .all()
        .map(toNodeRow)
        .filter(
          (node) => 'guardrailPolicyId' in node.config && node.config.guardrailPolicyId === id,
        ),
  };
}

type NodeRow = typeof nodes.$inferSelect;

/** Parsed through the contract, as everywhere else a node is read (§2.4). */
function toNodeRow(row: NodeRow): Node {
  return NodeSchema.parse({
    id: row.id,
    workflowId: row.workflowId,
    kind: row.kind,
    name: row.name,
    position: { x: row.positionX, y: row.positionY },
    inputs: JSON.parse(row.inputs),
    outputs: JSON.parse(row.outputs),
    config: JSON.parse(row.config),
  });
}

/* -------------------------------------------------------------------------- */
/* Verdicts (FR-GRD-014, 015)                                                  */
/* -------------------------------------------------------------------------- */

export function createGuardrailVerdictRepository(
  db: Db,
  inTransaction: InTransaction,
): GuardrailVerdictRepository {
  const mirrorOntoNodeRun = (scope: Scope, verdict: Verdict): void => {
    const row = db
      .select({ verdicts: nodeRuns.verdicts })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.workspaceId, scope.workspaceId), eq(nodeRuns.id, verdict.nodeRunId)))
      .get();
    if (row === undefined) return;

    const list = [...(JSON.parse(row.verdicts) as unknown[]), verdict];
    db.update(nodeRuns)
      .set({ verdicts: toJsonColumn(list, `nodeRun(${verdict.nodeRunId}).verdicts`) })
      .where(and(eq(nodeRuns.workspaceId, scope.workspaceId), eq(nodeRuns.id, verdict.nodeRunId)))
      .run();
  };

  return {
    append: async (scope: Scope, verdict: Verdict) =>
      inTransaction(async () => {
        // `reason` is prose a check wrote about what it found, so it goes through the guard: a
        // reason quoting a live credential is refused (BR-07), a redacted one passes.
        assertNoSecrets(verdict.reason, `verdict(${verdict.id}).reason`);

        db.insert(guardrailVerdicts)
          .values({
            id: verdict.id,
            workspaceId: scope.workspaceId,
            nodeRunId: verdict.nodeRunId,
            point: verdict.point,
            checkType: verdict.checkType,
            action: verdict.action,
            passed: verdict.passed,
            reason: verdict.reason,
            redactedTypes:
              verdict.redactedTypes === undefined
                ? null
                : toJsonColumn(verdict.redactedTypes, `verdict(${verdict.id}).redactedTypes`),
            at: verdict.at,
          })
          .run();

        mirrorOntoNodeRun(scope, verdict);
        return verdict;
      }),

    listByNodeRun: async (scope: Scope, nodeRunId: Id) =>
      db
        .select()
        .from(guardrailVerdicts)
        .where(
          and(
            eq(guardrailVerdicts.workspaceId, scope.workspaceId),
            eq(guardrailVerdicts.nodeRunId, nodeRunId),
          ),
        )
        .orderBy(asc(guardrailVerdicts.id))
        .all()
        .map(toVerdict),
  };
}

/* -------------------------------------------------------------------------- */
/* Approvals (FR-GRD-013)                                                      */
/* -------------------------------------------------------------------------- */

export function createApprovalRepository(
  db: Db,
  inTransaction: InTransaction,
): ApprovalRepository {
  const read = (scope: Scope, id: Id): ApprovalRow | undefined =>
    db
      .select()
      .from(approvals)
      .where(and(eq(approvals.workspaceId, scope.workspaceId), eq(approvals.id, id)))
      .get();

  const mirrorOntoNodeRun = (scope: Scope, row: ApprovalRow, decision: ApprovalDecision): void => {
    const nodeRun = db
      .select({ approvals: nodeRuns.approvals })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.workspaceId, scope.workspaceId), eq(nodeRuns.id, row.nodeRunId)))
      .get();
    if (nodeRun === undefined) return;

    const list = [...(JSON.parse(nodeRun.approvals ?? '[]') as unknown[]), decision];
    db.update(nodeRuns)
      .set({ approvals: toJsonColumn(list, `nodeRun(${row.nodeRunId}).approvals`) })
      .where(and(eq(nodeRuns.workspaceId, scope.workspaceId), eq(nodeRuns.id, row.nodeRunId)))
      .run();
  };

  return {
    create: async (scope: Scope, request: ApprovalRequest) => {
      const at = `approval(${request.id})`;
      // The preview is text that tripped a check, so both it and the reason go through the guard.
      // FR-GRD-014 has already redacted anything sensitive by the time it gets here; a preview
      // still carrying a credential is a defect and is refused rather than stored (BR-07).
      assertNoSecrets(request.preview, `${at}.preview`);
      assertNoSecrets(request.reason, `${at}.reason`);

      db.insert(approvals)
        .values({
          id: request.id,
          workspaceId: scope.workspaceId,
          runId: request.runId,
          nodeRunId: request.nodeRunId,
          nodeId: request.nodeId,
          nodeName: request.nodeName,
          point: request.point,
          checkType: request.checkType,
          reason: request.reason,
          preview: request.preview,
          requestedAt: request.requestedAt,
          decision: null,
          note: null,
          decidedAt: null,
        })
        .run();
      return request;
    },

    get: async (scope: Scope, id: Id) => {
      const row = read(scope, id);
      return row === undefined ? null : toStoredApproval(row);
    },

    findPendingByNodeRun: async (scope: Scope, nodeRunId: Id) => {
      const row = db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.workspaceId, scope.workspaceId),
            eq(approvals.nodeRunId, nodeRunId),
            isNull(approvals.decision),
          ),
        )
        .orderBy(asc(approvals.id))
        .get();
      return row === undefined ? null : toApprovalRequest(row);
    },

    listPendingByRun: async (scope: Scope, runId: Id) =>
      db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.workspaceId, scope.workspaceId),
            eq(approvals.runId, runId),
            isNull(approvals.decision),
          ),
        )
        .orderBy(asc(approvals.id))
        .all()
        .map(toApprovalRequest),

    /** First decision wins: an answered request is never re-answered (FR-GRD-013). */
    decide: async (scope: Scope, decision: ApprovalDecision) =>
      inTransaction(async () => {
        const row = read(scope, decision.requestId);
        if (row === undefined) return null;
        if (row.decision !== null) return toStoredApproval(row);

        if (decision.note !== undefined) {
          assertNoSecrets(decision.note, `approval(${decision.requestId}).note`);
        }

        db.update(approvals)
          .set({
            decision: decision.decision,
            note: decision.note ?? null,
            decidedAt: decision.decidedAt,
          })
          .where(
            and(eq(approvals.workspaceId, scope.workspaceId), eq(approvals.id, decision.requestId)),
          )
          .run();

        mirrorOntoNodeRun(scope, row, decision);

        const updated = read(scope, decision.requestId);
        return updated === undefined ? null : toStoredApproval(updated);
      }),
  };
}
