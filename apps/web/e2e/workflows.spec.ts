import { expect, test } from '@playwright/test';

import {
  addFromDialog,
  freshApp,
  openSheet,
  openWorkflow,
  seedGraph,
  serverGraph,
  settled,
} from './helpers';

test.describe('Workflows (FR-WF-001..005)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('TC-WF-001: new workflow opens as a tab with an empty Canvas', async ({ page }) => {
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('P');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    // `exact` matters now: the top bar's "no providers" link would also match a substring "P".
    await page.getByRole('link', { name: 'P', exact: true }).click();
    await page.getByRole('button', { name: 'New workflow' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Flow 1');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/workflows\/[0-9A-Z]{26}$/);
    await expect(page.getByRole('tab', { name: 'Flow 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    // the palette is the New node dialog, one click away in the top bar (D259)
    await page.getByTestId('new-node-button').click();
    await expect(page.getByLabel('Node palette')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'New node' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Validation' })).toBeVisible();
    // the workflow-level config is in the sheet, which starts closed
    await openSheet(page, 'Configure');
    await expect(page.getByText('Select a node to configure it.')).toBeVisible();
  });

  test('TC-WF-002: two workflows, switching tabs shows each graph', async ({ page }) => {
    const a = await seedGraph(page, ['input', 'agent'], {
      projectName: 'P',
      workflowName: 'Alpha',
    });
    // the second workflow is created through the UI
    await openWorkflow(page, a);
    await page.getByRole('button', { name: 'Add workflow' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Beta');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Alpha' }).click();
    await expect(page.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await page.getByRole('tab', { name: 'Beta' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
  });

  test('TC-WF-003: duplicate a 3-node workflow → same structure, different ids', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input', 'agent', 'output'], { workflowName: 'Tri' });
    await page.evaluate(({ workflowId, nodeIds }) => {
      window.__aceMock!.connect(workflowId, nodeIds[0]!, 'text', nodeIds[1]!, 'text');
      window.__aceMock!.connect(workflowId, nodeIds[1]!, 'text', nodeIds[2]!, 'text');
    }, seeded);
    await openWorkflow(page, seeded);
    await page.getByRole('button', { name: 'Workflow actions for Tri' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(page.getByRole('tab', { name: 'Tri (copy)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);
    const copyId = page.url().split('/').pop() as string;
    expect(copyId).not.toBe(seeded.workflowId);
    const copy = await serverGraph(page, copyId);
    const original = await serverGraph(page, seeded.workflowId);
    expect(copy.nodes.map((n) => n.kind)).toEqual(original.nodes.map((n) => n.kind));
    expect(copy.nodes.map((n) => n.id)).not.toEqual(
      expect.arrayContaining(original.nodes.map((n) => n.id)),
    );
    expect(copy.edges).toHaveLength(2);
  });

  test('TC-WF-004: add a node → reload → still there (autosave through graph-ops)', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input']);
    await openWorkflow(page, seeded);
    await addFromDialog(page, 'agent');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await settled(page, seeded.workflowId, 2);
    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    expect((await serverGraph(page, seeded.workflowId)).version).toBe(2);
  });

  test('TC-WF-005: stale baseVersion → 409 → the page refetches, reapplies and shows the latest graph', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input']);
    await openWorkflow(page, seeded);
    // another client wrote first: bump silently so this tab keeps its stale version 1
    const bumped = await page.evaluate(
      (id) => window.__aceMock!.bumpVersion(id),
      seeded.workflowId,
    );
    expect(bumped).toBe(2);
    const responses: number[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/graph-ops')) responses.push(r.status());
    });
    await addFromDialog(page, 'agent');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await settled(page, seeded.workflowId, 2);
    expect(responses).toContain(409);
    expect(responses.at(-1)).toBe(200);
    const graph = await serverGraph(page, seeded.workflowId);
    expect(graph.version).toBe(3);
    expect(graph.nodes.map((n) => n.kind).sort()).toEqual(['agent', 'input']);
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
  });

  test('TC-WF-005 (two pages): an edit in the other tab appears here through workflow.updated', async ({
    page,
    context,
  }) => {
    const seeded = await seedGraph(page, ['input']);
    await openWorkflow(page, seeded);
    const other = await context.newPage();
    await openWorkflow(other, seeded);
    // D285: the dialog offers one node, an Agent
    await addFromDialog(other, 'agent');
    await settled(other, seeded.workflowId, 2);
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    // now this tab edits on top of the version the other tab produced: no 409, no lost node
    await addFromDialog(page, 'agent');
    await settled(page, seeded.workflowId, 3);
    await expect(other.locator('.react-flow__node')).toHaveCount(3);
    expect((await serverGraph(page, seeded.workflowId)).nodes.map((n) => n.kind).sort()).toEqual([
      'agent',
      'agent',
      'input',
    ]);
    await other.close();
  });
});
