import {
  CreateGuardrailPolicyRequestSchema,
  UpdateGuardrailPolicyRequestSchema,
  type CreateGuardrailPolicyRequest,
  type GuardrailPolicy,
  type GuardrailPolicyRef,
  type Id,
  type Node,
  type PolicyTestRequest,
  type PolicyTestResponse,
  type PolicyTestVerdict,
  type UpdateGuardrailPolicyRequest,
} from '@ace/contracts';

import { newId } from '../ids.js';
import type { Scope } from '../ports/index.js';
import type { CheckRunner } from './checks.js';
import { verdictFor } from './evaluator.js';
import type { GuardrailPolicyRepository, PolicyUsageLookup, ProjectLookup } from './ports.js';

/**
 * The guardrail policy service (FR-GRD-001, FR-GRD-002, FR-GRD-010, FR-GRD-018).
 *
 * Two rules do most of the work here.
 *
 * **A version is never edited.** A PATCH reads the latest version, applies the patch and inserts
 * version + 1 (Arch §13.4). That is not bookkeeping: a node run records `{ id, version }`, and if a
 * version could be rewritten, "what was this run checked against?" would have no answer a year
 * later, which BR-04 does not allow.
 *
 * **A data guardrail has no policy representation.** `PolicyGuardrailPointSchema` refuses the `data`
 * point outright, so every path into this service — the route, the test endpoint, an internal
 * caller — turns an attempt to configure secret redaction into a validation failure (FR-GRD-010,
 * BR-15, TC-GRD-015). Switching the *output* `secret_leak` check off is a different thing and is
 * allowed: it stops the node failing, and the data guardrail still masks the key (D86).
 */

export class PolicyNotFoundError extends Error {
  override readonly name = 'PolicyNotFoundError';

  constructor(readonly id: Id) {
    super(`Guardrail policy ${id} was not found.`);
  }
}

export class ProjectNotFoundError extends Error {
  override readonly name = 'ProjectNotFoundError';

  constructor(readonly id: Id) {
    super(`Project ${id} was not found.`);
  }
}

export type RemovePolicyResult =
  | { ok: true }
  | { ok: false; reason: 'in_use'; nodeIds: Id[]; projectDefault: boolean };

export interface PolicyService {
  list(projectId?: Id): Promise<GuardrailPolicy[]>;
  /** The latest version. Throws `PolicyNotFoundError` rather than answering null (D78's 404). */
  get(id: Id): Promise<GuardrailPolicy>;
  /** One exact version — what a recorded `NodeRun.guardrailPolicy` points at (FR-GRD-002). */
  getVersion(id: Id, version: number): Promise<GuardrailPolicy>;
  create(input: CreateGuardrailPolicyRequest): Promise<GuardrailPolicy>;
  /** Never in place: inserts version + 1 and answers it (FR-GRD-001). */
  update(id: Id, patch: UpdateGuardrailPolicyRequest): Promise<GuardrailPolicy>;
  setDefault(id: Id): Promise<GuardrailPolicy>;
  remove(id: Id, options: { confirm: boolean }): Promise<RemovePolicyResult>;
  /** Evaluate pasted text against this policy at `input` or `output` (FR-GRD-001). */
  test(id: Id, request: PolicyTestRequest): Promise<PolicyTestResponse>;

  /**
   * FR-GRD-002: the project default, unless the node overrides it. `null` only when the project has
   * no default at all, which the FR-GRD-018 migration is there to prevent.
   */
  resolve(projectId: Id, node?: Node): Promise<GuardrailPolicy | null>;
}

export interface PolicyServiceDeps {
  scope: Scope;
  policies: GuardrailPolicyRepository;
  projects: ProjectLookup;
  policyUsage: PolicyUsageLookup;
  /** Only the test endpoint needs it; evaluation during a run goes through the evaluator. */
  checks: CheckRunner;
  now?: () => string;
  nextId?: () => string;
}

/** The `{ id, version }` a node run records (FR-GRD-002, Arch §13.4). */
export function policyRef(policy: GuardrailPolicy): GuardrailPolicyRef {
  return { id: policy.id, version: policy.version };
}

