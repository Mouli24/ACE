import type { CreateEntryRequest, FileSearchRequest, MoveEntryRequest } from '@ace/contracts';
import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { api } from '../../app/api';
import { fileKeys } from './keys';
import { parentOf } from './paths';

const folderQuery = (projectId: string, path: string) => ({
  queryKey: fileKeys.folder(projectId, path),
  queryFn: () => api().listFolder(projectId, path),
  staleTime: 30_000,
});

/** Every listed folder of the Explorer at once: the root and each expanded folder. */
export function useFolders(projectId: string, paths: readonly string[]) {
  return useQueries({
    queries: paths.map((path) => ({ ...folderQuery(projectId, path), enabled: projectId !== '' })),
  });
}

/**
 * An open file's content. Never stale by time: the watcher invalidates it when the disk changes
 * (design §5.4), and a refetch then reconciles the buffer.
 */
export const fileContentQuery = (projectId: string, path: string) => ({
  queryKey: fileKeys.content(projectId, path),
  queryFn: () => api().readFile(projectId, path),
  staleTime: Infinity,
  retry: false,
});

export function useFileContent(projectId: string, path: string | undefined) {
  return useQuery({
    ...fileContentQuery(projectId, path ?? ''),
    enabled: projectId !== '' && path !== undefined,
  });
}

const fileListQuery = (projectId: string) => ({
  queryKey: fileKeys.list(projectId),
  queryFn: () => api().listAllFiles(projectId),
  // [audit F-6] Never stale by time: `files.changed` invalidates it when a file comes or goes, and
  // the project's watch is held in every mode, so entering Forge again never walks the project.
  staleTime: Infinity,
});

/** Every file of the project (a walk of up to 50,000): the Explorer's count and filter, quick open. */
export function useFileList(projectId: string, enabled: boolean) {
  return useQuery({ ...fileListQuery(projectId), enabled: enabled && projectId !== '' });
}

/**
 * [audit F-6] Keeps the project's file list cached while the workflow is open, in every mode — an
 * observer that never fetches, so the list is not dropped after five minutes in Ideate.
 */
export function useKeepFileList(projectId: string): void {
  useQuery({ ...fileListQuery(projectId), enabled: false });
}

/**
 * Search's results (D299 Phase 4) for a request given as JSON (stable, so a re-render is never a
 * new search); `undefined` asks for nothing. The last results stay while the next ones load. The
 * query's signal goes to the engine (fix C1/I3): a search replaced by a newer one, refetched, or
 * no longer wanted is aborted there too, ending its worker.
 */
export function useFileSearch(projectId: string, request: string | undefined) {
  return useQuery({
    queryKey: fileKeys.search(projectId, request ?? ''),
    queryFn: ({ signal }) =>
      api().searchFiles(projectId, JSON.parse(request ?? '{}') as FileSearchRequest, { signal }),
    enabled: projectId !== '' && request !== undefined,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** The Explorer's git decorations; `files.changed` refreshes it at most once a second. */
export function useRepoStatus(projectId: string) {
  return useQuery({
    queryKey: fileKeys.status(projectId),
    queryFn: () => api().repoStatus(projectId),
    enabled: projectId !== '',
    staleTime: 1_000,
  });
}

/** After a create, move or delete: the folders that show the paths, quick open's list, the status. */
export function invalidateAround(
  queryClient: QueryClient,
  projectId: string,
  paths: readonly string[],
): void {
  for (const path of paths) {
    void queryClient.invalidateQueries({ queryKey: fileKeys.folder(projectId, parentOf(path)) });
  }
  void queryClient.invalidateQueries({ queryKey: fileKeys.list(projectId) });
  void queryClient.invalidateQueries({ queryKey: fileKeys.status(projectId) });
}

export function useCreateEntry(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEntryRequest) => api().createEntry(projectId, body),
    onSuccess: (entry) => invalidateAround(queryClient, projectId, [entry.path]),
  });
}

export function useMoveEntry(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: MoveEntryRequest) => api().moveEntry(projectId, body),
    onSuccess: (_entry, body) => invalidateAround(queryClient, projectId, [body.from, body.to]),
  });
}

export function useDeleteEntry(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api().deleteEntry(projectId, path),
    onSuccess: (_nothing, path) => {
      invalidateAround(queryClient, projectId, [path]);
      queryClient.removeQueries({ queryKey: fileKeys.folder(projectId, path) });
    },
  });
}
