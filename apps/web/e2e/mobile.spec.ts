import { expect, test, type Locator, type Page } from '@playwright/test';

import { flowNode, freshApp, nodeCard, openWorkflow, seedGraph, serverGraph } from './helpers';
import { engineRun, openRound3, runStatus, startRun } from './round3';

/**
 * The phone layout (round 5 §5 item 8): FR-MOB-001/002/003, TC-MOB-001/002. Read-only Canvas tests
 * are named by FR because the FRS has no TC-MOB-003 (D238).
 *
 * Every screen is checked at 380 px for what "usable" can be measured as: nothing pushes the page
 * sideways (`scrollWidth <= clientWidth` on the document), and the controls a person must press are
 * on screen and finger-sized (Arch §10.3: run monitoring, outputs, approvals and chat).
 */

test.use({ viewport: { width: 380, height: 800 } });

const WIDTH = 380;

/** The page itself never scrolls sideways; an inner scroller (a wide table, a log line) may. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  expect(size.scroll, 'document is wider than the screen').toBeLessThanOrEqual(size.client);
  expect(size.body, 'body is wider than the screen').toBeLessThanOrEqual(size.client);
}

/** On screen horizontally, and at least 44 px tall — the touch-target floor. */
async function expectTouchTarget(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(WIDTH);
}

/** Seed Input → Writer → Editor → Output, run it to COMPLETE from the phone layout. */
async function completedRun(page: Page) {
  const seeded = await openRound3(page, 'chain', 'linear-complete');
  await startRun(page).click();
  await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 20_000 });
  const run = (await engineRun(page, seeded.workflowId))!;
  return { seeded, runId: run.id };
}

