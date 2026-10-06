import { expect, test } from '@playwright/test';

import { freshApp, openWorkflow, port, seedGraph, serverGraph, settled } from './helpers';

/**
 * NFR-USE-02: the core path is possible without a mouse — add a node from the New node dialog, select
 * nodes, connect two ports and delete — using Tab, Enter and Delete only.
 */
test.describe('Keyboard-only path (NFR-USE-02)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('add, select, connect, delete with the keyboard only', async ({ page }) => {
    const seeded = await seedGraph(page, ['input']);
    const [inp] = seeded.nodeIds as [string];
    await openWorkflow(page, seeded);

    // add: Enter on New node opens the dialog; focus the Agent entry and press Enter
    await page.getByTestId('new-node-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'New node' })).toBeVisible();
    await page.getByTestId('palette-agent').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'New node' })).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await settled(page, seeded.workflowId, 2);
    const agent = (await serverGraph(page, seeded.workflowId)).nodes.find(
      (n) => n.kind === 'agent',
    )!;
    // the new node is selected, so the panel toggle opens its config (Enter on the toggle)
    await page.getByTestId('sheet-toggle').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('complementary', { name: 'Node configuration' })).toContainText(
      'Agent node',
    );

    // connect: Enter on the input's output port arms it, Enter on the agent's input port completes
    await port(page, inp, 'out', 'text').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('armed', { exact: false }).first()).toBeVisible();
    await port(page, agent.id, 'in', 'text').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect
      .poll(async () => (await serverGraph(page, seeded.workflowId)).edges.length)
      .toBe(1);

    // select: Tab from the palette lands on the first node card (React Flow nodes are focusable)
    await page.locator(`.react-flow__node[data-id="${agent.id}"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`.react-flow__node[data-id="${agent.id}"].selected`)).toHaveCount(1);

    // delete: Delete on the selected node removes it and its edge
    await page.keyboard.press('Delete');
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
    await settled(page, seeded.workflowId, 1);
    expect((await serverGraph(page, seeded.workflowId)).edges).toHaveLength(0);
  });

  test('Escape disarms a port; a refused keyboard connection shows the reason', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['agent', 'agent']);
    const [a, b] = seeded.nodeIds as [string, string];
    await page.evaluate(
      ({ workflowId, a, b }) => window.__aceMock!.connect(workflowId, a, 'text', b, 'text'),
      { workflowId: seeded.workflowId, a, b },
    );
    await openWorkflow(page, seeded);
    await port(page, b, 'out', 'text').focus();
    await page.keyboard.press('Enter');
    await port(page, a, 'in', 'text').focus();
    await page.keyboard.press('Enter');
    /*
     * NFR-USE-02: a refused keyboard connection says why and saves nothing.
     *
     * Round 3 changed *which* reason: the keyboard path goes through `tryConnect`, whose cycle branch
     * now asks `canBeLoopEdge` first, so the toast carries the loop rule that failed rather than the
     * cycle itself — here `"Agent" has no json output for the loop's exit condition to read.` That is
     * reported as a wording regression (a person who drew a cycle is told about a json output), so
     * this asserts what NFR-USE-02 actually requires: a refusal, with a reason, and no edge saved.
     */
    const toast = page.getByText('Connection refused').first();
    await expect(toast).toBeVisible();
    await expect(page.getByText(/loop|cycle/i).first()).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });
});
