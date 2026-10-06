import { expect, test, type Page } from '@playwright/test';

import {
  addFromDialog,
  clearOfMinimap,
  connect,
  dragBy,
  dragConnect,
  flowNode,
  freshApp,
  nodeCard,
  openWorkflow,
  port,
  seedGraph,
  serverGraph,
  settled,
} from './helpers';

/**
 * Round 5 §5 item 7 — Canvas productivity (FR-CAN-008/009/011/012/013): auto-arrange, undo/redo
 * replayed through graph-ops, right-click menus, shortcuts and copy/paste between workflows.
 * Every "it happened" is read from the mock engine, not from the screen (BR-01).
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** The server graph without the version, sorted, so two snapshots compare by content. */
async function snapshot(page: Page, workflowId: string) {
  const graph = await serverGraph(page, workflowId);
  return {
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Autosave has sent everything: the server stops changing for a moment. */
async function quiet(page: Page, workflowId: string) {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await serverGraph(page, workflowId));
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [300, 300, 300, 500, 500, 1000], timeout: 10_000 },
    )
    .toBe(true);
}

/** Put the mock's nodes wherever `positions` says (a scattered graph to auto-arrange). */
async function placeNodes(
  page: Page,
  workflowId: string,
  positions: Record<string, { x: number; y: number }>,
) {
  await page.evaluate(
    ({ workflowId, positions }) => {
      const db = window.__aceMock!.db;
      db.load();
      const nodes = db
        .nodesOf(workflowId)
        .map((n) => (positions[n.id] ? { ...n, position: positions[n.id]! } : n));
      db.commitGraph(workflowId, nodes, db.edgesOf(workflowId), { silent: true });
    },
    { workflowId, positions },
  );
}

