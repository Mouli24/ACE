import { afterEach, describe, expect, it } from 'vitest';

import {
  addCorpusFile,
  createKb,
  createProject,
  listDocuments,
  mockProvider,
  startRound5Engine,
  until,
  type Round5Engine,
} from './round5-harness.js';

/**
 * Final-review C1: round 4's artifact retention sweep (Arch §15.4, unreferenced + 7 days) and
 * round 5's knowledge-base documents. A document's uploaded file is its source: the sweep must
 * keep it however old it is, so a reindex (FR-RAG-009) can still read it and the base keeps its
 * content.
 */

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let e: Round5Engine | undefined;

afterEach(async () => {
  await e?.stop();
  e = undefined;
});

describe('FR-RAG-009 a knowledge-base document keeps its source file past the 7-day sweep', () => {
  it('survives sweepArtifacts() eight days on, and a reindex brings it back to ready with chunks', async () => {
    let at = T0;
    e = await startRound5Engine({ clock: () => new Date(at).toISOString() });
    const engine = e;
    const provider = await mockProvider(engine);
    const project = await createProject(engine, 'Retention');
    const kb = await createKb(engine, project, provider, { name: 'Handbook' });
    const added = await addCorpusFile(engine, kb.id, 'handbook.md');
    const ready = await until('the document to be ready', async () => {
      const [doc] = await listDocuments(engine, kb.id);
      return doc?.status === 'ready' ? doc : undefined;
    });
    expect(ready.chunkCount).toBeGreaterThan(0);

    at += 8 * DAY;
    const swept = await engine.engine.sweepArtifacts();

    expect(swept.map((artifact) => artifact.id)).not.toContain(added.artifactId);
    expect((await engine.api(`/artifacts/${added.artifactId}/content`)).status).toBe(200);

    await engine.post(`/knowledge-bases/${kb.id}/reindex`);
    const reindexed = await until('the reindexed document to settle', async () => {
      const [doc] = await listDocuments(engine, kb.id);
      return doc?.status === 'ready' || doc?.status === 'failed' ? doc : undefined;
    });
    expect(reindexed).toMatchObject({ status: 'ready', chunkCount: ready.chunkCount });
  }, 60_000);
});
