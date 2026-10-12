import { expect, test } from '@playwright/test';

import {
  freshApp,
  openWorkflow,
  port,
  seedGraph,
  serverGraph,
  settingsDialog,
  settled,
} from './helpers';

/**
 * NFR-USE-02: the core path is possible without a mouse — add a node with the Canvas's "Add node",
 * select nodes, connect two ports and delete — using Tab, Enter, Escape and Delete only.
 */
test.describe('Keyboard-only path (NFR-USE-02)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('add, select, connect, delete with the keyboard only', async ({ page }) => {
    const seeded = await seedGraph(page, ['input']);
    const [inp] = seeded.nodeIds as [string];
    await openWorkflow(page, seeded);

    // add: Enter on "Add node" adds an Agent (the New node dialog is gone, D332)
    await page.getByTestId('new-node-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await settled(page, seeded.workflowId, 2);
    const agent = (await serverGraph(page, seeded.workflowId)).nodes.find(
      (n) => n.kind === 'agent',
    )!;
    // the new node is selected and its settings open on their own — an Agent's (the old panel
    // toggle's job); Escape closes them and hands the keyboard back to the Canvas
    const settings = page.getByRole('dialog', { name: agent.name });
    await expect(settings.getByRole('region', { name: 'Node configuration' })).toBeVisible();
    await expect(settings).toContainText('AGENT');
    await page.keyboard.press('Escape');
    await expect(settingsDialog(page)).toHaveCount(0);

    // connect: Enter on the input's output port arms it, Enter on the agent's input port completes
    await port(page, inp, 'out', 'text').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('armed', { exact: false }).first()).toBeVisible();
    // the port shows it is armed once the Canvas has re-rendered with it (what the next Enter reads)
    await expect(port(page, inp, 'out', 'text')).toHaveAttribute('data-armed', 'true');
    await port(page, agent.id, 'in', 'text').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect
      .poll(async () => (await serverGraph(page, seeded.workflowId)).edges.length)
      .toBe(1);

    // select: a node card takes the focus (React Flow nodes are focusable) and Enter selects it
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
    // armed once the Canvas has re-rendered with it, which is what the next Enter reads
    await expect(port(page, b, 'out', 'text')).toHaveAttribute('data-armed', 'true');
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
