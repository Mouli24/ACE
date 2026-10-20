import type { Id, Model, ModelCapabilitiesPatch, ModelQuery, Provider, UpdateProviderRequest } from '@ace/contracts';
import type { CreateProviderBody } from '@ace/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../app/api';
import { queryKeys } from '../workflows/query-keys';

/** `GET /providers` (FR-PRV-001). The list is small, so it is fetched whole and filtered locally. */
export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers(),
    queryFn: async () => (await api().listProviders()).items,
  });
}

/**
 * `GET /models` (FR-MOD-004). The filter is part of the key so a narrowed table is cached on its
 * own, and `refreshedAt` is kept alongside the rows because FR-MOD-006 shows it.
 */
export function useModels(query: ModelQuery = {}) {
  return useQuery({
    queryKey: queryKeys.models(query),
    queryFn: () => api().listModels(query),
  });
}

/** FR-PRV-007: whether a local Ollama answered on its default address. Asked once per mount. */
export function useProviderDetect() {
  return useQuery({
    queryKey: queryKeys.providerDetect(),
    queryFn: () => api().detectProviders(),
    staleTime: 30_000,
  });
}

function useProvidersInvalidator() {
  const queryClient = useQueryClient();
  return (provider?: Provider) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.modelsRoot() });
    if (provider) queryClient.setQueryData(queryKeys.provider(provider.id), provider);
  };
}

export function useCreateProvider() {
  const done = useProvidersInvalidator();
  return useMutation({
    mutationFn: (body: CreateProviderBody) => api().createProvider(body),
    onSuccess: (provider) => done(provider),
  });
}

export function useUpdateProvider() {
  const done = useProvidersInvalidator();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateProviderRequest & { id: Id }) =>
      api().updateProvider(id, body),
    onSuccess: (provider) => done(provider),
  });
}

/**
 * `DELETE /providers/:id` (FR-PRV-005). Without `confirm` the engine answers 409 `provider_in_use`
 * and names the nodes; the screen turns that into the confirmation, then calls again with it.
 */
export function useDeleteProvider() {
  const done = useProvidersInvalidator();
  return useMutation({
    mutationFn: ({ id, confirm }: { id: Id; confirm?: boolean }) =>
      api().deleteProvider(id, confirm === undefined ? {} : { confirm }),
    onSuccess: () => done(),
  });
}

/** `POST /providers/:id/check` (FR-PRV-003). The result also arrives as `provider.status`. */
export function useCheckProvider() {
  const done = useProvidersInvalidator();
  return useMutation({
    mutationFn: (id: Id) => api().checkProvider(id),
    onSuccess: () => done(),
  });
}

/** `POST /providers/:id/refresh-models` (FR-MOD-006). */
export function useRefreshModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => api().refreshModels(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.modelsRoot() });
    },
  });
}

/** `PATCH /providers/:id/models/:modelId` (D380): the person's say on a model's tools and window. */
export function usePatchModelCapabilities() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { providerId: Id; modelId: string; patch: ModelCapabilitiesPatch }) =>
      api().patchModelCapabilities(input.providerId, input.modelId, input.patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.modelsRoot() });
    },
  });
}

/** Group a catalog by provider id, so a table can show provider names beside their models. */
export function modelsByProvider(models: Model[]): Map<Id, Model[]> {
  const grouped = new Map<Id, Model[]>();
  for (const model of models) {
    const list = grouped.get(model.providerId);
    if (list) list.push(model);
    else grouped.set(model.providerId, [model]);
  }
  return grouped;
}

/**
 * X1 (FR-PRV-008): the terminal scan behind Add provider. Fresh every time the dialog opens — a
 * CLI installed or signed in a moment ago must show — so nothing is kept between opens.
 */
export function useCliScan() {
  return useQuery({
    queryKey: queryKeys.cliScan(),
    queryFn: () => api().detectClis(),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
