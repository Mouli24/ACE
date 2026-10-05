import { join } from 'node:path';

import { openDatabase } from '@ace/storage-local';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PLACEHOLDER,
  createProject,
  fixtureWorkflow,
  importWorkflow,
  mockProvider,
  runToEnd,
  startRound5Engine,
  type Round5Engine,
} from './round5-harness.js';

/**
 * The engine's injected clock reaches the summary cache too (13b review m6, FR-RAG-010): a cache
 * entry is stamped, and its 30-day TTL measured, by `startEngine({ clock })` — the same clock the
 * artifact store sweeps by — so a test can move time for both, and they never disagree.
 */

const CLOCK = '2026-01-15T08:00:00.000Z';
let e: Round5Engine;

beforeAll(async () => {
  e = await startRound5Engine({ clock: () => CLOCK });
}, 60_000);

afterAll(async () => {
  await e?.stop();
});

describe('FR-RAG-010 the summary cache keeps the engine clock', () => {
  it('a summary.json run stamps its cache row with the injected time', async () => {
    const providerId = await mockProvider(e);
    const projectId = await createProject(e, 'Clock');
    const graph = await importWorkflow(
      e,
      projectId,
      fixtureWorkflow('summary.json', { [PLACEHOLDER.provider]: providerId }),
    );

    expect((await runToEnd(e, graph.workflow.id)).status).toBe('COMPLETE');

    const { sqlite } = openDatabase({
      path: join(e.dir, 'ace.sqlite'),
      loadVectorExtension: false,
    });
    try {
      const rows = sqlite
        .prepare('SELECT created_at AS createdAt, last_used_at AS lastUsedAt FROM summary_cache')
        .all() as { createdAt: string; lastUsedAt: string }[];
      expect(rows).toEqual([{ createdAt: CLOCK, lastUsedAt: CLOCK }]);
    } finally {
      sqlite.close();
    }
  }, 60_000);
});
