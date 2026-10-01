import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ParseError, chunkKindFor, createDocumentParser, documentKind } from '../index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url))));
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const parser = createDocumentParser();

const SIX: { file: string; mime: string; heading: string }[] = [
  { file: 'sample.pdf', mime: 'application/pdf', heading: 'Quarterly Report' },
  {
    file: 'sample.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    heading: 'Onboarding Guide',
  },
  { file: 'sample.html', mime: 'text/html', heading: 'Deploying the Service' },
  { file: 'sample.md', mime: 'text/markdown', heading: 'Project Notes' },
];

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected the promise to reject');
}

describe('TC-RAG-002 parses each of the six types', () => {
  for (const { file, mime, heading } of SIX) {
    it(`parses ${file} with its heading and offset`, async () => {
      const doc = await parser.parse({ bytes: fixture(file), mime, name: file });
      expect(doc.text.trim().length).toBeGreaterThan(0);
      expect(doc.headings[0]?.title).toBe(heading);
      expect(doc.text.slice(doc.headings[0]?.offset).startsWith(heading)).toBe(true);
    });
  }

  it('parses plain text', async () => {
    const doc = await parser.parse({
      bytes: fixture('sample.txt'),
      mime: 'text/plain',
      name: 'sample.txt',
    });
    expect(doc.text).toContain('Plain notes about the meeting.');
    expect(doc.headings).toEqual([]);
  });

  it('parses code, which is mapped to the code chunk kind', async () => {
    const doc = await parser.parse({
      bytes: fixture('sample.ts'),
      mime: 'application/octet-stream',
      name: 'sample.ts',
    });
    expect(doc.text).toContain('export function add');
    expect(documentKind({ mime: 'application/octet-stream', name: 'sample.ts' })).toBe('code');
    expect(chunkKindFor('code')).toBe('code');
    expect(chunkKindFor('pdf')).toBe('prose');
    expect(chunkKindFor('markdown')).toBe('prose');
  });
});

describe('documentKind', () => {
  it('classifies by extension and mime', () => {
    expect(documentKind({ mime: 'application/pdf', name: 'a' })).toBe('pdf');
    expect(documentKind({ mime: '', name: 'A.PDF' })).toBe('pdf');
    expect(documentKind({ mime: '', name: 'a.docx' })).toBe('docx');
    expect(documentKind({ mime: 'text/html; charset=utf-8', name: 'a' })).toBe('html');
    expect(documentKind({ mime: '', name: 'a.htm' })).toBe('html');
    expect(documentKind({ mime: 'text/markdown', name: 'a' })).toBe('markdown');
    expect(documentKind({ mime: '', name: 'a.md' })).toBe('markdown');
    expect(documentKind({ mime: 'text/plain', name: 'a' })).toBe('text');
    expect(documentKind({ mime: '', name: 'a.csv' })).toBe('text');
    expect(documentKind({ mime: '', name: 'a.json' })).toBe('text');
    expect(documentKind({ mime: 'text/plain', name: 'run.py' })).toBe('code');
    for (const ext of [
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
    ]) {
      expect(documentKind({ mime: '', name: `x.${ext}` })).toBe('code');
    }
    expect(documentKind({ mime: 'image/png', name: 'a.png' })).toBeNull();
    expect(documentKind({ mime: '', name: 'noextension' })).toBeNull();
  });
});

