import type { ChunkDraft, ParsedDocument } from '@ace/engine';

import { createLineIndex, estimateTokens, hardSplit, tokensToChars, trimSpan } from './tokens.js';
import type { Span } from './tokens.js';

/** A top-level declaration starts in column 0 (the "never inside a function" rule of §2.1). */
const DECLARATION =
  /^(?:export\b|function\b|async\s+function\b|class\b|abstract\s+class\b|def\b|interface\b|type\b|const\b[^\n]*=>)/;

/** Lines that belong to the declaration below them: doc comments, line comments and decorators. */
const LEADING_TRIVIA = /^(?:\/\*\*|\*|\*\/|\/\/|#|@)/;

interface Line {
  start: number;
  end: number;
  text: string;
}

function toLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline + 1;
    if (end > start) lines.push({ start, end, text: text.slice(start, end) });
    if (newline === -1) break;
    start = end;
  }
  return lines;
}

/** Offsets where a new declaration begins, pulled up over any comment lines directly above it. */
function boundaries(lines: Line[]): number[] {
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (!DECLARATION.test(line.text)) return;
    let at = index;
    while (at > 0 && LEADING_TRIVIA.test((lines[at - 1] as Line).text)) at -= 1;
    const offset = (lines[at] as Line).start;
    if (offset > 0 && !starts.includes(offset)) starts.push(offset);
  });
  return starts;
}

/** Splits an oversized declaration at line boundaries, and inside a line only when the line alone is too long. */
function splitDeclaration(text: string, span: Span, max: number): Span[] {
  const result: Span[] = [];
  let start = span.start;
  let end = span.start;
  const flush = (): void => {
    const trimmed = end > start ? trimSpan(text, { start, end }) : null;
    if (trimmed) result.push(trimmed);
  };
  for (const line of toLines(text.slice(span.start, span.end))) {
    const lineStart = span.start + line.start;
    const lineEnd = span.start + line.end;
    if (lineEnd - lineStart > max) {
      flush();
      result.push(...hardSplit(text, { start: lineStart, end: lineEnd }, max));
      start = lineEnd;
      end = lineEnd;
    } else if (lineEnd - start > max) {
      flush();
      start = lineStart;
      end = lineEnd;
    } else {
      end = lineEnd;
    }
  }
  flush();
  return result;
}

export function chunkCode(input: {
  document: ParsedDocument;
  documentName: string;
  chunkSize: number;
}): ChunkDraft[] {
  const { text } = input.document;
  const max = tokensToChars(input.chunkSize);
  const lineOf = createLineIndex(text);
  const cuts = boundaries(toLines(text));
  const edges = [0, ...cuts, text.length];
  const segments: Span[] = [];
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const span = trimSpan(text, { start: edges[i] as number, end: edges[i + 1] as number });
    if (!span) continue;
    if (span.end - span.start <= max) segments.push(span);
    else segments.push(...splitDeclaration(text, span, max));
  }

  const drafts: ChunkDraft[] = [];
  let index = 0;
  while (index < segments.length) {
    const first = segments[index] as Span;
    let end = first.end;
    index += 1;
    while (index < segments.length && (segments[index] as Span).end - first.start <= max) {
      end = (segments[index] as Span).end;
      index += 1;
    }
    // Keep the first line's indentation: it is part of the code.
    let start = first.start;
    while (start > 0 && [' ', '\t'].includes(text.charAt(start - 1))) start -= 1;
    const chunkText = text.slice(start, end);
    drafts.push({
      ordinal: drafts.length,
      text: chunkText,
      tokens: estimateTokens(chunkText),
      source: `${input.documentName}#L${lineOf(start)}-L${lineOf(end - 1)}`,
      headings: [],
    });
  }
  return drafts;
}
