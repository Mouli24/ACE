import type { ParsedDocument } from '@ace/engine';

import { ParseError } from './errors.js';

/** Decodes UTF-8 text, dropping a byte-order mark; a file with NUL bytes is binary, not text. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) {
    throw new ParseError('The file looks like binary data, not text, so it could not be read.');
  }
  // TextDecoder drops a leading byte-order mark by default.
  return new TextDecoder('utf-8').decode(bytes);
}

export function parseText(bytes: Uint8Array): ParsedDocument {
  return { text: decodeText(bytes), headings: [] };
}
