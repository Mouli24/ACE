import type { SettingsPatch } from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../app/api';
import { queryKeys } from '../workflows/query-keys';

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings(), queryFn: () => api().getSettings() });
}

/**
 * `PATCH /settings`. The answer is the engine's settings, written straight into the cache; the query
 * is then refetched either way, so after a save — or a refused one — every field shows what the
 * engine holds (BR-01, TC-SYS-006).
 */
export function usePatchSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api().patchSettings(patch),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.settings(), settings),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings() }),
  });
}
