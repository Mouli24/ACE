/**
 * The guardrail engine (FR-GRD-001..003, 007..015, 018, Arch §13).
 *
 * `checks.ts` is the seam to `@ace/guardrails` (the pure rule packs), `ports.ts` the seam to
 * `packages/storage-local`. Everything else here is engine: the policy service, the evaluator that
 * turns a check's finding into a consequence, and the HTTP surface.
 */
export * from './checks.js';
export * from './ports.js';
export * from './policy-service.js';
export * from './evaluator.js';
export * from './routes.js';