test.describe('Canvas productivity (round 5)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('TC-CAN-007: scatter 6 nodes → Auto-arrange → no overlaps, left to right, saved', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input', 'agent', 'model', 'output', 'agent', 'model']);
    const [inp, agent, model, out, agent2, model2] = seeded.nodeIds as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    await connect(page, seeded.workflowId, inp, 'text', agent, 'text');
    await connect(page, seeded.workflowId, agent, 'text', model, 'text');
    await connect(page, seeded.workflowId, model, 'text', out, 'text');
    await connect(page, seeded.workflowId, agent2, 'text', model2, 'text');
    // scattered and piled up: the output far left, everything overlapping somewhere
    await placeNodes(page, seeded.workflowId, {
      [out]: { x: 0, y: 0 },
      [model]: { x: 40, y: 30 },
      [agent]: { x: 600, y: 300 },
      [inp]: { x: 620, y: 320 },
      [model2]: { x: 60, y: 400 },
      [agent2]: { x: 900, y: 20 },
    });
    await openWorkflow(page, seeded);
    await expect(page.locator('.react-flow__node')).toHaveCount(6);
    const before = (await serverGraph(page, seeded.workflowId)).version;

    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await expect
      .poll(async () => (await serverGraph(page, seeded.workflowId)).version)
      .toBeGreaterThan(before);
    await quiet(page, seeded.workflowId);
    // one batch → one version bump
    expect((await serverGraph(page, seeded.workflowId)).version).toBe(before + 1);
    await page.waitForTimeout(400); // the fit-view animation

    // no two cards overlap on screen
    const boxes = await Promise.all(seeded.nodeIds.map((id) => flowNode(page, id).boundingBox()));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap, `${i} and ${j} overlap`).toBe(false);
      }
    }

    // every edge points right, on screen and in the engine's positions
    const server = await serverGraph(page, seeded.workflowId);
    const pos = (id: string) => server.nodes.find((n) => n.id === id)!.position;
    for (const [from, to] of [
      [inp, agent],
      [agent, model],
      [model, out],
      [agent2, model2],
    ] as const) {
      expect(pos(from).x).toBeLessThan(pos(to).x);
      const a = (await flowNode(page, from).boundingBox())!;
      const b = (await flowNode(page, to).boundingBox())!;
      expect(a.x + a.width).toBeLessThan(b.x);
    }

    // free dragging still works after a layout
    const moved = pos(out);
    await dragBy(page, nodeCard(page, out), 60, 90);
    await expect
      .poll(async () => {
        const g = await serverGraph(page, seeded.workflowId);
        return g.nodes.find((n) => n.id === out)!.position.y;
      })
      .not.toBe(moved.y);
  });

  test('TC-CAN-008: add, move, connect → undo ×3 → redo ×3, each state matching the engine', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input']);
    const [inp] = seeded.nodeIds as [string];
    await openWorkflow(page, seeded);
    const states = [await snapshot(page, seeded.workflowId)];

    // 1. add
    await addFromDialog(page, 'agent');
    await settled(page, seeded.workflowId, 2);
    await quiet(page, seeded.workflowId);
    states.push(await snapshot(page, seeded.workflowId));
    const agent = states[1]!.nodes.find((n) => n.kind === 'agent')!.id;

    // 2. move
    // a one-node graph opened fully zoomed in, so fit both cards into the Canvas first — once the
    // new card is in place and selected (V2: selecting no longer opens its config)
    await expect(flowNode(page, agent)).toHaveClass(/selected/);
    await page.keyboard.press('f');
    await page.waitForTimeout(400);
    await dragBy(page, nodeCard(page, agent), 120, 140);
    await expect
      .poll(async () => (await snapshot(page, seeded.workflowId)).nodes)
      .not.toEqual(states[1]!.nodes);
    await quiet(page, seeded.workflowId);
    states.push(await snapshot(page, seeded.workflowId));

    // 3. connect — the V2 Canvas is shorter (fixed bottom panel), so the moved card can end up
    // below its edge: fit again (a view change, not an edit) and keep the port clear of the minimap
    await page.keyboard.press('f');
    await page.waitForTimeout(400);
    await clearOfMinimap(page, port(page, agent, 'in', 'text'));
    await dragConnect(page, port(page, inp, 'out', 'text'), port(page, agent, 'in', 'text'));
    await expect.poll(async () => (await snapshot(page, seeded.workflowId)).edges.length).toBe(1);
    await quiet(page, seeded.workflowId);
    states.push(await snapshot(page, seeded.workflowId));

    await page
      .getByTestId('canvas')
      .locator('.react-flow__pane')
      .click({ position: { x: 20, y: 20 } });

    for (const expected of [states[2], states[1], states[0]]) {
      await page.keyboard.press(`${MOD}+z`);
      await expect.poll(() => snapshot(page, seeded.workflowId)).toEqual(expected);
    }
    await expect(page.locator('.react-flow__node')).toHaveCount(1);

    for (const expected of [states[1], states[2], states[3]]) {
      await page.keyboard.press(`${MOD}+y`);
      await expect.poll(() => snapshot(page, seeded.workflowId)).toEqual(expected);
    }
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });

  test('TC-CAN-008: 10 edits undone then redone → graph identical to the engine’s', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input', 'agent', 'output']);
    const [inp, agent, out] = seeded.nodeIds as [string, string, string];
    await openWorkflow(page, seeded);
    const start = await snapshot(page, seeded.workflowId);

    const moves: Array<[string, number, number]> = [
      [inp, 40, 60],
      [agent, -30, 90],
      [out, 50, -40],
      [inp, 20, 30],
      [agent, 60, 20],
      [out, -40, 50],
      [inp, 30, -20],
    ];
    let edits = 0;
    for (const [id, dx, dy] of moves) {
      const before = await snapshot(page, seeded.workflowId);
      await dragBy(page, nodeCard(page, id), dx, dy);
      await expect.poll(() => snapshot(page, seeded.workflowId)).not.toEqual(before);
      edits += 1;
    }
    await dragConnect(page, port(page, inp, 'out', 'text'), port(page, agent, 'in', 'text'));
    await expect.poll(async () => (await snapshot(page, seeded.workflowId)).edges.length).toBe(1);
    edits += 1;
    await dragConnect(page, port(page, agent, 'out', 'text'), port(page, out, 'in', 'text'));
    await expect.poll(async () => (await snapshot(page, seeded.workflowId)).edges.length).toBe(2);
    edits += 1;
    await nodeCard(page, out).click();
    await page.keyboard.press(`${MOD}+d`);
    await expect.poll(async () => (await snapshot(page, seeded.workflowId)).nodes.length).toBe(4);
    edits += 1;
    expect(edits).toBe(10);
    await quiet(page, seeded.workflowId);
    const end = await snapshot(page, seeded.workflowId);

    await page
      .getByTestId('canvas')
      .locator('.react-flow__pane')
      .click({ position: { x: 20, y: 20 } });
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press(`${MOD}+z`);
      await page.waitForTimeout(150);
    }
    await expect.poll(() => snapshot(page, seeded.workflowId)).toEqual(start);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);

    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press(`${MOD}+Shift+z`);
      await page.waitForTimeout(150);
    }
    await expect.poll(() => snapshot(page, seeded.workflowId)).toEqual(end);
    await expect(page.locator('.react-flow__node'), 'nodes after redo').toHaveCount(4);
    await expect(page.locator('.react-flow__edge'), 'edges after redo').toHaveCount(2);
    // and the screen agrees with the engine after a reload
    await page.reload();
    await expect(page.locator('.react-flow__node'), 'nodes after reload').toHaveCount(4, {
      timeout: 15_000,
    });
    await expect(page.locator('.react-flow__edge'), 'edges after reload').toHaveCount(2, {
      timeout: 15_000,
    });
  });

  test('TC-CAN-010: Delete, Ctrl+D, Ctrl+A and F each work', async ({ page }) => {
    const seeded = await seedGraph(page, ['input', 'agent', 'output']);
    const [inp, agent] = seeded.nodeIds as [string, string, string];
    await openWorkflow(page, seeded);

    // Delete
    await nodeCard(page, agent).click();
    await page.keyboard.press('Delete');
    await settled(page, seeded.workflowId, 2);

    // Ctrl+D
    await nodeCard(page, inp).click();
    await page.keyboard.press(`${MOD}+d`);
    await settled(page, seeded.workflowId, 3);
    const kinds = (await serverGraph(page, seeded.workflowId)).nodes.map((n) => n.kind).sort();
    expect(kinds).toEqual(['input', 'input', 'output']);

    // Ctrl+A
    await page
      .getByTestId('canvas')
      .locator('.react-flow__pane')
      .click({ position: { x: 20, y: 20 } });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    await page.keyboard.press(`${MOD}+a`);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);

    // F: pan everything away, then fit
    const box = (await page.getByTestId('canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(4000, 3000);
    await page.waitForTimeout(200);
    await page.keyboard.press('f');
    await page.waitForTimeout(400);
    for (const node of await page.locator('.react-flow__node').all()) {
      const b = (await node.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(b.y).toBeGreaterThanOrEqual(box.y - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height + 1);
    }
  });

  test('FR-CAN-011: node, edge and empty-Canvas menus each show their actions', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input', 'agent']);
    const [inp, agent] = seeded.nodeIds as [string, string];
    await connect(page, seeded.workflowId, inp, 'text', agent, 'text');
    await openWorkflow(page, seeded);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    // node
    await nodeCard(page, agent).click({ button: 'right' });
    const nodeMenu = page.getByTestId('node-context-menu');
    await expect(nodeMenu).toBeVisible();
    for (const name of [/Duplicate/, /Copy/, /Configure/, /Delete/]) {
      await expect(nodeMenu.getByRole('menuitem', { name })).toBeVisible();
    }
    await nodeMenu.getByRole('menuitem', { name: /Duplicate/ }).click();
    await settled(page, seeded.workflowId, 3);

    // empty Canvas
    const box = (await page.getByTestId('canvas').boundingBox())!;
    // top-left: clear of the zoom controls (bottom-left), the minimap and the toolbar
    await page.mouse.click(box.x + 30, box.y + 30, { button: 'right' });
    const paneMenu = page.getByTestId('pane-context-menu');
    await expect(paneMenu).toBeVisible();
    for (const name of [/Paste/, /Add Agent/, /Select all/, /Auto-arrange/, /Fit view/]) {
      await expect(paneMenu.getByRole('menuitem', { name })).toBeVisible();
    }
    await paneMenu.getByRole('menuitem', { name: /Select all/ }).click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);

    // edge: the round 3 menu, unchanged
    await page
      .locator('.react-flow__edge')
      .first()
      .locator('path')
      .first()
      .click({ force: true, button: 'right' });
    const edgeMenu = page.getByRole('menu', { name: 'Connection actions' });
    await expect(edgeMenu).toBeVisible();
    await expect(edgeMenu.getByRole('menuitem', { name: 'Make loop edge' })).toBeVisible();
    await expect(edgeMenu.getByRole('menuitem', { name: 'Delete connection' })).toBeVisible();
  });

  test('FR-CAN-013: copy in workflow A, paste in B → new ids, same config', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const a = await seedGraph(page, ['input', 'agent'], { workflowName: 'A' });
    const b = await seedGraph(page, ['output'], { workflowName: 'B' });
    const [inp, agent] = a.nodeIds as [string, string];
    await connect(page, a.workflowId, inp, 'text', agent, 'text');
    // give the agent a config worth checking
    await page.evaluate(
      ({ workflowId, agent }) => {
        const db = window.__aceMock!.db;
        db.load();
        const nodes = db.nodesOf(workflowId).map((n) =>
          n.id === agent
            ? ({
                ...n,
                name: 'Haiku writer',
                config: { ...n.config, instructions: 'Write a haiku.' },
              } as typeof n)
            : n,
        );
        db.commitGraph(workflowId, nodes, db.edgesOf(workflowId), { silent: true });
      },
      { workflowId: a.workflowId, agent },
    );
    const source = await serverGraph(page, a.workflowId);

    await openWorkflow(page, a);
    await page
      .getByTestId('canvas')
      .locator('.react-flow__pane')
      .click({ position: { x: 20, y: 20 } });
    await page.keyboard.press(`${MOD}+a`);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    await page.keyboard.press(`${MOD}+c`);
    await expect(page.getByText('Copied 2 nodes')).toBeVisible();

    await openWorkflow(page, b);
    await page
      .getByTestId('canvas')
      .locator('.react-flow__pane')
      .click({ position: { x: 20, y: 20 } });
    await page.keyboard.press(`${MOD}+v`);
    await settled(page, b.workflowId, 3);
    await quiet(page, b.workflowId);

    const target = await serverGraph(page, b.workflowId);
    const pasted = target.nodes.filter((n) => n.kind !== 'output');
    expect(pasted).toHaveLength(2);
    for (const copy of pasted) {
      expect(source.nodes.some((n) => n.id === copy.id)).toBe(false);
      const original = source.nodes.find((n) => n.kind === copy.kind)!;
      expect(copy.name).toBe(original.name);
      expect(copy.config).toEqual(original.config);
    }
    expect(pasted.find((n) => n.kind === 'agent')!.name).toBe('Haiku writer');
    // the edge between them came along, rewired to the new ids
    expect(target.edges).toHaveLength(1);
    const ids = new Set(pasted.map((n) => n.id));
    expect(ids.has(target.edges[0]!.from.nodeId)).toBe(true);
    expect(ids.has(target.edges[0]!.to.nodeId)).toBe(true);
    // workflow A is untouched
    expect(await serverGraph(page, a.workflowId)).toEqual(source);
  });
});
