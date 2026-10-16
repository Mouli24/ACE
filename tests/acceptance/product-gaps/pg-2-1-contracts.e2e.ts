import { test, type Page } from '@playwright/test';

import {
  card,
  centre,
  closeSettings,
  drag,
  expect,
  fitView,
  graphOf,
  mockProvider,
  openCanvas,
  port,
  seedAgents,
  settingsDialog,
  settledRun,
  startRunFromMenu,
  type Seeded,
} from './helpers.js';

/**
 * PG-2.1 Output contracts are enforced (product-gaps prompt, Phase 2; D353, X4). Today a JSON schema
 * set in the Agent modal is stored but ignored: the node keeps `outputTypes: ['text']`, so the
 * executor never parses or checks its output, and a Review→Fix loop is refused
 * `loop_source_not_json`. Red until PG-2.1 lands.
 */

/** Open a node's settings with a click near the top of its card (D333). */
async function openSettings(page: Page, nodeId: string): Promise<void> {
  await closeSettings(page);
  await fitView(page);
  await card(page, nodeId).click({ position: { x: 40, y: 8 } });
  await expect(settingsDialog(page)).toBeVisible();
}

/** The standard review contract, set from the modal (FR-PAR-007's one-press button). */
async function setReviewContract(page: Page, nodeId: string): Promise<void> {
  await openSettings(page, nodeId);
  const use = settingsDialog(page).getByTestId('use-review-contract');
  await use.click();
  await expect(use).toBeDisabled();
}

test.describe('PG-2.1 output contracts are enforced', () => {
  test('TC-EXE-005 from the UI: a schema set in the modal turns non-JSON output into CONTRACT_VIOLATION', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const providerId = await mockProvider();
    const flow = await seedAgents('contract', [
      { name: 'Writer', providerId, modelId: 'mock-text' },
    ]);
    const writer = flow.byName('Writer');
    await openCanvas(page, flow.projectId, flow.workflowId);
    await expect(card(page, writer.id)).toBeVisible({ timeout: 15_000 });

    await setReviewContract(page, writer.id);
    await expect
      .poll(async () => {
        const node = (await graphOf(flow.workflowId)).nodes.find((n) => n.id === writer.id);
        return (
          (node?.config as { outputContract?: { jsonSchema?: unknown } }).outputContract
            ?.jsonSchema !== undefined
        );
      })
      .toBe(true);
    await closeSettings(page);
    await startRunFromMenu(page);
    await settledRun(flow.workflowId);

    // `mock-text` answers prose: against a schema that is a contract violation (BR-03). The failure
    // note hangs under the card (`UnderCard`), outside `node-card-<id>`, so it is found by its own id.
    await expect(page.getByTestId(`failure-${writer.id}`)).toHaveAttribute(
      'data-reason',
      'CONTRACT_VIOLATION',
    );
  });

  test('the contract section says the output will be JSON checked against the schema', async ({
    page,
  }) => {
    const providerId = await mockProvider();
    const flow = await seedAgents('contract-copy', [
      { name: 'Writer', providerId, modelId: 'mock-text' },
    ]);
    await openCanvas(page, flow.projectId, flow.workflowId);
    await expect(card(page, flow.byName('Writer').id)).toBeVisible({ timeout: 15_000 });
    await setReviewContract(page, flow.byName('Writer').id);
    await expect(
      settingsDialog(page).getByText('Output will be JSON and checked against this schema'),
    ).toBeVisible();
  });

  test('a Review→Fix loop can be built from the UI', async ({ page }) => {
    const providerId = await mockProvider();
    const flow: Seeded = await seedAgents(
      'review-fix',
      [
        { name: 'Fix', providerId, modelId: 'mock-text' },
        { name: 'Review', providerId, modelId: 'mock-reject-twice' },
      ],
      { edges: [['Fix', 'Review']] },
    );
    await openCanvas(page, flow.projectId, flow.workflowId);
    await expect(card(page, flow.byName('Review').id)).toBeVisible({ timeout: 15_000 });

    // Review's contract from the modal, then the cycle drawn by hand Review → Fix.
    await setReviewContract(page, flow.byName('Review').id);
    await closeSettings(page);
    await fitView(page);
    await drag(
      page,
      await centre(port(page, flow.byName('Review').outputs[0]?.id ?? '')),
      await centre(port(page, flow.byName('Fix').inputs[0]?.id ?? '')),
    );

    await expect(page.getByText('Connection refused'), 'the cycle is not refused').toHaveCount(0);
    await expect(page.getByTestId('make-loop-edge')).toBeVisible();
  });
});
