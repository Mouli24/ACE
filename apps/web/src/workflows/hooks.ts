import type { Workflow, WorkflowGraphResponse } from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { api } from '../app/api';
import { queryKeys } from './query-keys';
import { getGraphSync } from './sync-registry';

export function useWorkflows(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.workflows(projectId ?? ''),
    queryFn: async () => (await api().listWorkflows(projectId ?? '')).items,
    enabled: Boolean(projectId),
  });
}

/** The whole graph in one query: nodes AND edges arrive together (FR-CAN-010). */
export function useWorkflowGraph(workflowId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.workflow(workflowId ?? ''),
    queryFn: () => api().getWorkflow(workflowId ?? ''),
    enabled: Boolean(workflowId),
    staleTime: Infinity,
  });
}

/** The autosave controller for this workflow (FR-WF-004/005). */
export function useGraphSync(workflowId: string) {
  const queryClient = useQueryClient();
  const sync = useMemo(() => getGraphSync(workflowId, queryClient), [workflowId, queryClient]);
  useEffect(() => () => void sync.flush(), [sync]);
  return sync;
}

function useWorkflowListInvalidator(projectId: string) {
  const queryClient = useQueryClient();
  return (workflow?: Workflow) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflows(projectId) });
    if (workflow) {
      queryClient.setQueryData<WorkflowGraphResponse | undefined>(
        queryKeys.workflow(workflow.id),
        (old) => (old ? { ...old, workflow } : old),
      );
    }
  };
}

export function useCreateWorkflow(projectId: string) {
  const done = useWorkflowListInvalidator(projectId);
  return useMutation({
    mutationFn: (name: string) => api().createWorkflow(projectId, { name }),
    onSuccess: (workflow) => done(workflow),
  });
}

export function useRenameWorkflow(projectId: string) {
  const done = useWorkflowListInvalidator(projectId);
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api().updateWorkflow(id, { name }),
    onSuccess: (workflow) => done(workflow),
  });
}

export function useDuplicateWorkflow(projectId: string) {
  const queryClient = useQueryClient();
  const done = useWorkflowListInvalidator(projectId);
  return useMutation({
    mutationFn: (id: string) => api().duplicateWorkflow(id),
    onSuccess: (graph) => {
      queryClient.setQueryData(queryKeys.workflow(graph.workflow.id), graph);
      done();
    },
  });
}

export function useDeleteWorkflow(projectId: string) {
  const queryClient = useQueryClient();
  const done = useWorkflowListInvalidator(projectId);
  return useMutation({
    mutationFn: (id: string) => api().deleteWorkflow(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.workflow(id) });
      done();
    },
  });
}

export function useImportWorkflow(projectId: string) {
  const queryClient = useQueryClient();
  const done = useWorkflowListInvalidator(projectId);
  return useMutation({
    mutationFn: (file: unknown) => api().importWorkflow(projectId, file as never),
    onSuccess: (graph) => {
      queryClient.setQueryData(queryKeys.workflow(graph.workflow.id), graph);
      done();
    },
  });
}
