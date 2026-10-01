import type { ParsedDocument, ParsedHeading } from '@ace/engine';
import { extractText, getDocumentProxy } from 'unpdf';

import { ParseError } from './errors.js';

const DAMAGED =
  'The PDF could not be read. It may be damaged, password-protected or not a real PDF.';
const NUMBERED = /^(\d+(?:\.\d+){0,5})[.)]?\s+\p{Lu}/u;

/** PDFs carry no heading structure, so a heading is a short unpunctuated line that looks like one. */
function findHeadings(text: string): ParsedHeading[] {
  const headings: ParsedHeading[] = [];
  let offset = 0;
  let seenText = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const start = offset + raw.indexOf(line);
    offset += raw.length + 1;
    if (line === '') continue;
    const isFirst = !seenText;
    seenText = true;
    if (line.length > 80 || /[.,;:!?]$/.test(line) || !/\p{L}/u.test(line)) continue;
    const numbered = NUMBERED.exec(line)?.[1];
    const upper = line === line.toUpperCase() && line.length > 2;
    if (numbered !== undefined) {
      headings.push({ level: numbered.split('.').length, title: line, offset: start });
    } else if (isFirst || upper) {
      headings.push({ level: 1, title: line, offset: start });
    }
  }
  return headings;
}

export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    pages = (await extractText(pdf, { mergePages: false })).text;
  } catch {
    throw new ParseError(DAMAGED);
  }
  const text = pages
    .map((page) => page.replace(/[ \t]+\n/g, '\n').trim())
    .filter((page) => page !== '')
    .join('\n\n');
  return { text, headings: findHeadings(text) };
}
