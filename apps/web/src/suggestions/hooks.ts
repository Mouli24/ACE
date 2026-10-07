import type {
  CreateProjectNoteRequest,
  CreateResponsibilityRequest,
  Id,
  ProjectNote,
  Responsibility,
  Suggestion,
  SuggestionStatus,
  SuggestionsChangedPayload,
  UpdateProjectNoteRequest,
  UpdateResponsibilityRequest,
} from '@ace/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { api } from '../app/api';
import { taskKeys } from '../tasks/keys';

/**
 * Engine data for the Suggestions and Notes pages (ACE parity P2, D280, D281). The engine announces
 * every change as `project.changed { projectId, what }` on the engine scope (`app/socket.ts` routes
 * it to `invalidateProjectChanged`); while a scan runs, the responsibilities are also polled, so the
 * page follows the scan even when the socket is down.
 */
export const suggestionKeys = {
  responsibilities: (projectId: Id) => ['responsibilities', projectId] as const,
  /** Every suggestion list of one project, whatever its status filter. */
  suggestionLists: (projectId: Id) => ['suggestions', projectId] as const,
  suggestions: (projectId: Id, status: SuggestionStatus | undefined) =>
    ['suggestions', projectId, status ?? 'all'] as const,
  notes: (projectId: Id) => ['project-notes', projectId] as const,
};

/** How often the responsibilities are asked for while one of them is scanning. */
export const SCAN_POLL_MS = 1_000;

export const isScanning = (responsibility: Responsibility): boolean =>
  responsibility.lastScanStatus === 'running';

/** `project.changed` from the engine: the named list of that project is stale. */
export function invalidateProjectChanged(
  queryClient: QueryClient,
  payload: SuggestionsChangedPayload,
): void {
  const key =
    payload.what === 'responsibilities'
      ? suggestionKeys.responsibilities(payload.projectId)
      : payload.what === 'suggestions'
        ? suggestionKeys.suggestionLists(payload.projectId)
        : suggestionKeys.notes(payload.projectId);
  void queryClient.invalidateQueries({ queryKey: key });
}

/* -------------------------------------------------------------------------- */
/* Responsibilities                                                            */
/* -------------------------------------------------------------------------- */

/** `GET /projects/:id/responsibilities`, polled while a scan runs. */
export function useResponsibilities(projectId: Id) {
  return useQuery({
    queryKey: suggestionKeys.responsibilities(projectId),
    queryFn: async () => (await api().listResponsibilities(projectId)).items,
    enabled: projectId !== '',
    refetchInterval: (query) => ((query.state.data ?? []).some(isScanning) ? SCAN_POLL_MS : false),
  });
}

/**
 * When a scan this screen saw running ends, its suggestions are fetched again: the poll that saw it
 * finish may have come before the suggestion list did.
 */
export function useRefreshWhenScansEnd(
  projectId: Id,
  responsibilities: Responsibility[] | undefined,
) {
  const queryClient = useQueryClient();
  const running = useRef(new Set<Id>());
  useEffect(() => {
    const now = new Set((responsibilities ?? []).filter(isScanning).map((r) => r.id));
    const ended = [...running.current].some((id) => !now.has(id));
    running.current = now;
    if (ended) {
      void queryClient.invalidateQueries({ queryKey: suggestionKeys.suggestionLists(projectId) });
    }
  }, [projectId, queryClient, responsibilities]);
}

/** The answered responsibility into the list at once, then the list follows the engine. */
function settleResponsibility(queryClient: QueryClient, saved: Responsibility): void {
  const key = suggestionKeys.responsibilities(saved.projectId);
  queryClient.setQueryData<Responsibility[]>(key, (list) =>
    list === undefined
      ? list
      : list.some((row) => row.id === saved.id)
        ? list.map((row) => (row.id === saved.id ? saved : row))
        : [...list, saved],
  );
  void queryClient.invalidateQueries({ queryKey: key });
}

/** `POST /projects/:id/responsibilities` — saving one scans nothing. */
export function useCreateResponsibility(projectId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateResponsibilityRequest): Promise<Responsibility> =>
      api().createResponsibility(projectId, body),
    onSuccess: (saved) => settleResponsibility(queryClient, saved),
  });
}

/** `PATCH /responsibilities/:id` — edit, watch, interval, pause. */
export function useUpdateResponsibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: UpdateResponsibilityRequest }) =>
      api().updateResponsibility(id, body),
    onSuccess: (saved) => settleResponsibility(queryClient, saved),
  });
}

