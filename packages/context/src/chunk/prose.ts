import type { ChunkDraft, ParsedDocument } from '@ace/engine';

import { createLineIndex, estimateTokens, hardSplit, tokensToChars, trimSpan } from './tokens.js';
import type { Span } from './tokens.js';

/** The separator written between an overlap and the text that follows it. */
const OVERLAP_SEPARATOR = '\n\n';

interface Section {
  span: Span;
  headings: string[];
}

/** Splits the text at every heading offset; each section carries its heading path, outermost first. */
function sections(document: ParsedDocument): Section[] {
  const { text, headings } = document;
  const sorted = [...headings]
    .filter((h) => h.offset >= 0 && h.offset < text.length)
    .sort((a, b) => a.offset - b.offset);
  const result: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let start = 0;
  let path: string[] = [];
  const close = (end: number): void => {
    if (end > start) result.push({ span: { start, end }, headings: path });
  };
  for (const heading of sorted) {
    close(heading.offset);
    start = Math.max(start, heading.offset);
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) stack.pop();
    stack.push({ level: heading.level, title: heading.title });
    path = stack.map((entry) => entry.title);
  }
  close(text.length);
  return result;
}

function paragraphs(text: string, section: Span): Span[] {
  const spans: Span[] = [];
  // A blank line, with LF or CRLF newlines; the text itself is never rewritten, so heading offsets stay valid.
  const blank = /\r?\n[ \t\r]*\r?\n/g;
  const slice = text.slice(section.start, section.end);
  let from = 0;
  for (const match of slice.matchAll(blank)) {
    const trimmed = trimSpan(text, {
      start: section.start + from,
      end: section.start + match.index,
    });
    if (trimmed) spans.push(trimmed);
    from = match.index + match[0].length;
  }
  const last = trimSpan(text, { start: section.start + from, end: section.end });
  if (last) spans.push(last);
  return spans;
}

function sentences(text: string, paragraph: Span): Span[] {
  const spans: Span[] = [];
  const boundary = /[.!?]["')\]]*\s+/g;
  const slice = text.slice(paragraph.start, paragraph.end);
  let from = 0;
  for (const match of slice.matchAll(boundary)) {
    const end = match.index + match[0].length;
    spans.push({ start: paragraph.start + from, end: paragraph.start + end });
    from = end;
  }
  if (from < slice.length) spans.push({ start: paragraph.start + from, end: paragraph.end });
  return spans.flatMap((s) => trimSpan(text, s) ?? []);
}

/** Paragraphs no larger than `max` characters; oversized ones fall back to sentences, then to a hard split. */
function pieces(text: string, section: Span, max: number): Span[] {
  const result: Span[] = [];
  for (const paragraph of paragraphs(text, section)) {
    if (paragraph.end - paragraph.start <= max) {
      result.push(paragraph);
      continue;
    }
    for (const sentence of sentences(text, paragraph)) {
      if (sentence.end - sentence.start <= max) result.push(sentence);
      else result.push(...hardSplit(text, sentence, max));
    }
  }
  return result;
}

/** The last `overlapChars` characters of `previous`, starting at a word boundary. */
function overlapTail(previous: string, overlapChars: number): string {
  if (overlapChars <= 0 || previous.length === 0) return '';
  const from = Math.max(0, previous.length - overlapChars);
  let tail = previous.slice(from);
  if (from > 0 && !/\s/.test(previous.charAt(from - 1))) {
    const space = tail.search(/\s/);
    tail = space === -1 ? '' : tail.slice(space);
  }
  return tail.trim();
}

export function chunkProse(input: {
  document: ParsedDocument;
  documentName: string;
  chunkSize: number;
  chunkOverlap: number;
}): ChunkDraft[] {
  const { document, documentName } = input;
  const { text } = document;
  const sizeChars = tokensToChars(input.chunkSize);
  // The overlap never takes more than half of a chunk, so every piece always fits beside it.
  const overlapChars = Math.min(
    Math.max(0, Math.floor(input.chunkOverlap)) * 4,
    Math.floor(sizeChars / 2),
  );
  const reserved = overlapChars > 0 ? overlapChars + OVERLAP_SEPARATOR.length : 0;
  const maxPiece = Math.max(1, sizeChars - reserved);
  const lineOf = createLineIndex(text);
  const drafts: ChunkDraft[] = [];

  for (const section of sections(document)) {
    const parts = pieces(text, section.span, maxPiece);
    const heading = section.headings[section.headings.length - 1];
    // By design the overlap never crosses a section: a chunk never spans a heading, so `previous`
    // starts empty for every section.
    let previous = '';
    let index = 0;
    while (index < parts.length) {
      const prefix = overlapTail(previous, overlapChars);
      const budget = sizeChars - (prefix ? prefix.length + OVERLAP_SEPARATOR.length : 0);
      const first = parts[index] as Span;
      let end = first.end;
      index += 1;
      while (index < parts.length && (parts[index] as Span).end - first.start <= budget) {
        end = (parts[index] as Span).end;
        index += 1;
      }
      const body = text.slice(first.start, end);
      const chunkText = prefix ? `${prefix}${OVERLAP_SEPARATOR}${body}` : body;
      drafts.push({
        ordinal: drafts.length,
        text: chunkText,
        tokens: estimateTokens(chunkText),
        source:
          heading !== undefined
            ? `${documentName}#${heading}`
            : `${documentName}#L${lineOf(first.start)}-L${lineOf(end - 1)}`,
        headings: section.headings,
      });
      previous = chunkText;
    }
  }
  return drafts;
}
