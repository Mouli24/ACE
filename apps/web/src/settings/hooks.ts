import type { SettingsPatch } from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../app/api';
import { queryKeys } from '../workflows/query-keys';

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings(), queryFn: () => api().getSettings() });
}

export function usePatchSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api().patchSettings(patch),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.settings(), settings),
  });
}