/** `DELETE /responsibilities/:id` — its suggestions go with it. */
export function useDeleteResponsibility(projectId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id): Promise<void> => api().deleteResponsibility(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: suggestionKeys.responsibilities(projectId) });
      void queryClient.invalidateQueries({ queryKey: suggestionKeys.suggestionLists(projectId) });
    },
  });
}

/** `POST /responsibilities/:id/scan` — answers `running` at once. */
export function useScanResponsibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id): Promise<Responsibility> => api().scanResponsibility(id),
    onSuccess: (saved) => settleResponsibility(queryClient, saved),
    onError: (_error, id) => {
      // A refusal (already running, not connected) means the screen may be behind the engine.
      const owner = queryClient
        .getQueriesData<Responsibility[]>({ queryKey: ['responsibilities'] })
        .flatMap(([, list]) => list ?? [])
        .find((row) => row.id === id);
      if (owner !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: suggestionKeys.responsibilities(owner.projectId),
        });
      }
    },
  });
}

/** `POST /responsibilities/:id/cancel-scan` — answers once the scan has stopped. */
export function useCancelScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id): Promise<Responsibility> => api().cancelResponsibilityScan(id),
    onSuccess: (saved) => {
      settleResponsibility(queryClient, saved);
      void queryClient.invalidateQueries({
        queryKey: suggestionKeys.suggestionLists(saved.projectId),
      });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Suggestions                                                                 */
/* -------------------------------------------------------------------------- */

/** `GET /projects/:id/suggestions[?status]`, newest first. */
export function useSuggestions(projectId: Id, status: SuggestionStatus | undefined) {
  return useQuery({
    queryKey: suggestionKeys.suggestions(projectId, status),
    queryFn: async () =>
      (await api().listSuggestions(projectId, status === undefined ? {} : { status })).items,
    enabled: projectId !== '',
    placeholderData: (previous) => previous,
  });
}

export type SuggestionDecision =
  { id: Id; decision: 'accept'; workflowId?: Id } | { id: Id; decision: 'later' | 'dismiss' };

/**
 * *Add to Inbox*, *Later*, *Dismiss*. Adding creates an Inbox task, so the board's lists are
 * refreshed too; a refusal (decided elsewhere) refreshes the suggestions.
 */
export function useDecideSuggestion(projectId: Id) {
  const queryClient = useQueryClient();
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: suggestionKeys.suggestionLists(projectId) });
  return useMutation({
    mutationFn: (input: SuggestionDecision): Promise<Suggestion> => {
      if (input.decision === 'accept') {
        return api().acceptSuggestion(
          input.id,
          input.workflowId === undefined ? {} : { workflowId: input.workflowId },
        );
      }
      return input.decision === 'later'
        ? api().laterSuggestion(input.id)
        : api().dismissSuggestion(input.id);
    },
    onSuccess: (saved) => {
      refresh();
      if (saved.taskId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: taskKeys.lists(projectId) });
      }
    },
    onError: refresh,
  });
}

/* -------------------------------------------------------------------------- */
/* Team notes (D281)                                                           */
/* -------------------------------------------------------------------------- */

/** `GET /projects/:id/notes`, oldest first — the order a run's prompt gets them in. */
export function useProjectNotes(projectId: Id) {
  return useQuery({
    queryKey: suggestionKeys.notes(projectId),
    queryFn: async () => (await api().listProjectNotes(projectId)).items,
    enabled: projectId !== '',
  });
}

function settleNotes(queryClient: QueryClient, projectId: Id, saved?: ProjectNote): void {
  const key = suggestionKeys.notes(projectId);
  if (saved !== undefined) {
    queryClient.setQueryData<ProjectNote[]>(key, (list) =>
      list === undefined
        ? list
        : list.some((row) => row.id === saved.id)
          ? list.map((row) => (row.id === saved.id ? saved : row))
          : [...list, saved],
    );
  }
  void queryClient.invalidateQueries({ queryKey: key });
}

export function useCreateProjectNote(projectId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectNoteRequest): Promise<ProjectNote> =>
      api().createProjectNote(projectId, body),
    onSuccess: (saved) => settleNotes(queryClient, projectId, saved),
  });
}

/** New text confirms the note (`verified`); `status` alone marks it either way. */
export function useUpdateProjectNote(projectId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: UpdateProjectNoteRequest }) =>
      api().updateProjectNote(id, body),
    onSuccess: (saved) => settleNotes(queryClient, projectId, saved),
  });
}

/** *Forget*. */
export function useDeleteProjectNote(projectId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id): Promise<void> => api().deleteProjectNote(id),
    onSuccess: () => settleNotes(queryClient, projectId),
  });
}
