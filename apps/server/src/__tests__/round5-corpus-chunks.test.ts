import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { chunkKindFor, createChunker, createDocumentParser, documentKind } from '@ace/context';
import { CHARS_PER_TOKEN } from '@ace/engine';
import { beforeAll, describe, expect, it } from 'vitest';

import { CORPUS, CORPUS_MIME } from './round5-harness.js';

/**
 * The chunker over the real round 5 corpus (round 5 §2.1, FR-RAG-002, Arch §12.6; moved here from
 * Task 3, because `packages/context` must not read `tests/**`). Every text-type file — Markdown,
 * plain text, code and HTML — is parsed and chunked at three sizes: no chunk may exceed its size by
 * more than 10 %, and the chunk count per file at the default 700/90 is pinned, so a chunker change
 * that moves it is a decision, not an accident.
 */

const TEXT_TYPES: ReadonlySet<string> = new Set(['markdown', 'text', 'code', 'html']);

const textFiles = readdirSync(CORPUS)
  .filter((file) => {
    const kind = documentKind({ name: file, mime: CORPUS_MIME[file] ?? '' });
    return kind !== null && TEXT_TYPES.has(kind);
  })
  .sort();

/** Size → overlap, ~13 % each, as Arch §12.6's 10–15 % asks. */
const SIZES: readonly [size: number, overlap: number][] = [
  [200, 26],
  [700, 90],
  [2000, 260],
];

const parser = createDocumentParser();
const chunker = createChunker();
const parsed = new Map<string, Awaited<ReturnType<typeof parser.parse>>>();

beforeAll(async () => {
  for (const file of textFiles) {
    const mime = CORPUS_MIME[file] ?? 'text/plain';
    parsed.set(
      file,
      await parser.parse({ bytes: readFileSync(join(CORPUS, file)), mime, name: file }),
    );
  }
});

function chunksOf(file: string, chunkSize: number, chunkOverlap: number) {
  const document = parsed.get(file);
  if (document === undefined) throw new Error(`${file} was not parsed`);
  const kind = documentKind({ name: file, mime: CORPUS_MIME[file] ?? '' }) ?? 'text';
  return chunker.chunk({
    document,
    documentName: file,
    kind: chunkKindFor(kind),
    chunkSize,
    chunkOverlap,
  });
}

describe('FR-RAG-002 chunking the round 5 corpus', () => {
  it('covers every text-type file of the corpus', () => {
    expect(textFiles).toEqual([
      'faq.html',
      'handbook.md',
      'notes.txt',
      'pii.txt',
      'poisoned.md',
      'retry.ts',
    ]);
  });

  it.each(SIZES)(
    'at chunkSize %i (overlap %i) no chunk exceeds the size by more than 10 %',
    (size, overlap) => {
      for (const file of textFiles) {
        const chunks = chunksOf(file, size, overlap);
        expect(chunks.length, file).toBeGreaterThan(0);
        for (const chunk of chunks) {
          expect(chunk.tokens, `${file} #${chunk.ordinal}`).toBe(
            Math.ceil(chunk.text.length / CHARS_PER_TOKEN),
          );
          expect(chunk.tokens, `${file} #${chunk.ordinal}`).toBeLessThanOrEqual(size * 1.1);
          expect(chunk.source.startsWith(`${file}#`), chunk.source).toBe(true);
        }
      }
    },
  );

  it('the chunk count per file at 700/90 is stable', () => {
    const counts = Object.fromEntries(
      textFiles.map((file) => [file, chunksOf(file, 700, 90).length]),
    );

    expect(counts).toEqual({
      'faq.html': 4,
      'handbook.md': 5,
      'notes.txt': 1,
      'pii.txt': 1,
      'poisoned.md': 2,
      'retry.ts': 1,
    });
  });
});