export function createPolicyService(deps: PolicyServiceDeps): PolicyService {
  const { scope, policies, projects, policyUsage, checks: runner } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  async function latest(id: Id): Promise<GuardrailPolicy> {
    const policy = await policies.getLatest(scope, id);
    if (policy === null) throw new PolicyNotFoundError(id);
    return policy;
  }

  return {
    list: (projectId) => policies.listLatest(scope, projectId),

    get: latest,

    async getVersion(id, version) {
      const policy = await policies.getVersion(scope, id, version);
      if (policy === null) throw new PolicyNotFoundError(id);
      return policy;
    },

    async create(input) {
      // Parsed here, not only at the route: `PolicyGuardrailPointSchema` has no `data` member, so a
      // caller that never came through HTTP still cannot configure a data guardrail (FR-GRD-010,
      // BR-15). The ZodError it throws is what the gateway turns into 400 `validation_failed`.
      const request = CreateGuardrailPolicyRequestSchema.parse(input);

      if ((await projects.get(scope, request.projectId)) === null) {
        throw new ProjectNotFoundError(request.projectId);
      }

      const at = now();
      return policies.insert(scope, {
        id: nextId(),
        projectId: request.projectId,
        name: request.name,
        version: 1,
        // A new policy never steals the flag; `POST /:id/set-default` moves it, and only that.
        isProjectDefault: false,
        checks: request.checks,
        createdAt: at,
        updatedAt: at,
      });
    },

    async update(id, patch) {
      const request = UpdateGuardrailPolicyRequestSchema.parse(patch);

      const current = await latest(id);

      return policies.insert(scope, {
        ...current,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.checks === undefined ? {} : { checks: request.checks }),
        version: current.version + 1,
        // `createdAt` is the policy's, not the version's: version 7 of a policy created in January
        // was still created in January, and the run history is read that way.
        updatedAt: now(),
      });
    },

    async setDefault(id) {
      const policy = await latest(id);
      await policies.setProjectDefault(scope, policy.projectId, id);
      return latest(id);
    },

    async remove(id, options) {
      const policy = await latest(id);
      const nodeIds = (await policyUsage.listByGuardrailPolicy(scope, id)).map((node) => node.id);

      // A project with no default policy would run with no guardrails at all, which D10 and
      // FR-GRD-018 rule out — so this refusal is not something `confirm=true` can wave through.
      if (policy.isProjectDefault) {
        return { ok: false, reason: 'in_use', nodeIds, projectDefault: true };
      }

      // FR-PRV-005's shape, applied to policies (D78): the refusal names the nodes it would change.
      if (nodeIds.length > 0 && !options.confirm) {
        return { ok: false, reason: 'in_use', nodeIds, projectDefault: false };
      }

      await policies.deleteAllVersions(scope, id);
      return { ok: true };
    },

    async test(id, request) {
      const policy = await latest(id);
      const at = now();
      const verdicts: PolicyTestVerdict[] = [];

      for (const check of policy.checks) {
        if (!check.enabled || check.point !== request.point) continue;

        // Unlike a run, the test endpoint reports the checks that *passed* too: the question it
        // answers is "is my policy configured the way I think?", and a silent pass is no answer.
        const outcome = runner.evaluate(check, {
          point: request.point,
          text: request.text,
          parts: [{ type: 'text', text: request.text }],
        });
        if (outcome === undefined) continue;

        const { id: _id, nodeRunId: _nodeRunId, ...verdict } = verdictFor(check, outcome, {
          id: 'test',
          nodeRunId: 'test',
          at,
        });
        verdicts.push(verdict);
      }

      return { verdicts };
    },

    async resolve(projectId, node) {
      const override =
        node !== undefined && node.kind === 'agent' ? node.config.guardrailPolicyId : undefined;

      if (override !== undefined) {
        const policy = await policies.getLatest(scope, override);
        // An agent naming a policy that has since been deleted falls back to the project default
        // rather than running unguarded (D10).
        if (policy !== null) return policy;
      }

      return policies.getProjectDefault(scope, projectId);
    },
  };
}
