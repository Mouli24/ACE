import { createHash } from 'node:crypto';

import { type ReadLedger } from './session.js';

/**
 * Agentic nodes, Phase 1 (FR-TOOL-008, read-before-edit): what each node of a run last read or
 * wrote, as a content hash per absolute path. `write_file` and `edit_file` refuse an existing file
 * whose current hash is not the one the calling node saw, so a node never overwrites a change it
 * has not read — another node's, a command's or the person's.
 */

/** sha256 of a file's bytes (or a string's UTF-8 bytes), as lowercase hex. */
export function contentHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ReadLedgerOptions {
  /** Windows paths are case-insensitive, so they are keyed folded. Defaults to this process's. */
  readonly platform?: NodeJS.Platform;
}

export function createReadLedger(options: ReadLedgerOptions = {}): ReadLedger {
  const fold = (options.platform ?? process.platform) === 'win32';
  const key = (absolutePath: string): string => (fold ? absolutePath.toLowerCase() : absolutePath);
  const byNode = new Map<string, Map<string, string>>();

  return {
    record(nodeId, absolutePath, hash) {
      let files = byNode.get(nodeId);
      if (files === undefined) {
        files = new Map();
        byNode.set(nodeId, files);
      }
      files.set(key(absolutePath), hash);
    },
    seen(nodeId, absolutePath) {
      return byNode.get(nodeId)?.get(key(absolutePath));
    },
  };
}
