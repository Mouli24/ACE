import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BlobRef, BlobStore, Scope } from '@ace/engine';

/**
 * Content-addressed blobs on disk (Arch §7 local adapter; S3 when hosted).
 *
 * The file name is the SHA-256 of its contents, so identical bytes are stored once however many
 * artifacts reference them (Arch §24). Wired now, first used by artifacts in round 4.
 */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  async put(scope: Scope, bytes: Uint8Array): Promise<BlobRef> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const path = this.#path(scope, hash);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);

    return { hash, size: bytes.byteLength };
  }

  async get(scope: Scope, hash: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(readFileSync(this.#path(scope, hash)));
    } catch {
      return null;
    }
  }

  async has(scope: Scope, hash: string): Promise<boolean> {
    try {
      return statSync(this.#path(scope, hash)).isFile();
    } catch {
      return false;
    }
  }

  async delete(scope: Scope, hash: string): Promise<boolean> {
    if (!(await this.has(scope, hash))) return false;
    rmSync(this.#path(scope, hash), { force: true });
    return true;
  }

  /** Sharded by the first two hex characters so one directory never holds every blob. */
  #path(scope: Scope, hash: string): string {
    return join(this.root, scope.workspaceId, hash.slice(0, 2), hash);
  }
}
