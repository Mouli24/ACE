import type {
  AssistantApplyRequest,
  AssistantApplyResponse,
  AssistantProposal,
  AssistantProposeRequest,
} from '@ace/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '../app/api';
import { queryKeys } from '../workflows/query-keys';

/**
 * The Ace Assistant's two calls (ACE parity P2, D283). A proposal writes nothing, so it is a
 * mutation with no cache to touch; applying creates a project and its team's workflow, so the
 * projects list and the new project's workflows are refreshed.
 */

/** `POST /assistant/propose` — a draft; with `previous`, a revision of it. */
export function useAssistantPropose() {
  return useMutation({
    mutationFn: (body: AssistantProposeRequest): Promise<AssistantProposal> =>
      api().assistantPropose(body),
  });
}

/** `POST /assistant/apply` — the confirmation: creates the project and the team. */
export function useAssistantApply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AssistantApplyRequest): Promise<AssistantApplyResponse> =>
      api().assistantApply(body),
    onSuccess: ({ project, workflow }) => {
      queryClient.setQueryData(queryKeys.project(project.id), project);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows(workflow.projectId) });
    },
  });
}
