import type {
  GuardrailPolicy,
  Id,
  PolicyTestRequest,
  UpdateGuardrailPolicyRequest,
} from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createGuardrailPolicy,
  deleteGuardrailPolicy,
  listGuardrailPolicies,
  setDefaultGuardrailPolicy,
  testGuardrailPolicy,
  updateGuardrailPolicy,
} from './api';
import { guardrailKeys } from './query-keys';

/**
 * The guardrail policy screen's data (round 3 §2.5, FR-GRD-001, 018). Shaped like
 * `providers/hooks.ts`: one query for the list, one mutation per write, and every write
 * invalidating the list the engine just changed — the engine owns the version numbers and the
 * default flag (BR-01, D78), so nothing here computes either.
 */
export function useGuardrailPolicies(projectId: string | undefined) {
  return useQuery({
    queryKey: guardrailKeys.policies(projectId ?? ''),
    queryFn: () => listGuardrailPolicies(projectId ?? ''),
    enabled: Boolean(projectId),
  });
}

function usePoliciesInvalidator() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: guardrailKeys.policiesRoot() });
  };
}

export interface CreatePolicyVariables {
  projectId: Id;
  name: string;
  checks: GuardrailPolicy['checks'];
}

export function useCreateGuardrailPolicy() {
  const done = usePoliciesInvalidator();
  return useMutation({
    mutationFn: (body: CreatePolicyVariables) => createGuardrailPolicy(body),
    onSuccess: () => done(),
  });
}

/** A save is a PATCH, and a PATCH is a new version (FR-GRD-001) — never an edit in place. */
export function useUpdateGuardrailPolicy() {
  const done = usePoliciesInvalidator();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateGuardrailPolicyRequest & { id: Id }) =>
      updateGuardrailPolicy(id, body),
    onSuccess: () => done(),
  });
}

/** `POST /guardrail-policies/:id/set-default` (FR-GRD-018). */
export function useSetDefaultGuardrailPolicy() {
  const done = usePoliciesInvalidator();
  return useMutation({
    mutationFn: (id: Id) => setDefaultGuardrailPolicy(id),
    onSuccess: () => done(),
  });
}

/**
 * `DELETE /guardrail-policies/:id` (§2.5). The first attempt goes without `confirm`; a 409
 * `policy_in_use` becomes the confirmation, and only then is the call repeated with it.
 */
export function useDeleteGuardrailPolicy() {
  const done = usePoliciesInvalidator();
  return useMutation({
    mutationFn: ({ id, confirm }: { id: Id; confirm?: boolean }) =>
      deleteGuardrailPolicy(id, confirm),
    onSuccess: () => done(),
  });
}

/**
 * `POST /guardrail-policies/:id/test` (FR-GRD-001). Nothing is cached: the answer belongs to the
 * text that was typed, and the verdicts are shown as they came back.
 */
export function useTestGuardrailPolicy() {
  return useMutation({
    mutationFn: ({ id, ...body }: PolicyTestRequest & { id: Id }) => testGuardrailPolicy(id, body),
  });
}
