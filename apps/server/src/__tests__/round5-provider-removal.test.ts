import { ApiErrorSchema } from '@ace/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PLACEHOLDER,
  createKb,
  createProject,
  fixtureWorkflow,
  importWorkflow,
  mockProvider,
  runToEnd,
  startRound5Engine,
  type Round5Engine,
} from './round5-harness.js';

/**
 * Final-review I5 (FR-PRV-005): a knowledge base embeds with a provider it can never change, so
 * removing that provider needs `?confirm=true` like removing one a node names, and a run on a node
 * attached to the base is BLOCKED at pre-flight rather than failing mid-run in the vector search.
 */

let e: Round5Engine;

beforeAll(async () => {
  e = await startRound5Engine();
}, 60_000);

afterAll(async () => {
  await e?.stop();
});

describe('FR-PRV-005 removing a provider a knowledge base embeds with', () => {
  it('is refused without confirm, naming the base; with confirm it goes, and an attached agent is BLOCKED at pre-flight', async () => {
    const agents = await mockProvider(e, { name: 'Agents' });
    const embedder = await mockProvider(e, { name: 'Embedder' });
    const project = await createProject(e, 'Removal');
    const kb = await createKb(e, project, embedder, { name: 'Handbook base' });
    const graph = await importWorkflow(
      e,
      project,
      fixtureWorkflow('rag-qa.json', {
        [PLACEHOLDER.provider]: agents,
        [PLACEHOLDER.knowledgeBase]: kb.id,
      }),
    );
    const agent = graph.nodes.find((node) => node.kind === 'agent');
    if (agent === undefined) throw new Error('no agent');

    const refused = await e.api(`/providers/${embedder}`, { method: 'DELETE' });
    expect(refused.status).toBe(409);
    const { error } = ApiErrorSchema.parse(await refused.json());
    expect(error.code).toBe('provider_in_use');
    expect(error.details).toEqual({ nodeIds: [agent.id] });
    expect(error.message).toContain('"Handbook base"');

    const removed = await e.api(`/providers/${embedder}?confirm=true`, { method: 'DELETE' });
    expect(removed.status).toBe(204);

    const run = await runToEnd(e, graph.workflow.id);
    expect(run.status).toBe('BLOCKED');
    expect(run.preflightIssues).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'provider_missing', nodeId: agent.id }),
    );
    expect(e.mock.calls().length).toBe(0);
  }, 60_000);
});
