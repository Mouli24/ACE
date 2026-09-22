/**
 * The ports of Arch §7 — interfaces only. `packages/storage-local` provides the local adapters (and
 * `packages/tools` the Sandbox); a hosted deployment swaps in Postgres, Redis, S3 and a secret
 * manager without the engine changing (NFR-PORT-01).
 *
 * Every method takes a `Scope`. Local mode always passes `LOCAL_WORKSPACE_ID`, so the day hosted
 * mode arrives there is no signature to rewrite and no query that silently reads another tenant's
 * rows (BR-18).
 */

export * from './scope.js';
export * from './repository.js';
export * from './run-repository.js';
export * from './model-provider.js';
export * from './blob-store.js';
export * from './secret-store.js';
export * from './queue.js';
export * from './pubsub.js';
export * from './vector-index.js';
export * from './keyword-index.js';
export * from './sandbox.js';
export * from './auth.js';
