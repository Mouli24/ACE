import { join } from 'node:path';

import { SearchResponseSchema, type SearchHit } from '@ace/contracts';
import { openDatabase } from '@ace/storage-local';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PLACEHOLDER,
  addFile,
  createKb,
  createProject,
  fixtureWorkflow,
  importWorkflow,
  mockProvider,
  nodeRunOf,
  runToEnd,
  settledDocuments,
  startRound5Engine,
  type Round5Engine,
} from './round5-harness.js';

/**
 * Final-review I3 (BR-07, D86): a document's text is secret-masked before it is chunked, so a
 * key-shaped token in an uploaded file is never stored in a chunk or the keyword index, never
 * answered by `/query`, and never stops a Retrieval node whose hit would have carried it.
 */

// Assembled at runtime: a key-shaped literal in a repository file is what CLAUDE.md §2 forbids.
const TAIL = 'A1b2C3d4'.repeat(5);
const KEY = ['ghp', TAIL].join('_');
const TEXT = `The deploy token is ${KEY} so keep it safe.\n\nDeploys run from the main branch.`;

let e: Round5Engine;
let kbId: string;
let projectId: string;
let providerId: string;

beforeAll(async () => {
  e = await startRound5Engine();
  providerId = await mockProvider(e);
  projectId = await createProject(e, 'Secrets');
  kbId = (await createKb(e, projectId, providerId, { name: 'Deploys' })).id;
  await addFile(e, kbId, 'deploy.md', new TextEncoder().encode(TEXT), 'text/markdown');
}, 60_000);

afterAll(async () => {
  await e?.stop();
});

describe('BR-07 a key-shaped token in a document is masked before it is stored', () => {
  it('the document is ready, and no chunk, keyword row or query hit holds the key', async () => {
    const [doc] = await settledDocuments(e, kbId, 1);
    expect(doc?.status, doc?.error).toBe('ready');
    expect(doc?.verdicts?.map((verdict) => [verdict.point, verdict.checkType])).toContainEqual([
      'data',
      'secret_leak',
    ]);

    const { sqlite } = openDatabase({
      path: join(e.dir, 'ace.sqlite'),
      loadVectorExtension: false,
    });
    try {
      const texts = (sqlite.prepare('SELECT text FROM kb_chunks').all() as { text: string }[]).map(
        (row) => row.text,
      );
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.join('\n')).not.toContain(TAIL);
      expect(texts.join('\n')).toContain('The deploy token is [github_token redacted]');
      const indexed = sqlite
        .prepare('SELECT count(*) AS n FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?')
        .get(`"${TAIL.toLowerCase()}"`) as { n: number };
      expect(indexed.n).toBe(0);
    } finally {
      sqlite.close();
    }

    const response = SearchResponseSchema.parse(
      await e.post(`/knowledge-bases/${kbId}/query`, { query: 'deploy token', k: 5 }),
    );
    expect(response.hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(response)).not.toContain(TAIL);
  }, 60_000);

  it('a Retrieval node over the document completes, its hits masked', async () => {
    await settledDocuments(e, kbId, 1);
    const graph = await importWorkflow(
      e,
      projectId,
      fixtureWorkflow('retrieval-node.json', {
        [PLACEHOLDER.knowledgeBase]: kbId,
        'zephyrine-protocol-7': 'deploy token',
      }),
    );
    const retrieval = graph.nodes.find((node) => node.kind === 'retrieval');
    if (retrieval === undefined) throw new Error('no retrieval node');

    const run = await runToEnd(e, graph.workflow.id);

    expect(run.status).toBe('COMPLETE');
    const row = await nodeRunOf(e, run.id, retrieval.id);
    const hits = (row.output?.[0] as { value: { hits: SearchHit[] } }).value.hits;
    expect(hits.some((hit) => hit.text.includes('[github_token redacted]'))).toBe(true);
    expect(JSON.stringify(row)).not.toContain(TAIL);
  }, 60_000);
});
