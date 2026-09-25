import {
  API_BASE_PATH,
  CreateGuardrailPolicyRequestSchema,
  DEFAULT_GUARDRAIL_POLICY_NAME,
  GuardrailPolicySchema,
  PolicyTestRequestSchema,
  UpdateGuardrailPolicyRequestSchema,
  aceError,
  defaultGuardrailChecks,
  type GuardrailPolicy,
  type PolicyTestRequest,
  type PolicyTestVerdict,
  type UpdateGuardrailPolicyRequest,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler } from 'msw';

import { newId } from '../lib/ulid';

/**
 * A stand-in engine for the round 3 §2.5 `/guardrail-policies` endpoints, used by this folder's
 * tests through `server.use(...)`.
 *
 * `src/mocks` is not this screen's to edit and its round 3 handlers are being written separately, so
 * these live here instead: they speak the same contract (every body parsed with the contract's own
 * schema, every answer built from it), which is what the tests need to be about the screen rather
 * than about a mock. When `src/mocks/handlers-round3` lands, this file goes and the tests point at
 * it — the endpoints, not the fake, are what they assert against.
 */

const API = `*${API_BASE_PATH}`;

function now(): string {
  return new Date().toISOString();
}

function notFound(): Response {
  return HttpResponse.json(aceError('workflow', 'not_found', 'Policy not found.'), { status: 404 });
}

function validationFailed(details: unknown): Response {
  return HttpResponse.json(
    aceError('invalid_config', 'validation_failed', 'Request body is invalid.', { details }),
    { status: 400 },
  );
}

export interface PolicyMockEngine {
  handlers: HttpHandler[];
  /** The default policy a project is created with (FR-GRD-018, D10). */
  seedDefault(projectId: string, name?: string): GuardrailPolicy;
  seed(policy: GuardrailPolicy): GuardrailPolicy;
  list(projectId: string): GuardrailPolicy[];
  get(id: string): GuardrailPolicy | undefined;
  /** Every `PATCH` body the screen sent, in order — what a test asserts a saved action against. */
  patches: Array<{ id: string; body: UpdateGuardrailPolicyRequest }>;
  tests: Array<{ id: string; body: PolicyTestRequest }>;
  /** Node ids the next unconfirmed `DELETE` answers 409 `policy_in_use` with. */
  inUseNodeIds: string[];
  /** What the next `POST /:id/test` answers with. */
  testVerdicts: PolicyTestVerdict[];
}

export function createPolicyMockEngine(): PolicyMockEngine {
  const policies = new Map<string, GuardrailPolicy>();

  const engine: PolicyMockEngine = {
    handlers: [],
    patches: [],
    tests: [],
    inUseNodeIds: [],
    testVerdicts: [],

    seed(policy) {
      policies.set(policy.id, GuardrailPolicySchema.parse(policy));
      return policy;
    },

    seedDefault(projectId, name = DEFAULT_GUARDRAIL_POLICY_NAME) {
      return engine.seed({
        id: newId(),
        projectId,
        name,
        version: 1,
        isProjectDefault: true,
        checks: defaultGuardrailChecks(newId),
        createdAt: now(),
        updatedAt: now(),
      });
    },

    list(projectId) {
      return [...policies.values()].filter((policy) => policy.projectId === projectId);
    },

    get(id) {
      return policies.get(id);
    },
  };

  engine.handlers = [
    http.get(`${API}/guardrail-policies`, ({ request }) => {
      const projectId = new URL(request.url).searchParams.get('projectId') ?? '';
      return HttpResponse.json({ items: engine.list(projectId) });
    }),

    http.post(`${API}/guardrail-policies`, async ({ request }) => {
      const parsed = CreateGuardrailPolicyRequestSchema.safeParse(await request.json());
      if (!parsed.success) return validationFailed(parsed.error.issues);
      const policy: GuardrailPolicy = {
        id: newId(),
        projectId: parsed.data.projectId,
        name: parsed.data.name,
        version: 1,
        isProjectDefault: false,
        checks: parsed.data.checks,
        createdAt: now(),
        updatedAt: now(),
      };
      engine.seed(policy);
      return HttpResponse.json(policy, { status: 201 });
    }),

    http.get(`${API}/guardrail-policies/:id`, ({ params }) => {
      const policy = policies.get(String(params['id']));
      return policy ? HttpResponse.json(policy) : notFound();
    }),

    /** A PATCH never edits in place: it writes version + 1 (FR-GRD-001). */
    http.patch(`${API}/guardrail-policies/:id`, async ({ params, request }) => {
      const id = String(params['id']);
      const policy = policies.get(id);
      if (!policy) return notFound();
      const parsed = UpdateGuardrailPolicyRequestSchema.safeParse(await request.json());
      if (!parsed.success) return validationFailed(parsed.error.issues);
      engine.patches.push({ id, body: parsed.data });
      const next: GuardrailPolicy = {
        ...policy,
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.checks === undefined ? {} : { checks: parsed.data.checks }),
        version: policy.version + 1,
        updatedAt: now(),
      };
      policies.set(id, next);
      return HttpResponse.json(next);
    }),

    http.delete(`${API}/guardrail-policies/:id`, ({ params, request }) => {
      const id = String(params['id']);
      if (!policies.has(id)) return notFound();
      const confirm = new URL(request.url).searchParams.get('confirm') === 'true';
      if (!confirm && engine.inUseNodeIds.length > 0) {
        return HttpResponse.json(
          aceError('workflow', 'policy_in_use', 'Agents still use this policy.', {
            details: { nodeIds: engine.inUseNodeIds },
            retryable: false,
          }),
          { status: 409 },
        );
      }
      policies.delete(id);
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/guardrail-policies/:id/set-default`, ({ params }) => {
      const id = String(params['id']);
      const policy = policies.get(id);
      if (!policy) return notFound();
      for (const other of policies.values()) {
        if (other.projectId === policy.projectId && other.id !== id) {
          policies.set(other.id, { ...other, isProjectDefault: false });
        }
      }
      const next: GuardrailPolicy = { ...policy, isProjectDefault: true, updatedAt: now() };
      policies.set(id, next);
      return HttpResponse.json(next);
    }),

    http.post(`${API}/guardrail-policies/:id/test`, async ({ params, request }) => {
      const id = String(params['id']);
      if (!policies.has(id)) return notFound();
      const parsed = PolicyTestRequestSchema.safeParse(await request.json());
      if (!parsed.success) return validationFailed(parsed.error.issues);
      engine.tests.push({ id, body: parsed.data });
      return HttpResponse.json({ verdicts: engine.testVerdicts });
    }),
  ];

  return engine;
}

/** A verdict the way a tested policy answers one: no `id`, no `nodeRunId` (§2.2). */
export function testVerdict(verdict: Partial<PolicyTestVerdict>): PolicyTestVerdict {
  return {
    point: 'input',
    checkType: 'pii',
    action: 'warn',
    passed: true,
    reason: 'Nothing found.',
    at: now(),
    ...verdict,
  };
}
