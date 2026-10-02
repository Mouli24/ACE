import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ChunkDraft, ChunkKind, ParsedDocument, ParsedHeading } from '@ace/engine';
import { describe, expect, it } from 'vitest';

import { createChunker, estimateTokens } from '../index.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../__fixtures__/${name}`, import.meta.url)), 'utf8');

/** A minimal Markdown reader: the heading lines stay in the text, as the text-type parsers do. */
function parseMarkdown(text: string): ParsedDocument {
  const headings: ParsedHeading[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line.replace(/\r$/, ''));
    if (match)
      headings.push({ level: (match[1] as string).length, title: match[2] as string, offset });
    offset += line.length + 1;
  }
  return { text, headings };
}

interface Case {
  name: string;
  doc: ParsedDocument;
  kind: ChunkKind;
}

const cases = (): Case[] => [
  { name: 'handbook.md', doc: parseMarkdown(fixture('handbook.md')), kind: 'prose' },
  { name: 'long-notes.txt', doc: { text: fixture('long-notes.txt'), headings: [] }, kind: 'prose' },
  { name: 'service.ts', doc: { text: fixture('service.ts.txt'), headings: [] }, kind: 'code' },
];

const chunker = createChunker();
const run = (c: Case, chunkSize: number, chunkOverlap: number): ChunkDraft[] =>
  chunker.chunk({ document: c.doc, documentName: c.name, kind: c.kind, chunkSize, chunkOverlap });