test.describe('Phone layout — monitoring (FR-MOB-001, TC-MOB-001)', () => {
  test('TC-MOB-001: the Canvas screen switches to the monitoring layout and fits 380 px', async ({
    page,
  }) => {
    await completedRun(page);

    await expect(page.getByTestId('compact-workflow')).toBeVisible();
    // The desktop panes are gone: no palette to drag from, no Configure tab.
    await expect(page.getByTestId('palette-agent')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Configure' })).toHaveCount(0);
    for (const name of ['Canvas', 'Runs', 'Inspector', 'Chat', 'Memory']) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
    // The top bar's links collapse into one menu; the run bar stays reachable.
    await expect(page.getByTestId('topbar-menu')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Usage', exact: true })).toHaveCount(0);
    await expect(startRun(page)).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.getByTestId('topbar-menu').click();
    for (const name of ['Usage', 'Guardrail policies', 'Settings', 'Help']) {
      await expect(page.getByRole('menuitem', { name })).toBeVisible();
    }
    await page.keyboard.press('Escape');
  });

  test('TC-MOB-001: the runs list is usable at 380 px and opens the run', async ({ page }) => {
    const { seeded, runId } = await completedRun(page);

    // From the Canvas screen's own Runs tab.
    await page.getByRole('tab', { name: 'Runs' }).click();
    const row = page.getByTestId(`run-row-${runId}`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'COMPLETE');
    await expectNoHorizontalScroll(page);

    // And from the project's runs page.
    await page.goto(`/projects/${seeded.projectId}/runs`);
    const projectRow = page.getByTestId(`run-row-${runId}`);
    await expect(projectRow).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectTouchTarget(projectRow.getByRole('link'));

    await projectRow.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    await expect(page.getByTestId('run-detail-status')).toHaveAttribute('data-status', 'COMPLETE');
  });

  test('TC-MOB-001: run detail shows outputs and the trace with no horizontal scroll', async ({
    page,
  }) => {
    const { seeded, runId } = await completedRun(page);

    await page.goto(`/runs/${runId}`);
    await expect(page.getByTestId('run-detail-status')).toHaveAttribute('data-status', 'COMPLETE');

    const outputs = page.getByTestId('run-detail-outputs');
    await expect(outputs).toBeVisible();
    // Every node that produced something is listed with what it produced.
    for (const agentId of seeded.agentIds) {
      await expect(outputs.getByTestId(`run-detail-output-${agentId}`)).toBeVisible();
    }
    await expect(page.getByTestId('run-detail-trace')).toBeAttached();
    await expect(page.getByTestId('run-detail-nodes')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('TC-MOB-001: the inspector shows a node’s output at 380 px', async ({ page }) => {
    const { seeded } = await completedRun(page);

    await nodeCard(page, seeded.agentIds[0]!).click();
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await expect(page.getByTestId('inspector-output')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('TC-MOB-001: chat is usable at 380 px', async ({ page }) => {
    await freshApp(page);
    const seeded = await seedGraph(page, ['agent']);
    await openWorkflow(page, seeded);
    await flowNode(page, seeded.nodeIds[0]!).click();
    await page.getByRole('tab', { name: 'Chat' }).click();

    const input = page.getByTestId('chat-input');
    await expect(input).toBeVisible();
    await input.fill('hello from a phone');
    await expectTouchTarget(page.getByTestId('chat-send'));
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-conversation')).toContainText(
      'You said: hello from a phone',
    );
    await expectNoHorizontalScroll(page);

    // The workflow timeline (the other chat surface, FR-CHAT-001) fits too.
    await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}/timeline`);
    await expect(page.getByTestId('timeline-page')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe('Phone layout — approvals (FR-MOB-002, TC-MOB-002)', () => {
  test('TC-MOB-002: an approval answered on the run page continues the node and the run', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer] = seeded.agentIds as [string];
    await startRun(page).click();
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'WAITING', {
      timeout: 15_000,
    });
    const run = (await engineRun(page, seeded.workflowId))!;

    // In-app navigation, not `goto`: a reload would end the mock engine's scripted run with the page.
    await page.getByRole('tab', { name: 'Runs' }).click();
    await page.getByTestId(`run-row-${run.id}`).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/runs/${run.id}$`));
    const section = page.getByTestId('run-detail-approvals');
    await expect(section).toBeVisible();
    await expectNoHorizontalScroll(page);

    const approve = section.getByRole('button', { name: /^Approve/ });
    await expectTouchTarget(approve);
    await expectTouchTarget(section.getByRole('button', { name: /^Reject/ }));
    await approve.click();

    await expect(section).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(async () => (await engineRun(page, seeded.workflowId))?.status, { timeout: 20_000 })
      .toBe('COMPLETE');
  });

  test('TC-MOB-002: the top bar badge opens the cards and Reject is answerable', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer] = seeded.agentIds as [string];
    await startRun(page).click();

    const badge = page.getByTestId('approvals-badge');
    await expect(badge).toHaveAttribute('data-count', '1', { timeout: 15_000 });
    await expectTouchTarget(badge);
    await badge.click();

    const list = page.getByTestId('approvals-list');
    await expect(list).toBeVisible();
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(WIDTH);

    const reject = list.getByRole('button', { name: /^Reject/ });
    await expectTouchTarget(reject);
    await expectTouchTarget(list.getByRole('button', { name: /^Approve/ }));
    await reject.click();

    // Round 3's behaviour, unchanged on a phone: a rejection fails the node as GUARDRAIL_VIOLATION.
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'FAILED', {
      timeout: 15_000,
    });
    await expect(badge).toHaveCount(0);
  });
});

test.describe('Phone layout — read-only Canvas (FR-MOB-003)', () => {
  test('FR-MOB-003: the Canvas renders read-only with the banner, and pans', async ({ page }) => {
    await freshApp(page);
    const seeded = await seedGraph(page, ['input', 'agent', 'output']);
    await openWorkflow(page, seeded);

    const banner = page.getByTestId('readonly-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(/Editing is available on a larger screen/);
    await expect(page.getByTestId('palette-agent')).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // Pan: drag the empty pane and the viewport moves.
    const viewport = page.locator('.react-flow__viewport');
    const before = await viewport.getAttribute('style');
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    const x = pane.x + 12;
    const y = pane.y + 12;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) await page.mouse.move(x + i * 8, y + i * 6);
    await page.mouse.up();
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(before);
  });

  test('FR-MOB-003: a node cannot be dragged on the phone Canvas', async ({ page }) => {
    await freshApp(page);
    const seeded = await seedGraph(page, ['input', 'agent']);
    await openWorkflow(page, seeded);
    await expect(page.getByTestId('canvas')).toHaveAttribute('data-readonly', 'true');
    const before = (await serverGraph(page, seeded.workflowId)).nodes;

    const node = flowNode(page, seeded.nodeIds[1]!);
    const box = (await node.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1)
      await page.mouse.move(box.x + box.width / 2 + i * 6, box.y + 10);
    await page.mouse.up();
    await page.waitForTimeout(800);

    expect((await serverGraph(page, seeded.workflowId)).nodes).toEqual(before);
  });
});

test.describe('Desktop is unchanged above 640 px (FR-MOB-001)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('FR-MOB-001: at 1280 px the three-pane editor and the top bar links are back', async ({
    page,
  }) => {
    await freshApp(page);
    const seeded = await seedGraph(page, ['agent']);
    await openWorkflow(page, seeded);
    await expect(page.getByTestId('compact-workflow')).toHaveCount(0);
    await expect(page.getByTestId('readonly-banner')).toHaveCount(0);
    await expect(page.getByTestId('palette-agent')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Configure' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Usage', exact: true })).toBeVisible();
    await expect(page.getByTestId('topbar-menu')).toHaveCount(0);
  });
});
