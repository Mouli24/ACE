import { expect, test } from '@playwright/test';

import {
  connect,
  dragBy,
  flowNode,
  freshApp,
  openWorkflow,
  seedGraph,
  serverGraph,
  settled,
} from './helpers';

test.describe('Canvas (FR-CAN-001..007, 010)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('FR-CAN-001: the Canvas is a dark dotted grid', async ({ page }) => {
    const seeded = await seedGraph(page, ['input']);
    await openWorkflow(page, seeded);
    const pane = page.locator('.react-flow');
    await expect(pane).toHaveCSS('background-color', 'rgb(13, 17, 23)');
    await expect(page.locator('.react-flow__background pattern circle').first()).toBeAttached();
  });

  test('TC-CAN-001: drag Agent from the palette → node at the drop point, saved', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input']);
    await openWorkflow(page, seeded);
    const canvas = page.getByTestId('canvas');
    const box = (await canvas.boundingBox())!;
    const dropX = box.x + box.width * 0.6;
    const dropY = box.y + box.height * 0.6;
    await page.getByTestId('palette-agent').dragTo(canvas, {
      targetPosition: { x: dropX - box.x, y: dropY - box.y },
    });
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await settled(page, seeded.workflowId, 2);
    const graph = await serverGraph(page, seeded.workflowId);
    const agent = graph.nodes.find((n) => n.kind === 'agent')!;
    const card = flowNode(page, agent.id);
    const cardBox = (await card.boundingBox())!;
    // the node's top-left corner is where the pointer let go (within a few px of rounding)
    expect(Math.abs(cardBox.x - dropX)).toBeLessThan(6);
    expect(Math.abs(cardBox.y - dropY)).toBeLessThan(6);
  });

  test('TC-CAN-002: box select over 3 nodes → 3 selected', async ({ page }) => {
    const seeded = await seedGraph(page, ['input', 'agent', 'output']);
    await openWorkflow(page, seeded);
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await page.waitForTimeout(300);
    const boxes = await Promise.all(seeded.nodeIds.map((id) => flowNode(page, id).boundingBox()));
    const minX = Math.min(...boxes.map((b) => b!.x)) - 20;
    const minY = Math.min(...boxes.map((b) => b!.y)) - 20;
    const maxX = Math.max(...boxes.map((b) => b!.x + b!.width)) + 20;
    const maxY = Math.max(...boxes.map((b) => b!.y + b!.height)) + 20;
    await page.keyboard.down('Shift');
    await page.mouse.move(minX, minY);
    await page.mouse.down();
    await page.mouse.move(maxX, maxY, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);
    await expect(
      page.getByText('3 nodes selected. Select one node to configure it.'),
    ).toBeVisible();
  });

  test('FR-CAN-003: click selects one, Ctrl+click adds another', async ({ page }) => {
    const seeded = await seedGraph(page, ['input', 'agent']);
    await openWorkflow(page, seeded);
    await flowNode(page, seeded.nodeIds[0]!).click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await flowNode(page, seeded.nodeIds[1]!).click({ modifiers: ['Control'] });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  });

  test('TC-CAN-003: move a node → reload → same position', async ({ page }) => {
    const seeded = await seedGraph(page, ['input']);
    await openWorkflow(page, seeded);
    const id = seeded.nodeIds[0]!;
    const before = (await serverGraph(page, seeded.workflowId)).nodes[0]!.position;
    const screenBefore = (await flowNode(page, id).boundingBox())!;
    await dragBy(page, flowNode(page, id), 150, 90);
    const screenAfter = (await flowNode(page, id).boundingBox())!;
    // React Flow starts the drag one pointer step in, so allow one step (150/12 px) of slack
    expect(Math.abs(screenAfter.x - screenBefore.x - 150)).toBeLessThan(15);
    expect(Math.abs(screenAfter.y - screenBefore.y - 90)).toBeLessThan(15);
    await expect
      .poll(async () => (await serverGraph(page, seeded.workflowId)).nodes[0]!.position.x, {
        timeout: 5000,
      })
      .not.toBe(before.x);
    const moved = (await serverGraph(page, seeded.workflowId)).nodes[0]!.position;
    await page.reload();
    await expect(flowNode(page, id)).toBeVisible();
    const after = (await serverGraph(page, seeded.workflowId)).nodes[0]!.position;
    expect(after).toEqual(moved);
    const style = await flowNode(page, id).getAttribute('style');
    expect(style).toContain(`translate(${moved.x}px, ${moved.y}px)`);
  });

  test('TC-CAN-004: delete a connected node → its edges are gone', async ({ page }) => {
    const seeded = await seedGraph(page, ['input', 'agent', 'output']);
    const [inp, agent, out] = seeded.nodeIds as [string, string, string];
    await connect(page, seeded.workflowId, inp, 'text', agent, 'text');
    await connect(page, seeded.workflowId, agent, 'text', out, 'text');
    await openWorkflow(page, seeded);
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);
    await flowNode(page, agent).click();
    await page.keyboard.press('Delete');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
    await settled(page, seeded.workflowId, 2);
    const graph = await serverGraph(page, seeded.workflowId);
    expect(graph.edges).toHaveLength(0);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([inp, out].sort());
  });

  test('TC-CAN-005: duplicate → rename the copy → the original is unchanged', async ({ page }) => {
    const seeded = await seedGraph(page, ['agent']);
    const original = seeded.nodeIds[0]!;
    await openWorkflow(page, seeded);
    await flowNode(page, original).click();
    const panel = page.getByRole('complementary', { name: 'Node configuration' });
    await panel.getByLabel('Instructions').fill('Original instructions');
    await panel.getByLabel('Instructions').blur();
    await settled(page, seeded.workflowId, 1);
    await page.getByRole('button', { name: 'Duplicate selected nodes' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await settled(page, seeded.workflowId, 2);
    const graph = await serverGraph(page, seeded.workflowId);
    const copy = graph.nodes.find((n) => n.id !== original)!;
    // offset, and never covering the original — its ports must stay reachable (FR-CAN-006)
    const source = graph.nodes.find((n) => n.id === original)!;
    expect(copy.position).not.toEqual(source.position);
    const apart =
      Math.abs(copy.position.x - source.position.x) >= 200 ||
      Math.abs(copy.position.y - source.position.y) >= 120;
    expect(apart).toBe(true);
    expect((copy.config as { instructions: string }).instructions).toBe('Original instructions');
    // the copy is selected after duplicating; rename it
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await panel.getByLabel('Name').fill('Copy');
    await panel.getByLabel('Name').press('Enter');
    await expect
      .poll(
        async () =>
          (await serverGraph(page, seeded.workflowId)).nodes.find((n) => n.id === copy.id)?.name,
      )
      .toBe('Copy');
    const after = await serverGraph(page, seeded.workflowId);
    expect(after.nodes.find((n) => n.id === original)?.name).toBe('Agent');
    await expect(flowNode(page, original)).toContainText('Agent');
    await expect(flowNode(page, copy.id)).toContainText('Copy');
  });

  test('TC-CAN-006: pan, zoom with the wheel, press F → view fits all nodes', async ({ page }) => {
    const seeded = await seedGraph(page, [
      'input',
      'agent',
      'model',
      'output',
      'merge',
      'transform',
    ]);
    await openWorkflow(page, seeded);
    const viewport = page.locator('.react-flow__viewport');
    const transformOf = async () => (await viewport.getAttribute('style')) ?? '';
    const t0 = await transformOf();
    // pan: drag the empty pane
    const box = (await page.getByTestId('canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width - 60, box.y + box.height - 60);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 200, box.y + box.height - 160, { steps: 8 });
    await page.mouse.up();
    await expect.poll(transformOf).not.toBe(t0);
    // zoom: trackpad/mouse wheel with ctrl (pinch) changes the scale
    const t1 = await transformOf();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -300);
    await page.keyboard.up('Control');
    await expect.poll(transformOf).not.toBe(t1);
    // F fits: every node ends up inside the pane
    await page.keyboard.press('f');
    await page.waitForTimeout(400);
    for (const id of seeded.nodeIds) {
      const b = (await flowNode(page, id).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(b.y).toBeGreaterThanOrEqual(box.y - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height + 1);
    }
    await expect(page.locator('.react-flow__minimap')).toBeVisible();
  });

  test('TC-CAN-009: slow network → loading state, then the whole graph at once (never half-drawn)', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input', 'agent', 'output']);
    const [inp, agent, out] = seeded.nodeIds as [string, string, string];
    await connect(page, seeded.workflowId, inp, 'text', agent, 'text');
    await connect(page, seeded.workflowId, agent, 'text', out, 'text');
    // Slow 3G: the mock answers every request 1.5 s late (MSW answers inside the page, so
    // Playwright route throttling never sees these requests)
    await page.evaluate(() => window.__aceMock!.setLatency(1500));
    await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}`);
    await expect(page.getByTestId('canvas-loading')).toBeVisible();
    // while loading, nothing of the graph is drawn
    expect(await page.locator('.react-flow__node').count()).toBe(0);
    expect(await page.locator('.react-flow__edge').count()).toBe(0);
    await expect(page.getByTestId('canvas-loading')).toBeHidden({ timeout: 5000 });
    // the first paint after loading already has every node and edge
    const counts = await page.evaluate(() => ({
      nodes: document.querySelectorAll('.react-flow__node').length,
      edges: document.querySelectorAll('.react-flow__edge').length,
    }));
    expect(counts).toEqual({ nodes: 3, edges: 2 });
  });
});
