import type { Provider, ProviderStatusPayload } from '@ace/contracts';
import type { QueryClient } from '@tanstack/react-query';

import { queryKeys } from '../workflows/query-keys';

/**
 * Fold a `provider.status` frame into the query cache (FR-PRV-004, TC-PRV-005).
 *
 * The engine owns the truth (BR-01), so the frame patches the cached rows rather than driving a
 * store of its own: the providers list, the top bar and Settings all read the same query and
 * therefore cannot disagree, and no screen needs a reload to show a status change.
 */
export function patchProviderStatus(
  queryClient: QueryClient,
  payload: ProviderStatusPayload,
  now: string = new Date().toISOString(),
): void {
  const apply = (provider: Provider): Provider => {
    const next: Provider = { ...provider, status: payload.status, lastCheckedAt: now };
    if (payload.message === undefined) delete next.statusMessage;
    else next.statusMessage = payload.message;
    return next;
  };

  queryClient.setQueryData<Provider[]>(queryKeys.providers(), (providers) =>
    providers?.map((provider) => (provider.id === payload.providerId ? apply(provider) : provider)),
  );
  queryClient.setQueryData<Provider>(queryKeys.provider(payload.providerId), (provider) =>
    provider === undefined ? provider : apply(provider),
  );
}
