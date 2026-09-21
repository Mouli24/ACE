/** TanStack Query keys for engine data (Arch §10.1). One place, so cache patches never drift. */
export const queryKeys = {
  settings: () => ['settings'] as const,
  projects: () => ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  workflows: (projectId: string) => ['workflows', projectId] as const,
  workflow: (id: string) => ['workflow', id] as const,
  validation: (id: string) => ['validation', id] as const,
};