describe('FR-RAG-002 estimateTokens', () => {
  it('is the ceiling of chars / 4', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('FR-RAG-002 chunk sizes', () => {
  it('no chunk exceeds chunkSize + 10 %', () => {
    for (const size of [200, 700, 2000]) {
      for (const c of cases()) {
        const chunks = run(c, size, Math.floor(size / 8));
        expect(chunks.length).toBeGreaterThan(0);
        for (const chunk of chunks) {
          expect(chunk.tokens).toBe(estimateTokens(chunk.text));
          expect(chunk.tokens).toBeGreaterThan(0);
          expect(chunk.tokens).toBeLessThanOrEqual(Math.ceil(size * 1.1));
        }
      }
    }
  });

  it('numbers chunks from 0 without gaps', () => {
    for (const c of cases()) {
      expect(run(c, 700, 90).map((d) => d.ordinal)).toEqual(run(c, 700, 90).map((_, i) => i));
    }
  });

  it('chunk count is stable', () => {
    const counts: Record<string, number> = {};
    for (const c of cases()) counts[c.name] = run(c, 700, 90).length;
    expect(counts).toEqual({ 'handbook.md': 41, 'long-notes.txt': 8, 'service.ts': 1 });
  });

  it('returns no chunks for an empty document', () => {
    expect(
      run({ name: 'e.txt', doc: { text: '  \n\n ', headings: [] }, kind: 'prose' }, 100, 10),
    ).toEqual([]);
    expect(run({ name: 'e.ts', doc: { text: '', headings: [] }, kind: 'code' }, 100, 0)).toEqual(
      [],
    );
  });
});

describe('FR-RAG-002 prose overlap', () => {
  it('overlap repeats the tail of the previous chunk', () => {
    const chunks = run(cases()[1] as Case, 200, 40);
    let repeated = 0;
    for (let i = 1; i < chunks.length; i += 1) {
      const previous = (chunks[i - 1] as ChunkDraft).text;
      const current = (chunks[i] as ChunkDraft).text;
      const overlap = current.split('\n\n')[0] as string;
      if (current.includes('\n\n') && previous.endsWith(overlap)) {
        repeated += 1;
        expect(estimateTokens(overlap)).toBeLessThanOrEqual(40);
        // a word boundary: the overlap starts at the start of a word of the previous chunk
        expect(previous.charAt(previous.length - overlap.length - 1)).toMatch(/\s/);
      }
    }
    expect(repeated).toBeGreaterThan(chunks.length / 2);
  });

  it('a zero overlap repeats nothing and chunks never cross a heading', () => {
    const doc = parseMarkdown('# A\n\nalpha one.\n\n## B\n\nbeta two.\n');
    const chunks = chunker.chunk({
      document: doc,
      documentName: 'd.md',
      kind: 'prose',
      chunkSize: 100,
      chunkOverlap: 0,
    });
    expect(chunks.map((c) => c.text)).toEqual(['# A\n\nalpha one.', '## B\n\nbeta two.']);
  });

  it('keeps going when the overlap is larger than the chunk', () => {
    const chunks = run(cases()[1] as Case, 20, 500);
    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(22);
  });
});

describe('FR-RAG-002 prose sources and headings', () => {
  it('every source resolves', () => {
    const doc = parseMarkdown(fixture('handbook.md'));
    const lines = doc.text.split('\n').length;
    for (const c of cases()) {
      for (const chunk of run(c, 700, 90)) {
        const hash = chunk.source.indexOf('#');
        expect(chunk.source.slice(0, hash)).toBe(c.name);
        const anchor = chunk.source.slice(hash + 1);
        const range = /^L(\d+)-L(\d+)$/.exec(anchor);
        if (c.kind === 'prose' && c.doc.headings.length > 0) {
          expect(c.doc.headings.map((h) => h.title)).toContain(anchor);
        } else {
          expect(range).not.toBeNull();
          const total = c.doc.text.split('\n').length;
          const a = Number(range?.[1]);
          const b = Number(range?.[2]);
          expect(a).toBeGreaterThanOrEqual(1);
          expect(b).toBeGreaterThanOrEqual(a);
          expect(b).toBeLessThanOrEqual(total);
        }
      }
    }
    expect(lines).toBeGreaterThan(100);
  });

  it('a heading path is outermost first', () => {
    const doc = parseMarkdown(
      '# Top\n\nintro.\n\n## Mid\n\nmiddle.\n\n### Low\n\nlow text.\n\n## Other\n\nother text.\n',
    );
    const chunks = chunker.chunk({
      document: doc,
      documentName: 'h.md',
      kind: 'prose',
      chunkSize: 50,
      chunkOverlap: 5,
    });
    expect(chunks.map((c) => c.headings)).toEqual([
      ['Top'],
      ['Top', 'Mid'],
      ['Top', 'Mid', 'Low'],
      ['Top', 'Other'],
    ]);
    expect(chunks[2]?.source).toBe('h.md#Low');
  });

  it('text before the first heading has no heading path and a line-range source', () => {
    const doc = parseMarkdown('preface line.\n\n# First\n\nbody.\n');
    const chunks = chunker.chunk({
      document: doc,
      documentName: 'p.md',
      kind: 'prose',
      chunkSize: 50,
      chunkOverlap: 0,
    });
    expect(chunks[0]).toMatchObject({ headings: [], source: 'p.md#L1-L1' });
    expect(chunks[1]).toMatchObject({ headings: ['First'], source: 'p.md#First' });
  });

  it('splits an oversize paragraph on sentences, then hard-splits a sentence without a stop', () => {
    const sentences =
      'One two three four five. Six seven eight nine ten. Eleven twelve thirteen fourteen.';
    const doc: ParsedDocument = { text: sentences, headings: [] };
    const bySentence = chunker.chunk({
      document: doc,
      documentName: 's.txt',
      kind: 'prose',
      chunkSize: 8,
      chunkOverlap: 0,
    });
    expect(bySentence.map((c) => c.text)).toEqual([
      'One two three four five.',
      'Six seven eight nine ten.',
      'Eleven twelve thirteen fourteen.',
    ]);
    const long = 'x'.repeat(100);
    const hard = chunker.chunk({
      document: { text: long, headings: [] },
      documentName: 'x.txt',
      kind: 'prose',
      chunkSize: 10,
      chunkOverlap: 0,
    });
    expect(hard.map((c) => c.text.length)).toEqual([40, 40, 20]);
    expect(hard.map((c) => c.source)).toEqual(['x.txt#L1-L1', 'x.txt#L1-L1', 'x.txt#L1-L1']);
  });

  it('ignores a heading whose offset is outside the text', () => {
    const doc: ParsedDocument = {
      text: 'only body.',
      headings: [{ level: 1, title: 'Ghost', offset: 99 }],
    };
    const chunks = chunker.chunk({
      document: doc,
      documentName: 'g.txt',
      kind: 'prose',
      chunkSize: 50,
      chunkOverlap: 0,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headings).toEqual([]);
  });
});

describe('FR-RAG-002 code chunks', () => {
  const declarations = [
    'createJob',
    'isRetryable',
    'backoffMs',
    'class JobQueue',
    'summarise',
    'describeJob',
  ];

  it('code splits on top-level declarations, never inside a function', () => {
    const c = cases()[2] as Case;
    const chunks = run(c, 400, 0);
    expect(chunks.length).toBeGreaterThan(1);
    const starts = /^(?:export\b|function\b|class\b|interface\b|type\b|const\b|import\b|\/\*\*)/;
    for (const chunk of chunks) {
      // a chunk begins at a declaration (or its comment, or the import preamble) in column 0
      expect(chunk.text).toMatch(starts);
    }
    // each of the small top-level functions sits whole inside one chunk
    for (const name of declarations.filter((d) => d !== 'class JobQueue')) {
      const owners = chunks.filter((ch) => ch.text.includes(name));
      expect(owners.length).toBeGreaterThan(0);
    }
    const backoff = chunks.find((ch) => ch.text.includes('function backoffMs'));
    expect(backoff?.text).toContain('return Math.min(cap');
    expect(backoff?.text).toMatch(/\}\s*$|\}\n\n/);
    // no overlap in code: the declarations of a chunk are never repeated in the next
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]?.text.startsWith(chunks[i - 1]?.text.slice(-20) ?? '')).toBe(false);
    }
  });

  it('keeps a doc comment with its declaration and has no heading path', () => {
    const chunks = run(cases()[2] as Case, 200, 90);
    const create = chunks.find((ch) => ch.text.includes('export function createJob'));
    expect(create?.text).toContain('/** Creates a job with a fresh id. */');
    expect(chunks.every((ch) => ch.headings.length === 0)).toBe(true);
  });

  it('source line ranges point at the chunk', () => {
    const c = cases()[2] as Case;
    const lines = c.doc.text.split('\n');
    for (const chunk of run(c, 100, 0)) {
      const m = /#L(\d+)-L(\d+)$/.exec(chunk.source);
      const a = Number(m?.[1]);
      const b = Number(m?.[2]);
      expect(lines.slice(a - 1, b).join('\n')).toBe(chunk.text);
    }
  });

  it('hard-splits an oversize declaration at line boundaries, and a huge line by characters', () => {
    const body = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const text = `function big() {\n${body}\n}\n\nconst z = () => 1;\n`;
    const chunks = chunker.chunk({
      document: { text, headings: [] },
      documentName: 'big.ts',
      kind: 'code',
      chunkSize: 25,
      chunkOverlap: 0,
    });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(25);
    expect(chunks.map((c) => c.text).join('\n')).toContain('const v29 = 29;');
    expect(chunks[chunks.length - 1]?.text).toMatch(/const z = \(\) => 1;$/);

    const huge = chunker.chunk({
      document: { text: `const s = '${'a'.repeat(300)}';`, headings: [] },
      documentName: 'h.ts',
      kind: 'code',
      chunkSize: 25,
      chunkOverlap: 0,
    });
    expect(huge.length).toBeGreaterThan(2);
    for (const chunk of huge) expect(chunk.tokens).toBeLessThanOrEqual(25);
  });

  it('splits Python and arrow declarations at column 0', () => {
    const text =
      'import os\n\ndef one():\n    return 1\n\ndef two():\n    return 2\n\nconst f = (a) =>\n  a;\n';
    const chunks = chunker.chunk({
      document: { text, headings: [] },
      documentName: 'a.py',
      kind: 'code',
      chunkSize: 6,
      chunkOverlap: 0,
    });
    expect(chunks.map((c) => c.text)).toEqual([
      'import os',
      'def one():\n    return 1',
      'def two():\n    return 2',
      'const f = (a) =>\n  a;',
    ]);
  });
});

