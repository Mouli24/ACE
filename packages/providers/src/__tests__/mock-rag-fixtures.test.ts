import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mockEmbed, mockEmbedTokens, stemToken } from '../adapters/mock-rag.js';

/**
 * The paraphrase rule (round 5 pre-flight ruling), checked mechanically: the mock embedder's
 * synonym table and the round 5 fixture corpus were written together, and this keeps them agreeing.
 *
 * - every `paraphrase` question shares no word with its expected document (so the keyword arm
 *   misses it), yet resolves through `MOCK_EMBED_CONCEPTS` to that document's concepts, and the
 *   expected document's best sentence is the nearest by `mockEmbed` cosine among every corpus
 *   sentence, or at worst in the top 3;
 * - every `exact` question names a token that is in its expected document and in no other.
 *
 * Regenerate the fixtures with `node tests/acceptance/fixtures/round-5/generate.mjs`.
 */

const ROOT = fileURLToPath(
  new URL('../../../../tests/acceptance/fixtures/round-5/', import.meta.url),
);
const CORPUS = `${ROOT}corpus/`;

interface Question {
  kind: 'exact' | 'paraphrase';
  question: string;
  expectedSource: string;
}

const questions = JSON.parse(readFileSync(`${ROOT}questions.json`, 'utf8')) as Question[];

/** The readable text of one corpus file. Binary files are read from their uncompressed text parts. */
function textOf(file: string): string {
  if (file.endsWith('.pdf')) {
    const raw = readFileSync(`${CORPUS}${file}`, 'latin1');
    return [...raw.matchAll(/\((.*)\) Tj/g)]
      .map((match) => (match[1] ?? '').replace(/\\([\\()])/g, '$1'))
      .join('\n');
  }
  if (file.endsWith('.docx')) {
    // Written as a stored (uncompressed) zip, so the document part is readable in the raw bytes.
    const raw = readFileSync(`${CORPUS}${file}`, 'latin1');
    return [...raw.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1] ?? '').join('\n');
  }
  const text = readFileSync(`${CORPUS}${file}`, 'utf8');
  if (file.endsWith('.html')) return text.replace(/<[^>]+>/g, '\n');
  return text.replace(/<!--|-->/g, '\n').replace(/^#+\s+/gm, '');
}

const FILES = readdirSync(CORPUS).filter((file) => file !== 'corrupt.pdf' && !file.startsWith('.'));
const TEXTS = new Map(FILES.map((file) => [file, textOf(file)]));

const tokensOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9-]+/g) ?? [];
/** Whole tokens and their hyphen parts, plus the stem of each: everything a keyword arm could match on. */
const keywordForms = (text: string): Set<string> => {
  const forms = new Set<string>();
  for (const token of tokensOf(text)) {
    for (const part of [token, ...token.split('-')]) {
      if (part === '') continue;
      forms.add(part);
      forms.add(stemToken(part));
    }
  }
  return forms;
};

const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => mockEmbedTokens(sentence).length > 0);

const dot = (a: number[], b: number[]): number => a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);

const ALL_SENTENCES = FILES.flatMap((file) =>
  sentencesOf(TEXTS.get(file) ?? '').map((sentence) => ({
    file,
    sentence,
    vector: mockEmbed(sentence),
  })),
);

const exact = questions.filter((q) => q.kind === 'exact');
const paraphrase = questions.filter((q) => q.kind === 'paraphrase');

describe('TC-RAG-004/005 round 5 fixture questions', () => {
  it('has at least 20 questions, half exact-term and half paraphrase, each with a corpus source', () => {
    expect(questions.length).toBeGreaterThanOrEqual(20);
    expect(exact.length).toBe(paraphrase.length);
    for (const question of questions) {
      expect(FILES, question.question).toContain(question.expectedSource);
    }
    expect(FILES).toEqual(
      expect.arrayContaining([
        'handbook.md',
        'onboarding.pdf',
        'policies.docx',
        'faq.html',
        'retry.ts',
        'notes.txt',
      ]),
    );
  });

  it('reads the binary corpus files back to their text', () => {
    expect(TEXTS.get('onboarding.pdf')).toContain('orion-lockers');
    expect(TEXTS.get('policies.docx')).toContain('gamma-ledger-17');
    expect(TEXTS.get('handbook.md')).toContain('zephyrine-protocol-7');
  });

  describe.each(exact)('exact-term: $question', ({ question, expectedSource }) => {
    it('uses a token that appears only in its expected document', () => {
      const own = keywordForms(TEXTS.get(expectedSource) ?? '');
      const others = FILES.filter((file) => file !== expectedSource).map((file) =>
        keywordForms(TEXTS.get(file) ?? ''),
      );
      const rare = tokensOf(question).filter(
        (token) =>
          own.has(token) &&
          !others.some((forms) => forms.has(token)) &&
          // Its hyphen parts are rare too, so a tokenizer that splits on '-' still finds only this file.
          token
            .split('-')
            .some((part) => own.has(part) && !others.some((forms) => forms.has(part))),
      );

      expect(rare.length, `no rare token of "${question}" in ${expectedSource}`).toBeGreaterThan(0);
    });
  });

  describe.each(paraphrase)('paraphrase: $question', ({ question, expectedSource }) => {
    it('shares no word with its expected document, so the keyword arm misses it', () => {
      const own = keywordForms(TEXTS.get(expectedSource) ?? '');
      const shared = [...keywordForms(question)].filter((form) => own.has(form));

      expect(shared).toEqual([]);
    });

    it('resolves to the concepts of its expected document, whose best sentence is the nearest', () => {
      const query = mockEmbed(question);
      const queryConcepts = new Set(mockEmbedTokens(question));
      const ranked = ALL_SENTENCES.map((entry) => ({
        ...entry,
        score: dot(query, entry.vector),
      })).sort((a, b) => b.score - a.score);
      const bestInExpected = ranked.find((entry) => entry.file === expectedSource);
      const rank = ranked.findIndex((entry) => entry === bestInExpected) + 1;
      const sharedConcepts = mockEmbedTokens(bestInExpected?.sentence ?? '').filter((concept) =>
        queryConcepts.has(concept),
      );

      expect(
        sharedConcepts.length,
        'concepts shared with the best sentence',
      ).toBeGreaterThanOrEqual(2);
      expect(rank, `rank of ${expectedSource}: "${bestInExpected?.sentence}"`).toBeLessThanOrEqual(
        3,
      );
      // The table was written for this corpus: the nearest sentence overall is the expected one.
      expect(ranked[0]?.file).toBe(expectedSource);
    });
  });

  it('corrupt.pdf has the PDF header but no cross-reference table, trailer or end marker', () => {
    const raw = readFileSync(`${CORPUS}corrupt.pdf`, 'latin1');

    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(raw).not.toContain('xref');
    expect(raw).not.toContain('%%EOF');
  });
});
