/**
 * The error model (FR-ERR-001, 003..008, Arch §28).
 *
 * `kinds.ts` states a kind, `classify.ts` works one out, `failure.ts` turns it into the state and
 * failure reason a node run records, and `retry.ts` decides whether the engine tries again.
 */
export * from './kinds.js';
export * from './classify.js';
export * from './failure.js';
export * from './retry.js';
