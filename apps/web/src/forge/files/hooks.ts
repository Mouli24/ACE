import type { CreateEntryRequest, MoveEntryRequest } from '@ace/contracts';
import {
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

/** Quick open's list (Ctrl/⌘+P), fetched when it opens. */
export function useFileList(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: fileKeys.list(projectId),
    queryFn: () => api().listAllFiles(projectId),
    enabled: enabled && projectId !== '',
    staleTime: 60_000,
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
