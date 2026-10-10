/** Query keys for Forge's files, all under `['files', projectId]` so a resync is one invalidation. */
export const fileKeys = {
  all: (projectId: string) => ['files', projectId] as const,
  folder: (projectId: string, path: string) => ['files', projectId, 'folder', path] as const,
  content: (projectId: string, path: string) => ['files', projectId, 'content', path] as const,
  list: (projectId: string) => ['files', projectId, 'list'] as const,
  status: (projectId: string) => ['files', projectId, 'status'] as const,
};
