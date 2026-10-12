import type { ProcessSummary } from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';

/** Query keys for the terminal, under `['processes', projectId]`. */
export const processKeys = {
  all: (projectId: string) => ['processes', projectId] as const,
  list: (projectId: string) => ['processes', projectId, 'list'] as const,
  scripts: (projectId: string) => ['processes', projectId, 'scripts'] as const,
};

/** Running and recent processes; process frames and the mutations keep it fresh. */
export function useProcessList(projectId: string) {
  return useQuery({
    queryKey: processKeys.list(projectId),
    queryFn: () => api().listProcesses(projectId),
    enabled: projectId !== '',
    staleTime: 5_000,
  });
}

/** The project's own scripts; a change to package.json or a lockfile refreshes it. */
export function useProjectScripts(projectId: string, enabled = true) {
  return useQuery({
    queryKey: processKeys.scripts(projectId),
    queryFn: () => api().projectScripts(projectId),
    enabled: enabled && projectId !== '',
    staleTime: 30_000,
  });
}

export function useStopProcess(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (processId: string) => api().stopProcess(projectId, processId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) }),
  });
}

export const runningCount = (list: readonly ProcessSummary[] | undefined): number =>
  list?.filter((summary) => summary.status === 'running').length ?? 0;
