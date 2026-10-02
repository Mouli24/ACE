import { expect, test, type Page } from '@playwright/test';

import { freshApp, nodeCard, serverGraph } from './helpers';
import { inspect, startRun } from './round3';

/**
 * Round 5 §5 item 4 (FR-MEM-001, FR-MEM-004; TC-MEM-002): turn memory on for a `mock-memory` agent,
 * run it twice — the second run's prompt carries the fact the first one saved — see the fact in the
 * Memory tab, delete it, and the next run starts with no memory.
 */

/**
 * Input → Agent (mock-memory) → Output. The catalogue declares mock-memory text → text (its json
 * output is left off the declared types, see catalog.ts), so the agent keeps its default types.
 */
async function seed(page: Page) {
  await freshApp(page);
  const seeded = await page.evaluate(() =>
    window.__aceMock!.seedRunnable({
      text: 'Ada is my name',
      modelId: 'mock-memory',
    }),
  );
  await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  return seeded;
}

/** Start a run and wait for the agent to finish it. */
async function runOnce(page: Page, agentId: string, runsBefore: number) {
  await startRun(page).click();
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const db = window.__aceMock!.db;
          db.load();
          return db.allNodeRuns().filter((r) => r.nodeId === id && r.status === 'COMPLETED').length;
        }, agentId),
      { timeout: 20_000 },
    )
    .toBe(runsBefore + 1);
  await expect(nodeCard(page, agentId)).toHaveAttribute('data-state', 'COMPLETED');
}

/** The newest node run's prompt and memory context, as the engine recorded them. */
async function lastRun(page: Page, agentId: string) {
  return page.evaluate((id) => {
    const db = window.__aceMock!.db;
    db.load();
    const runs = db.allNodeRuns().filter((r) => r.nodeId === id);
    const last = runs[runs.length - 1]!;
    return {
      prompt: last.prompt?.text ?? '',
      memory: last.inputEnvelopes[0]?.context.memory ?? [],
    };
  }, agentId);
}

test.describe('Agent memory (FR-MEM-001, FR-MEM-004)', () => {
  test('TC-MEM-002: run twice → Memory tab shows user_name → delete → next run has no memory', async ({
    page,
  }) => {
    const seeded = await seed(page);

    // FR-MEM-001: the toggle in the Agent's config
    await nodeCard(page, seeded.agentId).click();
    await page.getByRole('tab', { name: 'Configure' }).click();
    await page.getByLabel('Remember facts between runs').click();
    await expect
      .poll(async () => {
        const agent = (await serverGraph(page, seeded.workflowId)).nodes.find(
          (n) => n.id === seeded.agentId,
        );
        return (agent?.config as { memory?: { enabled: boolean } }).memory;
      })
      .toEqual({ enabled: true });

    // the Memory tab, open while the runs happen, follows memory.updated live
    await page.getByRole('tab', { name: 'Memory' }).click();
    const tab = page.getByTestId('memory-tab');
    await expect(tab.getByTestId('memory-empty')).toBeVisible();

    await runOnce(page, seeded.agentId, 0);
    const row = tab.getByTestId('memory-entry-user_name');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByTestId('memory-value')).toHaveText('Ada');

    await runOnce(page, seeded.agentId, 1);
    const second = await lastRun(page, seeded.agentId);
    expect(second.memory).toEqual([{ key: 'user_name', value: 'Ada' }]);
    expect(second.prompt).toContain('user_name: Ada');

    // the second run's prompt, in the inspector, shows the remembered fact
    await inspect(page, seeded.agentId);
    await expect(page.getByTestId('inspector-output')).toContainText('Welcome back, Ada');
    await page.getByRole('button', { name: 'View prompt' }).click();
    await expect(page.getByTestId('prompt-text')).toContainText('user_name: Ada');
    await page.keyboard.press('Escape');

    // delete it, with confirmation
    await page.getByRole('tab', { name: 'Memory' }).click();
    await tab.getByTestId('memory-delete-user_name').click();
    await page.getByTestId('memory-confirm-delete').click();
    await expect(tab.getByTestId('memory-empty')).toBeVisible();
    expect(
      await page.evaluate((id) => {
        const db = window.__aceMock!.db;
        db.load();
        return db.memoryOf(id).length;
      }, seeded.agentId),
    ).toBe(0);

    // the next run starts with no memory: nothing in its envelope or its prompt
    await runOnce(page, seeded.agentId, 2);
    const third = await lastRun(page, seeded.agentId);
    expect(third.memory).toEqual([]);
    expect(third.prompt).not.toContain('user_name:');
    await inspect(page, seeded.agentId);
    await expect(page.getByTestId('inspector-output')).toContainText('Nice to meet you, Ada');
  });

  test('FR-MEM-004: clear all asks first and empties the list', async ({ page }) => {
    const seeded = await seed(page);
    await page.evaluate(
      (id) =>
        window.__aceMock!.seedMemory(id, [
          { key: 'user_name', value: 'Ada' },
          { key: 'city', value: 'Lyon' },
        ]),
      seeded.agentId,
    );
    await nodeCard(page, seeded.agentId).click();
    await page.getByRole('tab', { name: 'Memory' }).click();
    const tab = page.getByTestId('memory-tab');
    await expect(tab.getByTestId('memory-entry-city')).toBeVisible();
    // memory is off for this agent: the tab says so but still lists what it kept
    await expect(tab.getByTestId('memory-disabled')).toBeVisible();

    await tab.getByTestId('memory-clear-all').click();
    await expect(page.getByTestId('memory-confirm')).toContainText('Clear all memory?');
    await page.getByTestId('memory-confirm-delete').click();
    await expect(tab.getByTestId('memory-empty')).toBeVisible();
  });
});
