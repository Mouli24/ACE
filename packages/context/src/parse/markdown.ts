import type { ParsedDocument, ParsedHeading } from '@ace/engine';

import { decodeText } from './text.js';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** Headings are the ATX `#` lines outside code fences; `offset` points at the title text. */
export function parseMarkdown(bytes: Uint8Array): ParsedDocument {
  const text = decodeText(bytes);
  const headings: ParsedHeading[] = [];
  let fence: string | null = null;
  let lineStart = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (fence === null) {
      const match = ATX_HEADING.exec(line);
      const title = match?.[2]?.trim();
      if (match?.[1] !== undefined && title) {
        headings.push({
          level: match[1].length,
          title,
          offset: lineStart + line.indexOf(title, match[1].length),
        });
      }
    }
    lineStart += rawLine.length + 1;
  }
  return { text, headings };
}