describe('FR-RAG-002 CRLF text', () => {
  const lf =
    '# Title\n\nFirst paragraph of the notes\n\nSecond paragraph of the notes\n\n## Part\n\nThird paragraph is here\n\nFourth paragraph is here\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const split = (text: string): ChunkDraft[] =>
    chunker.chunk({
      document: parseMarkdown(text),
      documentName: 'n.md',
      kind: 'prose',
      chunkSize: 14,
      chunkOverlap: 0,
    });

  it('splits paragraphs on CRLF blank lines exactly as on LF', () => {
    const a = split(lf);
    const b = split(crlf);
    expect(a.length).toBeGreaterThan(3);
    expect(b.length).toBe(a.length);
    expect(b.map((c) => c.text.replace(/\r\n/g, '\n'))).toEqual(a.map((c) => c.text));
    expect(b.map((c) => c.headings)).toEqual(a.map((c) => c.headings));
  });

  it('keeps code line ranges correct in a CRLF file', () => {
    const text = fixture('service.ts.txt').replace(/\n/g, '\r\n');
    const lines = text.split('\n');
    const chunks = chunker.chunk({
      document: { text, headings: [] },
      documentName: 's.ts',
      kind: 'code',
      chunkSize: 400,
      chunkOverlap: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const m = /#L(\d+)-L(\d+)$/.exec(chunk.source);
      const range = lines.slice(Number(m?.[1]) - 1, Number(m?.[2])).join('\n');
      expect(range.trimEnd()).toBe(chunk.text);
      expect(chunk.text).toMatch(/^(?:export|import|\/\*\*|const|function)/);
    }
  });
});
