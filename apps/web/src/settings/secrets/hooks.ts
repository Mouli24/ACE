import type { CreateSecretRequest, Secret, UpdateSecretRequest } from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';

/**
 * Engine data for Settings › Secrets (ACE parity P1, D274). A value is sent on create and on
 * replace and never read back: every answer is a row, written into the list, then the list is
 * refetched so it shows what the engine holds.
 */

export const secretKeys = {
  all: () => ['secrets'] as const,
};

export function useSecrets() {
  return useQuery({
    queryKey: secretKeys.all(),
    queryFn: async () => (await api().listSecrets()).items,
  });
}

function useSettle() {
  const queryClient = useQueryClient();
  return {
    put: (secret: Secret) =>
      queryClient.setQueryData<Secret[]>(secretKeys.all(), (list) =>
        [...(list ?? []).filter((row) => row.name !== secret.name), secret].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      ),
    refetch: () => queryClient.invalidateQueries({ queryKey: secretKeys.all() }),
  };
}

/** `POST /secrets` — 409 `name_taken` when the name exists. */
export function useCreateSecret() {
  const settle = useSettle();
  return useMutation({
    mutationFn: (body: CreateSecretRequest) => api().createSecret(body),
    onSuccess: settle.put,
    onSettled: settle.refetch,
  });
}

/** `PATCH /secrets/:name` — a `value` replaces the stored one. */
export function useUpdateSecret() {
  const settle = useSettle();
  return useMutation({
    mutationFn: ({ name, ...body }: UpdateSecretRequest & { name: string }) =>
      api().updateSecret(name, body),
    onSuccess: settle.put,
    onSettled: settle.refetch,
  });
}

/** `DELETE /secrets/:name` — the keychain entry goes with it. */
export function useDeleteSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api().deleteSecret(name),
    onSuccess: (_answer, name) =>
      queryClient.setQueryData<Secret[]>(secretKeys.all(), (list) =>
        (list ?? []).filter((row) => row.name !== name),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: secretKeys.all() }),
  });
}
