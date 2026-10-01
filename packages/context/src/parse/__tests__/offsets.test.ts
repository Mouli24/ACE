import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createDocumentParser } from '../index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url))));
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const parser = createDocumentParser();

const expectOffsets = (doc: {
  text: string;
  headings: { title: string; offset: number }[];
}): void => {
  for (const h of doc.headings) expect(doc.text.slice(h.offset).startsWith(h.title)).toBe(true);
};

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected the promise to reject');
}

function makePdf(lines: string[]): Uint8Array {
  const stream = lines
    .map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 20} Td (${line}) Tj ET`)
    .join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xr = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF\n`;
  return bytes(pdf);
}

const PARA = 'A sentence that is long enough to be treated as real article content. '.repeat(4);

describe('FR-RAG-002 heading offsets stay exact', () => {
  it('pretty-printed multi-heading HTML', async () => {
    const html = `<html><head><title>T</title></head><body><article>
      <h2>
        First Heading
      </h2>
      <p>
        ${PARA}
      </p>
      <p>line one <br> line two  </p>
      <h2>Second Heading</h2>
      <p>
        ${PARA}
      </p>
      <h3>Third  Heading</h3>
      <p>${PARA} <b>bold </b> </p>
    </article></body></html>`;
    const doc = await parser.parse({ bytes: bytes(html), mime: 'text/html', name: 'a.html' });
    expect(doc.headings.map((h) => h.title)).toEqual([
      'First Heading',
      'Second Heading',
      'Third Heading',
    ]);
    expectOffsets(doc);
    expect(doc.text).not.toMatch(/[ \t]\n/);
  });

  it('the body fallback of pretty-printed HTML keeps every offset', async () => {
    const html = `<html><body>
      <h2> One </h2>
      <p> short <br> text </p>
      <h2>Two</h2>
      <p> more </p>
    </body></html>`;
    const doc = await parser.parse({ bytes: bytes(html), mime: 'text/html', name: 'a.html' });
    expect(doc.headings.map((h) => h.title)).toEqual(['One', 'Two']);
    expectOffsets(doc);
  });

  it('every heading of every fixture', async () => {
    const files: [string, string][] = [
      ['sample.pdf', 'application/pdf'],
      ['sample.docx', ''],
      ['sample.html', 'text/html'],
      ['sample.md', 'text/markdown'],
    ];
    for (const [file, mime] of files) {
      expectOffsets(await parser.parse({ bytes: fixture(file), mime, name: file }));
    }
  });

  it('Markdown with CRLF keeps every offset', async () => {
    const md = '# One\r\n\r\ntext\r\n\r\n## Two\r\n\r\n```\r\n# no\r\n```\r\n\r\n### Three ###\r\n';
    const doc = await parser.parse({ bytes: bytes(md), mime: '', name: 'a.md' });
    expect(doc.headings.map((h) => h.title)).toEqual(['One', 'Two', 'Three']);
    expectOffsets(doc);
  });

  it('PDF numbered lines and ALL-CAPS lines are headings with exact offsets', async () => {
    const pdf = makePdf([
      'Annual Overview',
      'Some body text for the first part.',
      '1.2 Methods Used',
      'More body text follows here.',
      'RESULTS',
      'Final body text ends here.',
    ]);
    const doc = await parser.parse({ bytes: pdf, mime: 'application/pdf', name: 'a.pdf' });
    expect(doc.headings.map((h) => [h.level, h.title])).toEqual([
      [1, 'Annual Overview'],
      [2, '1.2 Methods Used'],
      [1, 'RESULTS'],
    ]);
    expectOffsets(doc);
  });
});

describe('FR-RAG-003 ParseError contract', () => {
  it('wraps a non-ParseError from a parser in a plain ParseError', async () => {
    const hostile = new Proxy(new Uint8Array([60, 112, 62]), {
      get(target, prop, receiver) {
        if (prop === 'includes') throw new TypeError('linkedom exploded at x.js:1');
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const error = await rejection(
      parser.parse({ bytes: hostile, mime: 'text/html', name: 'a.html' }),
    );
    expect(error.name).toBe('ParseError');
    expect(error.message).toBe('The HTML document could not be read.');
  });
});
