import {
  InstantiateTemplateResponseSchema,
  ProviderSchema,
  TEMPLATE_IDS,
  TemplateSchema,
  type InstantiateTemplateResponse,
  type TemplateId,
} from '@ace/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createProject,
  nodeRunsOf,
  runToEnd,
  settledDocuments,
  startRound5Engine,
  type Round5Engine,
} from './round5-harness.js';

/**
 * TC-ONB-002, engine half (FR-ONB-002, round 5 §2.7, F11): each of the four templates instantiates
 * through the API on an engine that has no provider at all — the first instantiation creates the
 * `Mock` provider, the rest reuse it — and runs to COMPLETE with no key and no setup. The review-fix
 * loop ends on its exit condition (the Reviewer approves), not on its maximum.
 */

let e: Round5Engine;

beforeAll(async () => {
  e = await startRound5Engine();
}, 60_000);

afterAll(async () => {
  await e?.stop();
});

async function instantiate(
  id: TemplateId,
  body: Record<string, unknown>,
): Promise<InstantiateTemplateResponse> {
  const response = await e.api(`/templates/${id}/instantiate`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return InstantiateTemplateResponseSchema.parse(await response.json());
}

describe('TC-ONB-002 every template instantiates and runs on the mock provider', () => {
  it('GET /templates lists the four, in wizard order', async () => {
    const templates = TemplateSchema.array().parse(await e.get('/templates'));
    expect(templates.map((template) => template.id)).toEqual([...TEMPLATE_IDS]);
    expect(templates.find((template) => template.id === 'rag-qa')?.requires).toEqual({
      knowledgeBase: true,
    });
  });

  it.each(TEMPLATE_IDS)(
    '%s reaches COMPLETE',
    async (id) => {
      const created = await instantiate(id, { projectName: `Template ${id}` });
      expect(created.project.name).toBe(`Template ${id}`);
      expect(created.workflow.projectId).toBe(created.project.id);
      expect(created.nodes.length).toBeGreaterThan(0);

      if (id === 'rag-qa') {
        // The seeded sample document is ingested before the run reads it.
        expect(created.knowledgeBaseId).toBeDefined();
        const [doc] = await settledDocuments(e, created.knowledgeBaseId ?? '', 1);
        expect(doc?.status).toBe('ready');
      } else {
        expect(created.knowledgeBaseId).toBeUndefined();
      }

      const run = await runToEnd(e, created.workflow.id);

      expect(run.status, JSON.stringify(run.preflightIssues)).toBe('COMPLETE');
      const rows = await nodeRunsOf(e, run.id);

      if (id === 'review-fix') {
        const reviewer = created.nodes.find((node) => node.name === 'Reviewer');
        const reviews = rows
          .filter((row) => row.nodeId === reviewer?.id && row.status === 'COMPLETED')
          .sort((x, y) => x.iteration - y.iteration);
        const last = reviews.at(-1);
        expect(
          (last?.output?.[0] as { value?: { verdict?: string } } | undefined)?.value?.verdict,
        ).toBe('approved');
        expect(rows.some((row) => row.loopStop === 'exit_condition')).toBe(true);
        expect(rows.some((row) => row.loopStop === 'max_iterations')).toBe(false);
      }

      if (id === 'rag-qa') {
        const answerer = created.nodes.find((node) => node.name === 'Answerer');
        const answer = rows.find((row) => row.nodeId === answerer?.id);
        expect(answer?.sources?.length).toBeGreaterThan(0);
      }
    },
    60_000,
  );

  it('F11 the first instantiation created exactly one Mock provider, which the rest reused', async () => {
    const { items } = (await e.get('/providers')) as { items: unknown[] };
    const providers = items.map((item) => ProviderSchema.parse(item));
    expect(providers.map((provider) => [provider.type, provider.name])).toEqual([['mock', 'Mock']]);
  });

  it('puts the workflow in an existing project when given its id, and creates no other', async () => {
    const projectId = await createProject(e, 'Existing');
    const { items: before } = (await e.get('/projects')) as { items: unknown[] };

    const created = await instantiate('linear-chain', { projectId });

    expect(created.project.id).toBe(projectId);
    expect(created.workflow.projectId).toBe(projectId);
    const { items: after } = (await e.get('/projects')) as { items: unknown[] };
    expect(after).toHaveLength(before.length);
  });
});
