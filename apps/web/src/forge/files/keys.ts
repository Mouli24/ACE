/** Query keys for Forge's files, all under `['files', projectId]` so a resync is one invalidation. */
export const fileKeys = {
  all: (projectId: string) => ['files', projectId] as const,
  folder: (projectId: string, path: string) => ['files', projectId, 'folder', path] as const,
  content: (projectId: string, path: string) => ['files', projectId, 'content', path] as const,
  list: (projectId: string) => ['files', projectId, 'list'] as const,
  status: (projectId: string) => ['files', projectId, 'status'] as const,
  /** Every Search of the project; `files.changed` refreshes them (D299 Phase 4). */
  searches: (projectId: string) => ['files', projectId, 'search'] as const,
  /** One Search, keyed by its request as JSON. */
  search: (projectId: string, request: string) => ['files', projectId, 'search', request] as const,
};
