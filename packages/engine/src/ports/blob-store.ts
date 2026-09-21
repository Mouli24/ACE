import type { Scope } from './scope.js';

/** What a stored blob is addressed by. */
export interface BlobRef {
  /** Content hash — the address. Identical bytes are stored once (Arch §24). */
  hash: string;
  size: number;
}

/**
 * Content-addressed object storage (Arch §7: a local folder, S3 when hosted).
 * Wired now, first used by artifacts in round 4.
 */
export interface BlobStore {
  put(scope: Scope, bytes: Uint8Array): Promise<BlobRef>;
  get(scope: Scope, hash: string): Promise<Uint8Array | null>;
  has(scope: Scope, hash: string): Promise<boolean>;
  delete(scope: Scope, hash: string): Promise<boolean>;
}
