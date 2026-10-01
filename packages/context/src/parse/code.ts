import type { ParsedDocument } from '@ace/engine';

import { decodeText } from './text.js';

/** Source code is indexed as written; the chunker splits it on its own structure. */
export function parseCode(bytes: Uint8Array): ParsedDocument {
  return { text: decodeText(bytes), headings: [] };
}
