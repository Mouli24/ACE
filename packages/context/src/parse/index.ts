import type { ChunkKind, DocumentParser, ParsedDocument } from '@ace/engine';

import { parseCode } from './code.js';
import { parseDocx } from './docx.js';
import { EMPTY_DOCUMENT_MESSAGE, ParseError } from './errors.js';
import { parseHtml } from './html.js';
import { parseMarkdown } from './markdown.js';
import { parsePdf } from './pdf.js';
import { parseText } from './text.js';

export { ParseError } from './errors.js';

export type DocumentKind = 'pdf' | 'docx' | 'html' | 'markdown' | 'text' | 'code';

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'css',
  'java',
  'go',
  'rs',
  'c',
  'h',
  'cpp',
  'cs',
  'rb',
  'php',
  'sh',
]);
const EXTENSION_KINDS: Readonly<Record<string, DocumentKind>> = {
  pdf: 'pdf',
  docx: 'docx',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  csv: 'text',
  json: 'text',
};
const MIME_KINDS: Readonly<Record<string, DocumentKind>> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/plain': 'text',
  'text/csv': 'text',
  'application/json': 'text',
};

const KIND_LABELS: Readonly<Record<DocumentKind, string>> = {
  pdf: 'PDF',
  docx: 'Word',
  html: 'HTML',
  markdown: 'Markdown',
  text: 'text',
  code: 'code',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The kind of a document from its name (checked first, since uploads often say `text/plain`) and its mime. */
export function documentKind(input: { mime: string; name: string }): DocumentKind | null {
  const extension = extensionOf(input.name);
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  const byExtension = EXTENSION_KINDS[extension];
  if (byExtension !== undefined) return byExtension;
  const mime = input.mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_KINDS[mime] ?? null;
}

/** Code is chunked on its own structure; every other kind is prose. */
export function chunkKindFor(kind: DocumentKind): ChunkKind {
  return kind === 'code' ? 'code' : 'prose';
}

async function parseKind(kind: DocumentKind, bytes: Uint8Array): Promise<ParsedDocument> {
  switch (kind) {
    case 'pdf':
      return parsePdf(bytes);
    case 'docx':
      return parseDocx(bytes);
    case 'html':
      return parseHtml(bytes);
    case 'markdown':
      return parseMarkdown(bytes);
    case 'text':
      return parseText(bytes);
    case 'code':
      return parseCode(bytes);
  }
}

function describeType(mime: string, name: string): string {
  if (mime.trim() !== '') return mime.trim();
  const extension = extensionOf(name);
  return extension !== '' ? `.${extension}` : 'unknown';
}

export function createDocumentParser(): DocumentParser {
  return {
    async parse({ bytes, mime, name }) {
      const kind = documentKind({ mime, name });
      if (kind === null) {
        throw new ParseError(`The file type ${describeType(mime, name)} is not supported.`);
      }
      let parsed: ParsedDocument;
      try {
        parsed = await parseKind(kind, bytes);
      } catch (error) {
        if (error instanceof ParseError) throw error;
        // A library's own text is never shown to the user (FR-RAG-003).
        throw new ParseError(`The ${KIND_LABELS[kind]} document could not be read.`);
      }
      if (parsed.text.trim() === '') throw new ParseError(EMPTY_DOCUMENT_MESSAGE);
      return parsed;
    },
  };
}
