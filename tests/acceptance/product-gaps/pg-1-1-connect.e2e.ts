import { test, type Page } from '@playwright/test';

import {
  NOT_BUILT,
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
  seenOpacity,
  setCanvasZoom,
  seedAgents,
  settingsDialog,
  updateNodeConfig,
  useTheme,
  type Seeded,
  type Theme,
} from './helpers.js';

/**
 * PG-1.1 Draw a connection by hand (product-gaps prompt, Phase 1). Today a port is a 12 px handle
 * at `opacity: 0` (`packages/ui/src/theme.css`, `nodes/NodeCard.tsx` PortHandle), so there is
 * nothing to see or aim at; a drop on a card body connects nothing; a press beside a port lands on
 * the card. Red until PG-1.1 lands (Phase 0 item 5).
 */

async function twoAgents(label: string): Promise<Seeded> {
  const providerId = await mockProvider();
  return seedAgents(label, [
    { name: 'Writer', providerId, modelId: 'mock-text' },
    { name: 'Editor', providerId, modelId: 'mock-text' },
  ]);
}

const outOf = (flow: Seeded, name: string): string => flow.byName(name).outputs[0]?.id ?? '';
const inOf = (flow: Seeded, name: string): string => flow.byName(name).inputs[0]?.id ?? '';

/** Every card in view, nothing over the ports. */
async function ready(page: Page, flow: Seeded): Promise<void> {
  await openCanvas(page, flow.projectId, flow.workflowId);
  await expect(card(page, flow.byName('Editor').id)).toBeVisible({ timeout: 15_000 });
  await closeSettings(page);
  await fitView(page);
}

test.describe('PG-1.1 drag a line from an output to an input', () => {
  for (const theme of ['light', 'dark'] as Theme[]) {
    for (const zoom of [1, 0.5]) {
      test(`ports show on hover and while dragging, and out→in creates an edge (${theme}, ${zoom * 100}% zoom)`, async ({
        page,
      }) => {
        // PG-1.1: ports are invisible today (opacity 0), at every theme and zoom.
        test.fail(NOT_BUILT, 'PG-1.1: port handles are invisible (D332, X1)');
        await useTheme(page, theme);
        const flow = await twoAgents(`connect-${theme}-${zoom * 100}`);
        await ready(page, flow);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const reached = await setCanvasZoom(page, zoom);
        expect(Math.abs(reached - zoom), `the Canvas is at ${zoom * 100}%`).toBeLessThan(0.1);

        const writer = flow.byName('Writer');
        const out = port(page, outOf(flow, 'Writer'));
        const into = port(page, inOf(flow, 'Editor'));

        // Hover the card: its ports show (8 px dot, at least a 20 px target around it).
        await card(page, writer.id).hover();
        await expect
          .poll(() => seenOpacity(out), { message: 'the Writer output port shows on hover' })
          .toBeGreaterThan(0.5);
        const hit = await out.boundingBox();
        expect(hit?.width ?? 0, 'the port is a 20 px target at 100%').toBeGreaterThanOrEqual(
          20 * zoom,
        );

        // While a line is being drawn, every compatible input shows.
        const from = await centre(out);
        const to = await centre(into);
        await drag(page, from, to, {
          beforeDrop: async () => {
            expect(await seenOpacity(into), 'the compatible input shows mid-drag').toBeGreaterThan(
              0.5,
            );
          },
        });

        await expect
          .poll(async () => (await graphOf(flow.workflowId)).edges.length, {
            message: 'the drawn edge reaches the engine',
          })
          .toBe(1);
      });
    }
  }

  test('a line dropped on a card body connects to its first compatible input', async ({ page }) => {
    // PG-1.1: "Drop on the card" does not exist — only a drop on the (invisible) handle connects.
    test.fail(NOT_BUILT, 'PG-1.1: a drop on a card body connects nothing');
    const flow = await twoAgents('drop-on-card');
    await ready(page, flow);

    const editor = card(page, flow.byName('Editor').id);
    const box = await editor.boundingBox();
    if (box === null) throw new Error('the Editor card has no box');
    // The middle of the card, well away from its input port on the left edge.
    await drag(page, await centre(port(page, outOf(flow, 'Writer'))), {
      x: box.x + box.width * 0.6,
      y: box.y + box.height * 0.5,
    });

    await expect
      .poll(async () => (await graphOf(flow.workflowId)).edges.length, {
        message: 'a drop on the card body made an edge',
      })
      .toBe(1);
    const edge = (await graphOf(flow.workflowId)).edges[0];
    expect(edge?.to.portId).toBe(inOf(flow, 'Editor'));
  });

  test('a refused drop shows its reason: incompatible ports dim with the reason while dragging', async ({
    page,
  }) => {
    // PG-1.1: "Incompatible ports dim, with the reason in a tooltip" — today they stay invisible.
    test.fail(NOT_BUILT, 'PG-1.1: incompatible ports are not shown dimmed with a reason');
    const flow = await twoAgents('refused');
    // An image-only input, as a workflow saved before D285 can hold (TC-CON-002).
    await updateNodeConfig(flow.workflowId, flow.byName('Editor').id, { inputTypes: ['image'] });
    const graph = await graphOf(flow.workflowId);
    const imageIn = graph.nodes.find((node) => node.name === 'Editor')?.inputs[0]?.id ?? '';
    await ready(page, flow);

    const target = port(page, imageIn);
    await drag(page, await centre(port(page, outOf(flow, 'Writer'))), await centre(target), {
      beforeDrop: async () => {
        const seen = await seenOpacity(target);
        expect(seen, 'the incompatible input is shown, dimmed').toBeGreaterThan(0);
        expect(seen, 'the incompatible input is dimmed').toBeLessThan(0.9);
        await expect(page.getByRole('tooltip')).toContainText(/image/i);
      },
    });

    // Kept from today (FR-CON-002): the refusal toast with the reason, and nothing saved.
    await expect(page.getByText('Connection refused').first()).toBeVisible();
    await expect(page.getByText(/image/i).first()).toBeVisible();
    expect((await graphOf(flow.workflowId)).edges).toHaveLength(0);
  });

  test('a drag that starts on a port never opens settings', async ({ page }) => {
    // PG-1.1: a press 9 px inside the card from the port centre misses today's 12 px handle and
    // lands on the card, which then moves instead of drawing; the spec's 20 px target takes it.
    test.fail(NOT_BUILT, 'PG-1.1: a drag from beside a port lands on the card');
    const flow = await twoAgents('no-settings');
    await ready(page, flow);
    const writer = flow.byName('Writer');
    const before = (await graphOf(flow.workflowId)).nodes.find((n) => n.id === writer.id)?.position;

    const start = await centre(port(page, outOf(flow, 'Writer')));
    const press = { x: start.x - 9, y: start.y };
    const editorIn = await centre(port(page, inOf(flow, 'Editor')));
    await drag(page, press, editorIn);

    await expect(settingsDialog(page), 'no settings modal after a drag from a port').toHaveCount(0);
    const after = (await graphOf(flow.workflowId)).nodes.find((n) => n.id === writer.id)?.position;
    expect(after, 'the card did not move: the drag drew a line').toEqual(before);
    await expect
      .poll(async () => (await graphOf(flow.workflowId)).edges.length, {
        message: 'the drag from beside the port drew the edge',
      })
      .toBe(1);
  });
});
