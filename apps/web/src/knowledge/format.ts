import type { KbDocumentStatus } from '@ace/contracts';

/**
 * Pure helpers for the knowledge screens: a document's short type label, a stage's share of the
 * pipeline when no frame has said, and the query terms a test-search hit is highlighted with
 * (FR-RAG-008).
 */

const TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  md: 'Markdown',
  markdown: 'Markdown',
  html: 'HTML',
  htm: 'HTML',
  txt: 'Text',
};

/** "PDF", "DOCX", "Markdown", … — by extension, then by mime, then "Code" for a source file. */
export function documentTypeLabel(name: string, mime: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  const known = TYPE_BY_EXTENSION[extension];
  if (known) return known;
  if (mime.startsWith('text/plain')) return 'Text';
  if (extension !== '') return `Code (${extension})`;
  return mime;
}

/** Where a stage sits in the pipeline, for a bar no `kb.ingest` frame has filled in yet. */
const STAGE_PROGRESS: Record<KbDocumentStatus, number> = {
  pending: 0,
  parsing: 0.1,
  chunking: 0.3,
  embedding: 0.5,
  ready: 1,
  failed: 1,
};

export function stageProgress(status: KbDocumentStatus): number {
  return STAGE_PROGRESS[status];
}

/** Words too common to be worth marking in a hit. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'was',
  'how',
  'what',
  'does',
  'each',
  'get',
  'with',
  'that',
  'this',
  'from',
  'into',
  'per',
]);

/**
 * The query's terms worth highlighting: split on whitespace, trimmed of edge punctuation (a hyphen
 * or a digit inside a term stays — `zephyrine-protocol-7` is one term), at least three characters,
 * stop words out, each once, longest first so a longer term wins an overlapping match.
 */
export function queryTerms(query: string): string[] {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  return [...new Set(terms)].sort((a, b) => b.length - a.length);
}

export interface TextSegment {
  text: string;
  match: boolean;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Cut `text` into plain and matched segments for the given terms, case-insensitively. */
export function highlightSegments(text: string, terms: readonly string[]): TextSegment[] {
  if (terms.length === 0 || text === '') return [{ text, match: false }];
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const segments: TextSegment[] = [];
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index;
    if (start > last) segments.push({ text: text.slice(last, start), match: false });
    segments.push({ text: found[0], match: true });
    last = start + found[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), match: false });
  return segments;
}
