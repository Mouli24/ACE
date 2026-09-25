/** TanStack Query keys for engine data (Arch §10.1). One place, so cache patches never drift. */
export const queryKeys = {
  settings: () => ['settings'] as const,
  projects: () => ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  workflows: (projectId: string) => ['workflows', projectId] as const,
  workflow: (id: string) => ['workflow', id] as const,
  validation: (id: string) => ['validation', id] as const,
  providers: () => ['providers'] as const,
  provider: (id: string) => ['provider', id] as const,
  providerDetect: () => ['providers', 'detect'] as const,
  /** Every model list, whatever its filter — what a refresh invalidates (FR-MOD-006). */
  modelsRoot: () => ['models'] as const,
  models: (query: object) => ['models', query] as const,
  runs: (workflowId: string) => ['runs', workflowId] as const,
  projectRuns: (projectId: string) => ['project-runs', projectId] as const,
  run: (runId: string) => ['run', runId] as const,
  /** Every node-run list, whatever its run — what an approval decision invalidates (FR-GRD-013). */
  nodeRunsRoot: () => ['node-runs'] as const,
  nodeRuns: (runId: string) => ['node-runs', runId] as const,
  approvals: (runId: string) => ['approvals', runId] as const,
  /** Every policy list, whatever its project — what a write invalidates (FR-GRD-001). */
  guardrailPoliciesRoot: () => ['guardrail-policies'] as const,
  guardrailPolicies: (projectId: string) => ['guardrail-policies', projectId] as const,
};
