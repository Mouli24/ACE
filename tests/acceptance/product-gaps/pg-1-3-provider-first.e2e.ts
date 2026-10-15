import { test, type Page } from '@playwright/test';

import {
  NOT_BUILT,
  api,
  card,
  expect,
  graphOf,
  mockProvider,
  openCanvas,
  seedAgents,
  seedEmptyWorkflow,
  settledRun,
  startRunFromMenu,
  type Seeded,
} from './helpers.js';

/**
 * PG-1.3 No node without a provider (product-gaps prompt, Phase 1; D351, D358). Today "Add node"
 * creates an Agent at once with the first CONNECTED provider (`canvas/graph-plans.ts` planNewStage)
 * and pre-flight names a providerless node `missing_model` / `provider_missing`, not
 * `missing_provider`. Red until PG-1.3 lands.
 */

/** The provider-first picker the Add node flow opens before anything is created. */
const picker = (page: Page) => page.getByRole('dialog', { name: /provider/i });

async function emptyCanvas(
  page: Page,
  label: string,
): Promise<{ projectId: string; workflowId: string }> {
  await mockProvider();
  const seeded = await seedEmptyWorkflow(label);
  await openCanvas(page, seeded.projectId, seeded.workflowId);
  return seeded;
}

test.describe('PG-1.3 no node without a provider', () => {
  test('Add node creates nothing until a provider is chosen, and nothing on Cancel', async ({
    page,
  }) => {
    // PG-1.3: Add node makes an Agent at once, on whichever provider is first.
    test.fail(NOT_BUILT, 'PG-1.3: Add node creates a node before a provider is picked');
    const { workflowId } = await emptyCanvas(page, 'add-cancel');

    await page.getByTestId('new-node-button').click();
    await page.waitForTimeout(1_500);
    expect((await graphOf(workflowId)).nodes, 'no node before a provider is picked').toHaveLength(
      0,
    );

    await expect(picker(page)).toBeVisible();
    await picker(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(picker(page)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect((await graphOf(workflowId)).nodes, 'Cancel created nothing').toHaveLength(0);
  });

  test('Add node creates the node with the chosen provider and model', async ({ page }) => {
    // PG-1.3: there is no picker; the provider is whatever the planner chose.
    test.fail(NOT_BUILT, 'PG-1.3: no provider/model picker on Add node');
    await mockProvider('PG other mock');
    const chosen = await mockProvider('PG chosen mock');
    const { workflowId } = await emptyCanvas(page, 'add-pick');

    await page.getByTestId('new-node-button').click();
    await expect(picker(page)).toBeVisible();
    await picker(page)
      .getByRole('option', { name: /PG chosen mock/ })
      .click();
    await picker(page)
      .getByRole('option', { name: /Mock JSON/ })
      .click();
    await picker(page).getByRole('button', { name: 'Add node' }).click();

    await expect
      .poll(async () => (await graphOf(workflowId)).nodes.length, {
        message: 'one node is created',
      })
      .toBe(1);
    const config = (await graphOf(workflowId)).nodes[0]?.config as {
      providerId?: string;
      modelId?: string;
    };
    expect(config.providerId).toBe(chosen);
    expect(config.modelId).toBe('mock-json');
  });

  test('pre-flight blocks a providerless node with missing_provider', async ({ page }) => {
    // PG-1.3, D358: pre-flight names the issue `missing_provider` (today `missing_model` /
    // `provider_missing`).
    test.fail(NOT_BUILT, 'PG-1.3: pre-flight has no missing_provider issue');
    const flow: Seeded = await seedAgents('providerless', [{ name: 'Orphan' }]);
    await openCanvas(page, flow.projectId, flow.workflowId);
    await expect(card(page, flow.byName('Orphan').id)).toBeVisible({ timeout: 15_000 });
    await startRunFromMenu(page);

    const run = await settledRun(flow.workflowId);
    expect(run.status).toBe('BLOCKED');
    const full = await api<{ preflightIssues: Array<{ code: string; nodeId?: string }> }>(
      `/runs/${run.id}`,
    );
    expect(full.preflightIssues.map((issue) => issue.code)).toContain('missing_provider');
  });

  test('an imported workflow with an unknown provider shows the "Choose a provider" state', async ({
    page,
  }) => {
    // PG-1.3: today the card says "provider missing" in small print; the spec is a red card in a
    // visible "Choose a provider" state.
    test.fail(NOT_BUILT, 'PG-1.3: no "Choose a provider" state on the card');
    const flow = await seedAgents('unknown-provider', [
      { name: 'Imported', providerId: '01J000000000000000000ABCDE', modelId: 'mock-text' },
    ]);
    await openCanvas(page, flow.projectId, flow.workflowId);
    const imported = card(page, flow.byName('Imported').id);
    await expect(imported).toBeVisible({ timeout: 15_000 });
    await expect(imported.getByText('Choose a provider')).toBeVisible();
  });
});
