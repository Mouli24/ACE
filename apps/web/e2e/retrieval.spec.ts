import { expect, test, type Page } from '@playwright/test';

import { freshApp, nodeCard, port, serverGraph, settled } from './helpers';
import { inspect, startRun } from './round3';

/**
 * Round 5 §5 item 3 (FR-RAG-005, FR-RAG-006, FR-RAG-007; TC-RAG-006, TC-RAG-007): attach a knowledge
 * base to an agent, or put a Retrieval node on the Canvas, run, and the inspector's Sources list
 * matches what the mock engine recorded on the node run — chunk ids, scores and sources, in order.
 */

const QUESTION = 'What is the zephyrine-protocol-7?';

interface Seeded {
  projectId: string;
  workflowId: string;
  inputId: string;
  agentId: string;
  outputId: string;
  knowledgeBaseId: string;
}

/** Input → Agent (mock-cite) → Output, plus the fixture knowledge base in the same project. */
async function seed(page: Page): Promise<Seeded> {
  await freshApp(page);
  const seeded = await page.evaluate((text) => {
    const mock = window.__aceMock!;
    const run = mock.seedRunnable({ text, modelId: 'mock-cite' });
    const kb = mock.seedKnowledgeBase(run.projectId);
    return { ...run, knowledgeBaseId: kb.knowledgeBaseId };
  }, QUESTION);
  await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  return seeded;
}

/** The newest node run the mock engine holds for a node: the record the inspector must match. */
async function recordedSources(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const db = window.__aceMock!.db;
    db.load();
    const runs = db.allNodeRuns().filter((run) => run.nodeId === id);
    const last = runs[runs.length - 1];
    return (last?.sources ?? []).map((s) => ({
      chunkId: s.chunkId,
      documentId: s.documentId,
      score: s.score.toFixed(2),
      source: s.source,
    }));
  }, nodeId);
}

/** What the Sources section shows, row by row. */
async function shownSources(page: Page) {
  const section = page.getByTestId('inspector-sources');
  await expect(section).toBeVisible({ timeout: 15_000 });
  const rows = section.getByTestId('sources-list').locator('> li');
  const count = await rows.count();
  const shown: { chunkId: string; score: string; source: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    shown.push({
      chunkId: (await row.getAttribute('data-chunk-id')) ?? '',
      score: (await row.getByTestId('source-score').textContent()) ?? '',
      source: (await row.getByTestId('source-chip').getAttribute('title')) ?? '',
    });
  }
  return shown;
}

/** Keyboard connect (NFR-USE-02): Enter on an output port arms it, Enter on an input completes. */
async function keyConnect(page: Page, from: [string, string], to: [string, string]): Promise<void> {
  await port(page, from[0], 'out', from[1]).focus();
  await page.keyboard.press('Enter');
  await port(page, to[0], 'in', to[1]).focus();
  await page.keyboard.press('Enter');
}

test.describe('Retrieval and sources (FR-RAG-005/006/007)', () => {
  test('TC-RAG-006: a KB attached to an agent → run → Sources lists the chunks the node run used', async ({
    page,
  }) => {
    const seeded = await seed(page);

    // attach the base in the Agent's config (FR-RAG-005)
    await nodeCard(page, seeded.agentId).click();
    await page.getByRole('tab', { name: 'Configure' }).click();
    const field = page.getByTestId('agent-knowledge-bases');
    await field.getByLabel('Team handbook').click();
    await expect
      .poll(async () => {
        const agent = (await serverGraph(page, seeded.workflowId)).nodes.find(
          (n) => n.id === seeded.agentId,
        );
        return (agent?.config as { knowledgeBaseIds?: string[] }).knowledgeBaseIds;
      })
      .toEqual([seeded.knowledgeBaseId]);

    await startRun(page).click();
    await expect(nodeCard(page, seeded.agentId)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });

    await inspect(page, seeded.agentId);
    const recorded = await recordedSources(page, seeded.agentId);
    expect(recorded.length).toBeGreaterThan(0);
    const shown = await shownSources(page);
    expect(shown).toEqual(
      recorded.map(({ chunkId, score, source }) => ({ chunkId, score, source })),
    );

    // the rare term's chunk is first, with its text, and links to its document at that chunk
    const first = page.getByTestId(`source-${recorded[0]!.chunkId}`);
    await expect(first.getByTestId('source-text')).toContainText('zephyrine-protocol-7');
    await expect(first.getByTestId('source-link')).toHaveAttribute(
      'href',
      `/knowledge/${seeded.knowledgeBaseId}?doc=${recorded[0]!.documentId}&chunk=${recorded[0]!.chunkId}`,
    );
  });

  test('TC-RAG-007: a Retrieval node placed and configured on the Canvas → run → Sources match its hits', async ({
    page,
  }) => {
    const seeded = await seed(page);

    // place it from the palette (FR-RAG-006)
    await page.getByTestId('palette-retrieval').click();
    await settled(page, seeded.workflowId, 4);
    const retrieval = (await serverGraph(page, seeded.workflowId)).nodes.find(
      (n) => n.kind === 'retrieval',
    )!;
    await expect(nodeCard(page, retrieval.id)).toBeVisible();
    await expect(page.getByTestId(`retrieval-kb-${retrieval.id}`)).toHaveText('no knowledge base');

    // configure: base, k, mode — the panel opened on the new node
    const panel = page.getByRole('complementary', { name: 'Node configuration' });
    await expect(panel).toContainText('Retrieval node');
    await panel.getByLabel('Knowledge base').click();
    await page.getByRole('option', { name: 'Team handbook' }).click();
    const k = panel.getByLabel('Results (k)');
    await k.fill('3');
    await k.press('Enter');
    await expect
      .poll(async () => {
        const node = (await serverGraph(page, seeded.workflowId)).nodes.find(
          (n) => n.id === retrieval.id,
        );
        return node?.config;
      })
      .toEqual({ knowledgeBaseId: seeded.knowledgeBaseId, k: 3, mode: 'hybrid' });
    await expect(page.getByTestId(`retrieval-kb-${retrieval.id}`)).toHaveText('Team handbook');
    await expect(page.getByTestId(`retrieval-k-${retrieval.id}`)).toHaveText('k 3');

    // wire it: the question is its query; its json hits go to the Output
    await keyConnect(page, [seeded.inputId, 'text'], [retrieval.id, 'query']);
    await keyConnect(page, [retrieval.id, 'out'], [seeded.outputId, 'json']);
    await expect
      .poll(async () => (await serverGraph(page, seeded.workflowId)).edges.length)
      .toBe(4);

    await startRun(page).click();
    await expect(nodeCard(page, retrieval.id)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });

    await inspect(page, retrieval.id);
    const recorded = await recordedSources(page, retrieval.id);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.length).toBeLessThanOrEqual(3);
    expect(await shownSources(page)).toEqual(
      recorded.map(({ chunkId, score, source }) => ({ chunkId, score, source })),
    );
    await expect(
      page.getByTestId(`source-${recorded[0]!.chunkId}`).getByTestId('source-text'),
    ).not.toBeEmpty();
  });
});
