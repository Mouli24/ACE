import type { Chunker } from '@ace/engine';

import { chunkCode } from './code.js';
import { chunkProse } from './prose.js';

export { estimateTokens } from './tokens.js';

/** Chunks a parsed document by headings and paragraphs (prose) or top-level declarations (code), §2.1. */
export function createChunker(): Chunker {
  return {
    chunk({ document, documentName, kind, chunkSize, chunkOverlap }) {
      return kind === 'code'
        ? chunkCode({ document, documentName, chunkSize })
        : chunkProse({ document, documentName, chunkSize, chunkOverlap });
    },
  };
}
