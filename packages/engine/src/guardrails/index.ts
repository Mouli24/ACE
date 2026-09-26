/**
 * The guardrail engine (FR-GRD-001..003, 007..015, 018, Arch §13).
 *
 * `checks.ts` is the seam to `@ace/guardrails` (the pure rule packs), `ports.ts` the seam to
 * `packages/storage-local`. Everything else here is engine: the policy service, the evaluator that
 * turns a check's finding into a consequence, and the HTTP surface.
 */
export * from './checks.js';
/*
 * `ports.ts` declares the policy, approval and verdict stores a second time, in the version-aware
 * vocabulary the round-3 services were written against, while `ports/guardrail-repository.ts`
 * declares the ports `packages/storage-local` actually implements and `Repository` carries. Both
 * drafts are real and neither is wrong, so the port is what `@ace/engine` exports under those four
 * names and `guardrailStoreFor` (`store.ts`) bridges the two. Only the seams with no second copy
 * are re-exported from here.
 */
export type {
  GuardrailStore,
  NodeRunLookup,
  PolicyUsageLookup,
  ProjectLookup,
  SettingsLookup,
  UsageAggregateRepository,
} from './ports.js';
export * from './store.js';
export * from './policy-service.js';
export * from './evaluator.js';
export * from './routes.js';
