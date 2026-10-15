import type { ApprovalDecision, GuardrailPolicy, Id } from '@ace/contracts';

import type { Repository, Scope } from '../ports/index.js';
import type { GuardrailStore } from './ports.js';

/**
 * `Repository` → `GuardrailStore` (Arch §7, §15.3).
 *
 * The round 3 services were written against the narrow interfaces in `ports.ts` — a policy store
 * that talks in versions, an approval store that answers "did my decision land?" with a boolean —
 * while `packages/storage-local` implements the wider `Repository` ports. The two say the same
 * things in different words, and this is the one place the translation lives, so no service and no
 * composition root has to know about both.
 *
 * Three translations are more than a rename and are worth naming:
 *
 * - `insert(policy)` is the only way a version is written. Version 1 is a `create`; anything higher
 *   is an `update` carrying that version, which the store inserts beside the versions before it
 *   rather than over them (FR-GRD-001, Arch §13.4).
 * - `setProjectDefault(projectId, id)` drops the project id: the store reads it off the policy, and
 *   moving the flag is one transaction there (FR-GRD-018).
 * - `recordDecision` asks the store to decide and then checks whether the decision that came back
 *   is *this* one. `ApprovalRepository.decide` keeps the first decision and answers with it, so a
 *   second caller sees its own timestamp missing — which is exactly the `false` the approval
 *   service turns into 409 `invalid_run_state` (D120).
 */
export function guardrailStoreFor(repository: Repository, scope: Scope): GuardrailStore {
  return {
    policies: {
      insert: async (_scope, policy: GuardrailPolicy) => {
        if (policy.version <= 1) return repository.guardrailPolicies.create(scope, policy);

        const updated = await repository.guardrailPolicies.update(scope, policy.id, {
          name: policy.name,
          version: policy.version,
          checks: policy.checks,
          updatedAt: policy.updatedAt,
        });
        // A policy that vanished between the read and the write is not something to invent a row
        // for; the version the caller built is still the truthful answer to what it asked.
        return updated ?? policy;
      },
      getLatest: (_scope, id) => repository.guardrailPolicies.get(scope, id),
      getVersion: (_scope, id, version) =>
        repository.guardrailPolicies.getVersion(scope, id, version),
      listLatest: (_scope, projectId) =>
        repository.guardrailPolicies.listByProject(scope, projectId),
      getProjectDefault: (_scope, projectId) =>
        repository.guardrailPolicies.getProjectDefault(scope, projectId),
      setProjectDefault: async (_scope, _projectId, id) => {
        await repository.guardrailPolicies.setDefault(scope, id);
      },
      deleteAllVersions: (_scope, id) => repository.guardrailPolicies.delete(scope, id),
    },

    approvals: {
      create: (_scope, request) => repository.approvals.create(scope, request),
      get: (_scope, id) => repository.approvals.get(scope, id),
      listPendingByRun: (_scope, runId) => repository.approvals.listPendingByRun(scope, runId),
      findPendingByNodeRun: (_scope, nodeRunId) =>
        repository.approvals.findPendingByNodeRun(scope, nodeRunId),
      recordDecision: async (_scope, _requestId: Id, decision: ApprovalDecision) => {
        const stored = await repository.approvals.decide(scope, decision);
        if (stored?.decision === undefined) return false;
        return (
          stored.decision.decidedAt === decision.decidedAt &&
          stored.decision.decision === decision.decision
        );
      },
    },

    verdicts: {
      append: (_scope, verdict) => repository.guardrailVerdicts.append(scope, verdict),
      listByNodeRun: (_scope, nodeRunId) =>
        repository.guardrailVerdicts.listByNodeRun(scope, nodeRunId),
    },

    usage: {
      // PG-2.2: the day is node runs and direct chat turns together.
      costUsdForDay: async (_scope, day) =>
        (await repository.nodeRuns.dailyCostUsd(scope, day)) +
        ((await repository.chatMessages.dailyCostUsd?.(scope, day)) ?? 0),
    },

    projects: { get: (_scope, id) => repository.projects.get(scope, id) },

    policyUsage: {
      listByGuardrailPolicy: (_scope, policyId) =>
        repository.guardrailPolicies.nodesUsing(scope, policyId),
    },

    nodeRuns: { get: (_scope, id) => repository.nodeRuns.get(scope, id) },

    settings: { get: (_scope) => repository.settings.get(scope) },
  };
}
