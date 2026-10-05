import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SearchResponseSchema } from '@ace/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CORPUS,
  QUESTIONS,
  addCorpusFile,
  createKb,
  createProject,
  mockProvider,
  settledDocuments,
  startRound5Engine,
  type Round5Engine,
} from './round5-harness.js';

/**
 * TC-RAG-010: retrieval quality over the labelled question set (round 5 §4, OI-02). The whole corpus
 * is ingested on the mock embedder, every question of `questions.json` is asked through
 * `POST /knowledge-bases/:id/query` (hybrid, k = 5), and a question is a hit when a chunk of its
 * expected document is among the five. The figure is printed and written to
 * `test-results/round5-hit-rate.json` for the report.
 *
 * DN-1: OI-02 sets no target, so the measured value is a regression floor — a change that loses a
 * question fails here, and one that gains a question raises the floor in the same commit.
 */

/** Measured on the mock embedder (Task 13b): 24 of 24 questions. */
const HIT_RATE_FLOOR = 1;

const K = 5;
const RESULTS = fileURLToPath(new URL('../../test-results/', import.meta.url));

let e: Round5Engine;

beforeAll(async () => {
  e = await startRound5Engine();
}, 60_000);

afterAll(async () => {
  await e?.stop();
});

describe('TC-RAG-010 hit-rate@5 over the labelled questions', () => {
  it('is at or above the recorded floor', async () => {
    const providerId = await mockProvider(e);
    const projectId = await createProject(e, 'RAG quality');
    const kb = await createKb(e, projectId, providerId, { name: 'Corpus' });
    const files = readdirSync(CORPUS)
      .filter((file) => !file.startsWith('.'))
      .sort();
    for (const file of files) await addCorpusFile(e, kb.id, file);
    const docs = await settledDocuments(e, kb.id, files.length);
    const idOf = new Map(docs.map((doc) => [doc.name, doc.id]));

    const results: { question: string; kind: string; expected: string; hit: boolean }[] = [];
    for (const question of QUESTIONS) {
      const { hits } = SearchResponseSchema.parse(
        await e.post(`/knowledge-bases/${kb.id}/query`, { query: question.question, k: K }),
      );
      const expected = idOf.get(question.expectedSource);
      results.push({
        question: question.question,
        kind: question.kind,
        expected: question.expectedSource,
        hit: hits.slice(0, K).some((hit) => hit.documentId === expected),
      });
    }
    const hits = results.filter((result) => result.hit).length;
    const hitRate = hits / results.length;
    const byKind = (kind: string) => {
      const ofKind = results.filter((result) => result.kind === kind);
      return ofKind.filter((result) => result.hit).length / ofKind.length;
    };

    // The figure goes in the report (round 5 §4, DN-1): printing it is this test's job.
    // eslint-disable-next-line no-console
    console.log(
      `TC-RAG-010 hit-rate@${K}: ${hitRate.toFixed(3)} (${hits}/${results.length}; exact ${byKind('exact').toFixed(3)}, paraphrase ${byKind('paraphrase').toFixed(3)})`,
    );
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(
      `${RESULTS}round5-hit-rate.json`,
      `${JSON.stringify(
        {
          k: K,
          hitRate,
          hits,
          questions: results.length,
          exact: byKind('exact'),
          paraphrase: byKind('paraphrase'),
          floor: HIT_RATE_FLOOR,
          misses: results.filter((result) => !result.hit),
        },
        null,
        2,
      )}\n`,
    );

    expect(docs.filter((doc) => doc.status === 'failed').map((doc) => doc.name)).toEqual([
      'corrupt.pdf',
    ]);
    expect(results).toHaveLength(QUESTIONS.length);
    expect(hitRate).toBeGreaterThanOrEqual(HIT_RATE_FLOOR);
  }, 120_000);
});
