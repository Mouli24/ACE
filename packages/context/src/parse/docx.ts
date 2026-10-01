import type { ParsedDocument } from '@ace/engine';
import mammoth from 'mammoth';

import { ParseError } from './errors.js';
import { domToText, parseDom } from './html.js';

const DAMAGED = 'The Word document could not be read. It may be damaged or not a .docx file.';

/** DOCX to HTML through mammoth (Heading styles become h1-h6), then the same text walk as HTML. */
export async function parseDocx(bytes: Uint8Array): Promise<ParsedDocument> {
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })).value;
  } catch {
    throw new ParseError(DAMAGED);
  }
  const body = parseDom(`<html><body>${html}</body></html>`).body;
  return body === null ? { text: '', headings: [] } : domToText(body);
}
