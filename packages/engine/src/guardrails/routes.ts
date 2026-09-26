import {
  CreateGuardrailPolicyRequestSchema,
  GuardrailPolicyQuerySchema,
  PolicyTestRequestSchema,
  UpdateGuardrailPolicyRequestSchema,
  type Id,
} from '@ace/contracts';
import { Hono, type Context } from 'hono';

import { HttpError, notImplemented } from '../gateway/errors.js';
import { PolicyNotFoundError, ProjectNotFoundError, type PolicyService } from './policy-service.js';

/**
 * `/guardrail-policies` (§2.5, FR-GRD-001, FR-GRD-010).
 *
 * A sub-router rather than lines in `gateway/index.ts`, so three people can add routes in one round
 * without touching one file. It is mounted with a single line, which the report gives verbatim.
 *
 * The refusals it owns:
 * - 404 `not_found` for a policy or a project that does not exist.
 * - 400 `validation_failed` for a check the contract refuses (raised by the schema parse and turned
 *   into the envelope by `toApiError`) — which is how "you cannot switch off a data guardrail" is
 *   enforced at the API surface, because `PolicyGuardrailPointSchema` has no `data` member at all
 *   (FR-GRD-010, BR-15, TC-GRD-015).
 * - 409 `policy_in_use` for a delete that agents still depend on, carrying `{ nodeIds }` so the UI
 *   can say which agents it would change (D78), and for the project default, which nothing may
 *   remove because a project with no policy runs unguarded (D10).
 */

/** Structurally the gateway's own `EngineVariables`; declared here so this file imports no routes. */
export type GuardrailRouter = Hono<{ Variables: { requestId: string } }>;

export const policyNotFound = (id: Id): HttpError =>
  new HttpError('workflow', 'not_found', `Guardrail policy ${id} was not found.`);

export const projectNotFound = (id: Id): HttpError =>
  new HttpError('workflow', 'not_found', `Project ${id} was not found.`);

export const policyInUse = (nodeIds: readonly Id[], projectDefault: boolean): HttpError =>
  new HttpError(
    'invalid_config',
    'policy_in_use',
    projectDefault
      ? 'This is the project default policy. Make another policy the default before deleting it.'
      : `${nodeIds.length} agent${nodeIds.length === 1 ? '' : 's'} still use this policy. Delete it with ?confirm=true to remove it anyway.`,
    { nodeIds: [...nodeIds], projectDefault },
  );

/** A malformed body is a validation failure, not a crash — the gateway's own convention. */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** Turn the service's errors into the §2.3 envelope, once, for every route below. */
async function answering<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PolicyNotFoundError) throw policyNotFound(error.id);
    if (error instanceof ProjectNotFoundError) throw projectNotFound(error.id);
    // A `ZodError` from a contract parse falls through: `toApiError` already answers it 400
    // `validation_failed` with the issues, which is how the data-point refusal reaches a client.
    throw error;
  }
}

/**
 * `service` may be `undefined`: an app built without a policy service answers every route below
 * 501 `not_implemented`, which is what the gateway already does for a round-2 service it was built
 * without. Every handler goes through `policies()` for exactly that reason.
 */
export function createGuardrailRoutes(service: PolicyService | undefined): GuardrailRouter {
  const router: GuardrailRouter = new Hono<{ Variables: { requestId: string } }>();

  const policies = (): PolicyService => {
    if (service === undefined) throw notImplemented('guardrail policies');
    return service;
  };

  // Wrapped like every other collection, `{ items }` (D64).
  router.get('/guardrail-policies', async (c) => {
    const { projectId } = GuardrailPolicyQuerySchema.parse(c.req.query());
    return c.json({ items: await policies().list(projectId) });
  });

  router.post('/guardrail-policies', async (c) => {
    const input = CreateGuardrailPolicyRequestSchema.parse(await readJson(c));
    return c.json(await answering(() => policies().create(input)), 201);
  });

  router.get('/guardrail-policies/:id', async (c) =>
    c.json(await answering(() => policies().get(c.req.param('id')))),
  );

  // FR-GRD-001: never in place. The answer is version + 1, and the version the run history points
  // at is still readable.
  router.patch('/guardrail-policies/:id', async (c) => {
    const patch = UpdateGuardrailPolicyRequestSchema.parse(await readJson(c));
    return c.json(await answering(() => policies().update(c.req.param('id'), patch)));
  });

  router.delete('/guardrail-policies/:id', async (c) => {
    const confirm = c.req.query('confirm') === 'true';
    const result = await answering(() => policies().remove(c.req.param('id'), { confirm }));

    if (!result.ok) throw policyInUse(result.nodeIds, result.projectDefault);
    return c.body(null, 204);
  });

  router.post('/guardrail-policies/:id/test', async (c) => {
    const request = PolicyTestRequestSchema.parse(await readJson(c));
    return c.json(await answering(() => policies().test(c.req.param('id'), request)));
  });

  router.post('/guardrail-policies/:id/set-default', async (c) =>
    c.json(await answering(() => policies().setDefault(c.req.param('id')))),
  );

  return router;
}
