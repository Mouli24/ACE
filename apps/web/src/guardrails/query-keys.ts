/**
 * Query keys for guardrail policies (Arch §10.1).
 *
 * They live here rather than in `workflows/query-keys.ts` only because that file is not this
 * screen's to edit in this round; they belong beside the rest when it is, and the shape is the same
 * one it uses so moving them is a copy.
 */
export const guardrailKeys = {
  /** Every policy list, whatever its project — what a create or delete invalidates. */
  policiesRoot: () => ['guardrail-policies'] as const,
  policies: (projectId: string) => ['guardrail-policies', projectId] as const,
};