describe('TC-RAG-003 a corrupt PDF throws ParseError with a human reason', () => {
  it('names the file as damaged and carries no stack', async () => {
    const corrupt = bytes('%PDF-1.7\n\u0000\u0001garbage that is not a pdf at all');
    const error = await rejection(
      parser.parse({ bytes: corrupt, mime: 'application/pdf', name: 'bad.pdf' }),
    );
    expect(error.name).toBe('ParseError');
    expect(error).toBeInstanceOf(ParseError);
    expect(error.message).toMatch(/damaged|could not be read/i);
    expect(error.message).not.toMatch(/\bat\s.+\(|\.js:\d+|\n/);
  });

  it('a DOCX that is not a zip throws ParseError', async () => {
    const error = await rejection(
      parser.parse({ bytes: bytes('not a zip'), mime: '', name: 'bad.docx' }),
    );
    expect(error.name).toBe('ParseError');
    expect(error.message).toMatch(/damaged|could not be read/i);
  });

  it('a text file with binary content throws ParseError', async () => {
    const error = await rejection(
      parser.parse({
        bytes: new Uint8Array([104, 105, 0, 0, 1, 2]),
        mime: 'text/plain',
        name: 'a.txt',
      }),
    );
    expect(error.name).toBe('ParseError');
  });
});

describe('FR-RAG-002 HTML', () => {
  it('keeps the article and drops script/style/nav; h2 is level 2', async () => {
    const doc = await parser.parse({
      bytes: fixture('sample.html'),
      mime: 'text/html',
      name: 'sample.html',
    });
    expect(doc.text).toContain('Deployment starts with a build');
    expect(doc.text).not.toContain('tracking');
    expect(doc.text).not.toContain('color:red');
    expect(doc.text).not.toContain('Menu');
    expect(doc.headings.map((h) => [h.level, h.title])).toEqual([
      [2, 'Deploying the Service'],
      [3, 'Rollback'],
    ]);
    for (const h of doc.headings) expect(doc.text.slice(h.offset).startsWith(h.title)).toBe(true);
  });

  it('keeps the level of an h1 even though the article extraction renames it', async () => {
    const html = `<html><head><title>T</title></head><body><nav>links</nav><article><h1>Main Heading</h1><p>${'Body sentence that keeps going. '.repeat(20)}</p></article></body></html>`;
    const doc = await parser.parse({ bytes: bytes(html), mime: 'text/html', name: 'a.html' });
    expect(doc.headings[0]).toMatchObject({ level: 1, title: 'Main Heading' });
  });

  it('falls back to the body when there is no article, dropping nav and scripts', async () => {
    const html =
      '<html><body><nav>Menu</nav><h2>Tiny</h2><p>Short text.</p><ul><li>one</li><li>two</li></ul><script>x()</script></body></html>';
    const doc = await parser.parse({ bytes: bytes(html), mime: 'text/html', name: 'a.html' });
    expect(doc.text).toContain('Short text.');
    expect(doc.text).toContain('one');
    expect(doc.text).not.toContain('Menu');
    expect(doc.text).not.toContain('x()');
    expect(doc.headings).toEqual([{ level: 2, title: 'Tiny', offset: doc.text.indexOf('Tiny') }]);
  });
});

describe('FR-RAG-002 Markdown', () => {
  it('takes headings from # lines, not from # inside code fences', async () => {
    const doc = await parser.parse({
      bytes: fixture('sample.md'),
      mime: 'text/markdown',
      name: 'sample.md',
    });
    expect(doc.headings.map((h) => [h.level, h.title])).toEqual([
      [1, 'Project Notes'],
      [2, 'Next Steps'],
    ]);
    expect(doc.text).toContain('# not a heading');
  });

  it('handles ~~~ fences, closing hashes and CRLF', async () => {
    const md = '## Closed ##\r\n\r\n~~~\r\n# nope\r\n~~~\r\n\r\n####### seven\r\n';
    const doc = await parser.parse({ bytes: bytes(md), mime: '', name: 'a.md' });
    expect(doc.headings.map((h) => h.title)).toEqual(['Closed']);
  });
});

describe('FR-RAG-003 failures', () => {
  it('refuses an empty document', async () => {
    const error = await rejection(
      parser.parse({ bytes: bytes('  \n\t '), mime: 'text/plain', name: 'a.txt' }),
    );
    expect(error.name).toBe('ParseError');
    expect(error.message).toBe('The document has no text to index.');
  });

  it('an unsupported type throws ParseError naming the type', async () => {
    const error = await rejection(
      parser.parse({ bytes: bytes('x'), mime: 'image/png', name: 'a.png' }),
    );
    expect(error.name).toBe('ParseError');
    expect(error.message).toContain('image/png');
  });

  it('names the extension when there is no mime', async () => {
    const error = await rejection(parser.parse({ bytes: bytes('x'), mime: '', name: 'a.xyz' }));
    expect(error.message).toContain('.xyz');
  });
});

describe('FR-RAG-002 PDF headings', () => {
  it('recognises numbered headings and short capitalised lines', async () => {
    const pdf = fixture('sample.pdf');
    const doc = await parser.parse({ bytes: pdf, mime: 'application/pdf', name: 'a.pdf' });
    expect(doc.headings[0]).toMatchObject({ level: 1, title: 'Quarterly Report' });
  });
});
