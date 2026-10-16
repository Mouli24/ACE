import type {
  BenchExperiment,
  CreateBenchExperimentRequest,
  CreateBenchTaskRequest,
  Id,
  ImportBenchScoresRequest,
  UpdateBenchExperimentRequest,
  UpdateBenchTaskRequest,
} from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../app/api';

/**
 * ACE Bench's engine data (PG-5.6). Every screen reads the engine; there is no demo data. An
 * experiment that is running is polled, since its runs end one after another on their own.
 */
export const benchKeys = {
  root: () => ['bench'] as const,
  tasks: () => ['bench', 'tasks'] as const,
  experiments: () => ['bench', 'experiments'] as const,
  experiment: (id: Id) => ['bench', 'experiment', id] as const,
  report: (id: Id) => ['bench', 'report', id] as const,
};

const LIVE_MS = 2000;

export const isLive = (experiment: BenchExperiment | undefined): boolean =>
  experiment?.status === 'running' || experiment?.status === 'waiting_approval';

export function useBenchTasks() {
  return useQuery({ queryKey: benchKeys.tasks(), queryFn: () => api().listBenchTasks() });
}

export function useBenchExperiments() {
  return useQuery({
    queryKey: benchKeys.experiments(),
    queryFn: () => api().listBenchExperiments(),
    refetchInterval: (query) => (query.state.data?.some(isLive) === true ? LIVE_MS : false),
  });
}

export function useBenchExperiment(id: Id | undefined) {
  return useQuery({
    queryKey: benchKeys.experiment(id ?? ''),
    queryFn: () => api().getBenchExperiment(id ?? ''),
    enabled: Boolean(id),
    refetchInterval: (query) => (isLive(query.state.data) ? LIVE_MS : false),
  });
}

export function useBenchReport(id: Id | undefined, live: boolean) {
  return useQuery({
    queryKey: benchKeys.report(id ?? ''),
    queryFn: () => api().benchReport(id ?? ''),
    enabled: Boolean(id),
    refetchInterval: live ? LIVE_MS : false,
  });
}

function useInvalidateBench() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: benchKeys.root() });
}

export function useCreateBenchTask() {
  const done = useInvalidateBench();
  return useMutation({
    mutationFn: (body: CreateBenchTaskRequest) => api().createBenchTask(body),
    onSuccess: done,
  });
}

export function useUpdateBenchTask() {
  const done = useInvalidateBench();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: UpdateBenchTaskRequest }) =>
      api().updateBenchTask(id, body),
    onSuccess: done,
  });
}

export function useFreezeBenchTask() {
  const done = useInvalidateBench();
  return useMutation({
    mutationFn: (id: Id) => api().freezeBenchTask(id),
    onSuccess: done,
  });
}

export function useCreateBenchExperiment() {
  const done = useInvalidateBench();
  return useMutation({
    mutationFn: (body: CreateBenchExperimentRequest) => api().createBenchExperiment(body),
    onSuccess: done,
  });
}

export function useUpdateBenchExperiment() {
  const done = useInvalidateBench();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: UpdateBenchExperimentRequest }) =>
      api().updateBenchExperiment(id, body),
    onSuccess: done,
  });
}

export function useStartBenchExperiment() {
  const done = useInvalidateBench();
  return useMutation({
    mutationFn: (id: Id) => api().startBenchExperiment(id),
    onSuccess: done,
  });
}

export function useImportBenchScores() {
  const done = useInvalidateBench();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: ImportBenchScoresRequest }) =>
      api().importBenchScores(id, body),
    onSuccess: done,
  });
}

/** FR-BEN-005: the blind export as a JSON file the judge opens. Labels only — no arm, no model. */
export async function downloadBlindExport(id: Id, name: string): Promise<void> {
  const file = await api().benchBlindExport(id);
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name.replace(/[^\w-]+/g, '-') || 'experiment'}.blind.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
