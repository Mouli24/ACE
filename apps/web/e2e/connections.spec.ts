import { expect, test } from '@playwright/test';

import {
  clearOfMinimap,
  connect,
  dragConnect,
  freshApp,
  openWorkflow,
  port,
  seedGraph,
  serverGraph,
} from './helpers';

test.describe('Connections (FR-CON-001..006)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('TC-CON-001: drag output → input creates a saved edge with its data type label', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input', 'agent']);
    const [inp, agent] = seeded.nodeIds as [string, string];
    await openWorkflow(page, seeded);
    await dragConnect(page, port(page, inp, 'out', 'text'), port(page, agent, 'in', 'text'));
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect
      .poll(async () => (await serverGraph(page, seeded.workflowId)).edges.length)
      .toBe(1);
    const edge = (await serverGraph(page, seeded.workflowId)).edges[0]!;
    expect(edge.from).toEqual({ nodeId: inp, portId: `${inp}:out:text` });
    expect(edge.to).toEqual({ nodeId: agent, portId: `${agent}:in:text` });
    await expect(page.getByTestId(`edge-label-${edge.id}`)).toHaveText('text');
    await expect(port(page, inp, 'out', 'text')).toHaveAttribute('data-connected', 'true');
    await page.reload();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });

  test('TC-CON-002: text output → image-only input is refused with the reason', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input', 'agent']);
    const [inp, agent] = seeded.nodeIds as [string, string];
    // D285: the config panel no longer offers typed ports, but a workflow made before it can still
    // hold an image-only agent, and the Canvas must still refuse the wrong connection to it.
    await page.evaluate(
      ({ workflowId, nodeId }) =>
        window.__aceMock!.patchNodeConfig(workflowId, nodeId, { inputTypes: ['image'] }),
      { workflowId: seeded.workflowId, nodeId: agent },
    );
    await openWorkflow(page, seeded);
    await expect(port(page, agent, 'in', 'image')).toBeVisible();
    await expect(port(page, agent, 'in', 'text')).toHaveCount(0);
    await dragConnect(page, port(page, inp, 'out', 'text'), port(page, agent, 'in', 'image'));
    await expect(page.getByText('Connection refused').first()).toBeVisible();
    await expect(
      page.getByText(/cannot connect text output .* to image input/i).first(),
    ).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
    expect((await serverGraph(page, seeded.workflowId)).edges).toHaveLength(0);
  });

  test('TC-CON-003: A→B then B→A as a plain edge is refused (client) and the engine 400 is surfaced', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['agent', 'agent']);
    const [a, b] = seeded.nodeIds as [string, string];
    await connect(page, seeded.workflowId, a, 'text', b, 'text');
    await openWorkflow(page, seeded);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    // the fitted second card's output port can sit under the minimap (V2 Canvas at 1280×720)
    await clearOfMinimap(page, port(page, b, 'out', 'text'));
    await dragConnect(page, port(page, b, 'out', 'text'), port(page, a, 'in', 'text'));
    await expect(page.getByText('Connection refused').first()).toBeVisible();
    // Round 3 rewrote the sentence: a cycle is now refused *as a data edge* and pointed at the loop
    // edge instead (`apps/web/src/canvas/connect.ts`). The rule is unchanged; the wording is not.
    await expect(page.getByText(/cannot close a cycle/i).first()).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    expect((await serverGraph(page, seeded.workflowId)).edges).toHaveLength(1);
  });

  test('FR-CON-003: the engine 400 for a cycle is surfaced when the client check is bypassed', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['agent', 'agent']);
    const [a, b] = seeded.nodeIds as [string, string];
    await connect(page, seeded.workflowId, a, 'text', b, 'text');
    await openWorkflow(page, seeded);
    // the client would refuse b→a; send it straight to the engine as a stale tab might
    const status = await page.evaluate(
      async ({ workflowId, a, b }) => {
        const res = await fetch(`/api/v1/workflows/${workflowId}/graph-ops`, {
          method: 'POST',
          headers: { authorization: 'Bearer mock', 'content-type': 'application/json' },
          body: JSON.stringify({
            baseVersion: window.__aceMock!.db.getWorkflow(workflowId)!.version,
            ops: [
              {
                op: 'add_edge',
                edge: {
                  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
                  workflowId,
                  kind: 'data',
                  from: { nodeId: b, portId: `${b}:out:text` },
                  to: { nodeId: a, portId: `${a}:in:text` },
                },
              },
            ],
          }),
        });
        return { status: res.status, body: (await res.json()) as { error: { message: string } } };
      },
      { workflowId: seeded.workflowId, a, b },
    );
    expect(status.status).toBe(400);
    expect(status.body.error.message).toMatch(/cycle/i);
  });

  test('TC-CON-004: select an edge and press Delete → edge removed and saved; the context menu works too', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input', 'agent', 'output']);
    const [inp, agent, out] = seeded.nodeIds as [string, string, string];
    await connect(page, seeded.workflowId, inp, 'text', agent, 'text');
    await connect(page, seeded.workflowId, agent, 'text', out, 'text');
    await openWorkflow(page, seeded);
    const edges = page.locator('.react-flow__edge');
    await expect(edges).toHaveCount(2);
    const [first, second] = (await serverGraph(page, seeded.workflowId)).edges.map((e) => e.id);
    // an edge is selected on its hit band: its look and label are drawn above the nodes and take
    // no pointer (D332)
    await page.getByTestId(`edge-${first}`).click();
    await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1);
    await page.keyboard.press('Delete');
    await expect(edges).toHaveCount(1);
    await expect
      .poll(async () => (await serverGraph(page, seeded.workflowId)).edges.length)
      .toBe(1);

    await page.getByTestId(`edge-${second}`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete connection' }).click();
    await expect(edges).toHaveCount(0);
    await expect
      .poll(async () => (await serverGraph(page, seeded.workflowId)).edges.length)
      .toBe(0);
  });

  test('TC-CON-005: one output feeds three inputs', async ({ page }) => {
    const seeded = await seedGraph(page, ['input', 'agent', 'agent', 'agent']);
    const [inp, a, b, c] = seeded.nodeIds as [string, string, string, string];
    await openWorkflow(page, seeded);
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await page.waitForTimeout(300);
    for (const target of [a, b, c]) {
      await dragConnect(page, port(page, inp, 'out', 'text'), port(page, target, 'in', 'text'));
    }
    await expect(page.locator('.react-flow__edge')).toHaveCount(3);
    await expect
      .poll(async () => (await serverGraph(page, seeded.workflowId)).edges.length)
      .toBe(3);
  });

  test('TC-CON-006: a second edge into a single input is refused', async ({ page }) => {
    const seeded = await seedGraph(page, ['input', 'input', 'agent']);
    const [inp1, inp2, agent] = seeded.nodeIds as [string, string, string];
    await connect(page, seeded.workflowId, inp1, 'text', agent, 'text');
    await openWorkflow(page, seeded);
    await dragConnect(page, port(page, inp2, 'out', 'text'), port(page, agent, 'in', 'text'));
    await expect(
      page.getByText(/already has a connection and accepts only one/i).first(),
    ).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    expect((await serverGraph(page, seeded.workflowId)).edges).toHaveLength(1);
  });

  test('FR-CON-006: hovering an edge says "no data yet"', async ({ page }) => {
    const seeded = await seedGraph(page, ['input', 'agent']);
    const [inp, agent] = seeded.nodeIds as [string, string];
    await connect(page, seeded.workflowId, inp, 'text', agent, 'text');
    await openWorkflow(page, seeded);
    const edgeId = (await serverGraph(page, seeded.workflowId)).edges[0]!.id;
    await expect(page.getByTestId(`edge-${edgeId}`).locator('title')).toHaveText('no data yet');
  });
});
