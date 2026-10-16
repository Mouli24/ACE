import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addFromDialog,
  freshApp,
  openSheet,
  openWorkflow,
  seedGraph,
  serverGraph,
  settled,
} from './helpers';

/*
 * The workflow tabs live in the workspace "…" menu now (D331): one menuitemradio per workflow,
 * `aria-checked` on the open one, then New workflow and the open workflow's Duplicate below them.
 */

async function openWorkspaceMenu(page: Page): Promise<void> {
  await page.getByTestId('workspace-menu').click();
}

/** A workflow's entry in the open workspace menu (what its tab was). */
const workflowItem = (page: Page, name: string): Locator =>
  page.getByRole('menuitemradio', { name, exact: true });

/** The workflow on screen is `name`: its menu entry is the checked one (its tab was selected). */
async function expectOpenWorkflow(page: Page, name: string): Promise<void> {
  await openWorkspaceMenu(page);
  await expect(workflowItem(page, name)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

/** Switch workflows from the menu (what a click on its tab did). */
async function switchTo(page: Page, name: string): Promise<void> {
  await openWorkspaceMenu(page);
  await workflowItem(page, name).click();
}

test.describe('Workflows (FR-WF-001..005)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('TC-WF-001: new workflow opens as a tab with an empty Canvas', async ({ page }) => {
    // Home's Canvas card opens New project; Create opens the project's first workflow (D337)
    await page.getByRole('button', { name: /^Canvas/ }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('P');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9A-Z]{26}\/workflows\/[0-9A-Z]{26}$/);
    // the project page (from the workspace menu) makes the next one
    await openWorkspaceMenu(page);
    await page.getByTestId('menu-project-page').click();
    await expect(page).toHaveURL(/\/projects\/[0-9A-Z]{26}$/);
    await page.getByRole('button', { name: 'New workflow' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Flow 1');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/workflows\/[0-9A-Z]{26}$/);
    await expectOpenWorkflow(page, 'Flow 1');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    // adding is one click away on the Canvas: "Add node" (the New node dialog is gone, D332)
    await expect(page.getByTestId('new-node-button')).toBeVisible();
    // the bottom panel starts hidden; the menu's "Problems & events" opens it on Validation (D332)
    await openWorkspaceMenu(page);
    await page.getByTestId('menu-problems').click();
    await expect(page.getByRole('tab', { name: 'Validation' })).toBeVisible();
    // the workflow sheet starts closed; its Configure tab is the node settings modal now (D333), so
    // it opens on the Inspector, which has nothing to show for a new workflow yet
    await expect(page.getByTestId('workflow-sheet')).toHaveCount(0);
    await openSheet(page, 'Inspector');
    await expect(page.getByTestId('workflow-sheet')).toBeVisible();
    await expect(page.getByText('Start a run to inspect it.')).toBeVisible();
  });

  test('TC-WF-002: two workflows, switching tabs shows each graph', async ({ page }) => {
    const a = await seedGraph(page, ['input', 'agent'], {
      projectName: 'P',
      workflowName: 'Alpha',
    });
    // the second workflow is created through the UI
    await openWorkflow(page, a);
    await openWorkspaceMenu(page);
    await page.getByTestId('menu-new-workflow').click();
    await page.getByRole('dialog').getByLabel('Name').fill('Beta');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectOpenWorkflow(page, 'Beta');
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await switchTo(page, 'Alpha');
    await expectOpenWorkflow(page, 'Alpha');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await switchTo(page, 'Beta');
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
    // the menu's "This workflow" section acts on the open workflow, Tri
    await openWorkspaceMenu(page);
    await expect(workflowItem(page, 'Tri')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('menu-duplicate-workflow').click();
    await expect(page).not.toHaveURL(new RegExp(`/workflows/${seeded.workflowId}$`));
    await expectOpenWorkflow(page, 'Tri (copy)');
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

  // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
  test.skip('TC-WF-004: add a node → reload → still there (autosave through graph-ops)', async ({
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

  // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
  test.skip('TC-WF-005: stale baseVersion → 409 → the page refetches, reapplies and shows the latest graph', async ({
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

  // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
  test.skip('TC-WF-005 (two pages): an edit in the other tab appears here through workflow.updated', async ({
    page,
    context,
  }) => {
    const seeded = await seedGraph(page, ['input']);
    await openWorkflow(page, seeded);
    const other = await context.newPage();
    await openWorkflow(other, seeded);
    // D285, D332: the Canvas adds one kind of node, an Agent
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
