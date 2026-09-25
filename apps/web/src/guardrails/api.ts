import {
  API_BASE_PATH,
  CreateGuardrailPolicyRequestSchema,
  GuardrailPolicySchema,
  PolicyTestRequestSchema,
  PolicyTestResponseSchema,
  SESSION_TOKEN_STORAGE_KEY,
  UpdateGuardrailPolicyRequestSchema,
  pageSchema,
  type CreateGuardrailPolicyRequest,
  type GuardrailPolicy,
  type Id,
  type PolicyTestRequest,
  type PolicyTestResponse,
  type UpdateGuardrailPolicyRequest,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import type { z } from 'zod';

import { engineOrigin } from '../app/env';

/**
 * The round 3 §2.5 `/guardrail-policies` endpoints.
 *
 * `@ace/sdk` has no methods for them yet and `packages/sdk` is not this screen's to edit, so the
 * six calls live here, built the same way `createAceClient` builds its own: the body validated
 * against the contract before it leaves, the response validated as it arrives, and every failure
 * surfaced as an `AceApiError` so the screens read one error shape. When the SDK gains
 * `listGuardrailPolicies` and friends, this file goes and `hooks.ts` calls `api()` instead —
 * nothing else in the folder touches fetch.
 *
 * The session token comes from where round 1 §2.10 puts it (`sessionStorage['ace.token']`) and the
 * origin from the same `engineOrigin()` the one REST client is configured with.
 */

const PolicyListSchema = pageSchema(GuardrailPolicySchema);

type Query = Record<string, string | boolean | undefined>;

function url(path: string, query?: Query): string {
  const target = new URL(`${engineOrigin()}${API_BASE_PATH}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) target.searchParams.set(key, String(value));
  }
  return target.toString();
}

function token(): string {
  return sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ?? '';
}

interface RequestOptions<T> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  parse: (value: unknown) => T;
  body?: { schema: z.ZodType; value: unknown };
  query?: Query;
}

async function request<T>({ method, path, parse, body, query }: RequestOptions<T>): Promise<T> {
  let payload: string | undefined;
  if (body) {
    const checked = body.schema.safeParse(body.value);
    if (!checked.success) throw AceApiError.invalidRequest(path, checked.error.issues);
    payload = JSON.stringify(checked.data);
  }

  let response: Response;
  try {
    response = await fetch(url(path, query), {
      method,
      headers: {
        authorization: `Bearer ${token()}`,
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: payload }),
    });
  } catch (cause) {
    throw AceApiError.network(cause);
  }

  if (response.status === 204) return parse(undefined);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }

  if (!response.ok) throw AceApiError.fromResponse(response.status, json);

  try {
    return parse(json);
  } catch (error) {
    throw AceApiError.invalidResponse(path, error instanceof Error ? error.message : error);
  }
}

const noContent = (): undefined => undefined;

/** `GET /guardrail-policies?projectId` → `{ items }` (D64, D78). */
export function listGuardrailPolicies(projectId: Id): Promise<GuardrailPolicy[]> {
  return request({
    method: 'GET',
    path: '/guardrail-policies',
    parse: (value) => PolicyListSchema.parse(value).items,
    query: { projectId },
  });
}

/** `POST /guardrail-policies` → the policy at version 1. */
export function createGuardrailPolicy(
  body: CreateGuardrailPolicyRequest,
): Promise<GuardrailPolicy> {
  return request({
    method: 'POST',
    path: '/guardrail-policies',
    parse: (value) => GuardrailPolicySchema.parse(value),
    body: { schema: CreateGuardrailPolicyRequestSchema, value: body },
  });
}

/**
 * `PATCH /guardrail-policies/:id` → the policy at version + 1. A policy is never edited in place
 * (FR-GRD-001, Arch §13.4), so the response is the new version and the screen shows its number.
 */
export function updateGuardrailPolicy(
  id: Id,
  body: UpdateGuardrailPolicyRequest,
): Promise<GuardrailPolicy> {
  return request({
    method: 'PATCH',
    path: `/guardrail-policies/${id}`,
    parse: (value) => GuardrailPolicySchema.parse(value),
    body: { schema: UpdateGuardrailPolicyRequestSchema, value: body },
  });
}

/**
 * `DELETE /guardrail-policies/:id`. Without `confirm` the engine answers 409 `policy_in_use`; the
 * dialog shows that and only then repeats the call with `confirm=true` (§2.5).
 */
export function deleteGuardrailPolicy(id: Id, confirm?: boolean): Promise<undefined> {
  return request({
    method: 'DELETE',
    path: `/guardrail-policies/${id}`,
    parse: noContent,
    ...(confirm === undefined ? {} : { query: { confirm } }),
  });
}

/** `POST /guardrail-policies/:id/set-default` → the policy, now the project's default. */
export function setDefaultGuardrailPolicy(id: Id): Promise<GuardrailPolicy> {
  return request({
    method: 'POST',
    path: `/guardrail-policies/${id}/set-default`,
    parse: (value) => GuardrailPolicySchema.parse(value),
  });
}

/** `POST /guardrail-policies/:id/test` → the verdicts the policy would record for that text. */
export function testGuardrailPolicy(id: Id, body: PolicyTestRequest): Promise<PolicyTestResponse> {
  return request({
    method: 'POST',
    path: `/guardrail-policies/${id}/test`,
    parse: (value) => PolicyTestResponseSchema.parse(value),
    body: { schema: PolicyTestRequestSchema, value: body },
  });
}
