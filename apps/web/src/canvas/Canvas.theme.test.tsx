import type { Edge, Node } from '@ace/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useViewportStore, type Viewport } from '../app/stores/viewport';
import { createNode } from '../nodes/factory';
import { db, installMockServer, renderWithQuery } from '../test/app';
import { peekGraphSync } from '../workflows/sync-registry';
import { Canvas } from './Canvas';
import { useCanvasApi } from './canvas-api';
import { useHistoryStore } from './interactions/history';
import {
  ZOOM_MAX,
  bounds,
  centreOn,
  fitView,
  miniGeo,
  miniJump,
  wheelView,
  zoomAt,
} from './viewport';

/*
 * D332: the theme's viewport, toolbar, minimap, Add node and click behaviour on the real Canvas.
 * jsdom has no layout, so React Flow reports a 500 × 500 canvas and no node is measured: every
 * card's rect is its kind's theme size (stage 210 × 280, document 200 × 170).
 */

installMockServer();

const CANVAS = 500;

beforeEach(() => {
  useHistoryStore.getState().clear();
  useViewportStore.setState({ viewports: {} });
});

function seed(kinds: Array<Parameters<typeof createNode>[0]> = ['input', 'agent']) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const nodes = kinds.map((kind, i) => createNode(kind, workflow.id, { x: i * 320, y: 0 }));
  const edges: Edge[] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const from = nodes[i - 1]!;
    const to = nodes[i]!;
    if (from.outputs[0] && to.inputs[0]) {
      edges.push({
        id: db.nextId(),
        workflowId: workflow.id,
        kind: 'data',
        from: { nodeId: from.id, portId: from.outputs[0].id },
        to: { nodeId: to.id, portId: to.inputs[0].id },
      });
    }
  }
  db.commitGraph(workflow.id, nodes, edges);
  return { project, workflow, nodes, edges };
}

async function mount(workflowId: string) {
  renderWithQuery(<Canvas workflowId={workflowId} />);
  await screen.findByTestId('canvas');
  await waitFor(() =>
    expect(document.querySelectorAll('.react-flow__node').length).toBeGreaterThan(0),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

const settle = (workflowId: string) => peekGraphSync(workflowId)?.whenIdle();
const saved = (workflowId: string): Viewport | undefined =>
  useViewportStore.getState().viewports[workflowId];
const card = (id: string) => screen.getByTestId(`node-card-${id}`);
const flowNode = (id: string) =>
  document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
const sameView = (a: Viewport | undefined, b: Viewport) => {
  expect(a?.zoom).toBeCloseTo(b.zoom);
  expect(a?.x).toBeCloseTo(b.x);
  expect(a?.y).toBeCloseTo(b.y);
};

/** The view the theme's `fit()` picks for these nodes on the 500 × 500 jsdom canvas. */
function fitted(nodes: Node[]): Viewport {
  const rects = nodes.map((n) => ({
    x: n.position.x,
    y: n.position.y,
    ...(n.kind === 'agent' || n.kind === 'model' ? { w: 210, h: 280 } : { w: 200, h: 170 }),
  }));
  return fitView(bounds(rects)!, CANVAS, CANVAS);
}

describe('D332 fit on first load', () => {
  it('fits the nodes (pad 80, zoom 0.25–1.4) when the workflow has no saved view', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    await waitFor(() => expect(saved(workflow.id)).toBeDefined());
    sameView(saved(workflow.id), fitted(nodes));
  });

  it('keeps a saved view instead', async () => {
    const { workflow } = seed(['input']);
    useViewportStore.getState().setViewport(workflow.id, { x: 7, y: 9, zoom: 0.5 });
    await mount(workflow.id);
    expect(screen.getByTestId('canvas-zoom-level')).toHaveTextContent('50%');
    expect(saved(workflow.id)).toEqual({ x: 7, y: 9, zoom: 0.5 });
  });
});

describe('D332 the wheel', () => {
  it('Ctrl+wheel zooms at the cursor by exp(−deltaY·0.01); a plain wheel pans', async () => {
    const { workflow, nodes } = seed(['input']);
    await mount(workflow.id);
    await waitFor(() => expect(saved(workflow.id)).toBeDefined());
    const start = fitted(nodes);

    act(() => {
      fireEvent.wheel(screen.getByTestId('canvas'), {
        deltaY: 40,
        ctrlKey: true,
        clientX: 120,
        clientY: 80,
      });
    });
    const zoomed = wheelView(
      start,
      { deltaX: 0, deltaY: 40, ctrlKey: true, metaKey: false },
      120,
      80,
    );
    await waitFor(() => expect(saved(workflow.id)?.zoom).toBeCloseTo(zoomed.zoom));
    sameView(saved(workflow.id), zoomed);

    act(() => {
      fireEvent.wheel(screen.getByTestId('canvas'), { deltaX: 15, deltaY: -30 });
    });
    await waitFor(() => expect(saved(workflow.id)?.x).toBeCloseTo(zoomed.x - 15));
    sameView(saved(workflow.id), { ...zoomed, x: zoomed.x - 15, y: zoomed.y + 30 });
  });

  it('is not the Canvas’s inside a dialog or the settings modal', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    await waitFor(() => expect(saved(workflow.id)).toBeDefined());
    const before = saved(workflow.id);
    const modal = document.createElement('div');
    modal.setAttribute('data-cfg', '');
    screen.getByTestId('canvas').appendChild(modal);
    const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    act(() => {
      modal.dispatchEvent(event);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(event.defaultPrevented).toBe(false);
    expect(saved(workflow.id)).toEqual(before);
    modal.remove();
  });
});

describe('D332 the toolbar', () => {
  it('+ and − zoom ×1.2 at the centre; the percentage resets to 100%', async () => {
    const { workflow, nodes } = seed(['input']);
    await mount(workflow.id);
    await waitFor(() => expect(saved(workflow.id)).toBeDefined());
    const start = fitted(nodes);

    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    const out = zoomAt(start, 1 / 1.2, CANVAS / 2, CANVAS / 2);
    await waitFor(() => expect(saved(workflow.id)?.zoom).toBeCloseTo(out.zoom));
    sameView(saved(workflow.id), out);

    await userEvent.click(screen.getByRole('button', { name: 'Reset to 100%' }));
    await waitFor(() => expect(saved(workflow.id)?.zoom).toBeCloseTo(1));
    expect(screen.getByTestId('canvas-zoom-level')).toHaveTextContent('100%');

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(saved(workflow.id)?.zoom).toBeCloseTo(1.2));
    expect(screen.getByTestId('canvas-zoom-level')).toHaveTextContent('120%');

    // never past 2.5
    for (let i = 0; i < 8; i += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    }
    await waitFor(() => expect(saved(workflow.id)?.zoom).toBeCloseTo(ZOOM_MAX));

    await userEvent.click(screen.getByRole('button', { name: 'Fit to view' }));
    await waitFor(() => expect(saved(workflow.id)?.zoom).toBeCloseTo(start.zoom));
  });

  it('lock stops dragging and panning from a card, and a click still opens its settings', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    const lock = screen.getByRole('button', { name: 'Lock nodes' });
    expect(lock).toHaveAttribute('aria-pressed', 'false');
    // PG-1.2 (D360): SVG lock icons, not the 🔓︎ 🔒︎ glyphs
    expect(lock.querySelector('[data-icon="lock-open"]')).not.toBeNull();
    expect(flowNode(nodes[1]!.id)).toHaveClass('draggable');

    await userEvent.click(lock);
    expect(lock).toHaveAttribute('aria-pressed', 'true');
    expect(lock.querySelector('[data-icon="lock"]')).not.toBeNull();
    // PG-1.2 (D360): the AA accent token, not #ef6b3f (2.7:1 as an icon)
    expect(lock.style.color).toBe('var(--accent-ink)');
    expect(flowNode(nodes[1]!.id)).not.toHaveClass('draggable');
    expect(flowNode(nodes[1]!.id)).toHaveClass('nopan');

    fireEvent.click(card(nodes[1]!.id));
    expect(usePanelsStore.getState().settings).toEqual({ kind: 'node', id: nodes[1]!.id });
  });

  it('the hand pans from anywhere: nothing drags, nothing selects, no settings open', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    const hand = screen.getByRole('button', { name: 'Hand tool' });
    await userEvent.click(hand);
    expect(hand).toHaveAttribute('aria-pressed', 'true');
    // PG-1.2 (D360): white on #ef6b3f measured 2.9:1; the AA accent token carries it
    expect(hand.style.background).toBe('var(--accent-strong)');
    expect(screen.getByTestId('canvas').style.cursor).toBe('grab');
    const node = flowNode(nodes[1]!.id);
    expect(node).not.toHaveClass('draggable');
    expect(node).not.toHaveClass('selectable');
    // a press on a card reaches the pan, since the card is no longer `nopan`
    expect(node).not.toHaveClass('nopan');

    fireEvent.click(card(nodes[1]!.id));
    expect(usePanelsStore.getState().settings).toBeUndefined();
    expect(useSelectionStore.getState().nodeIds).toEqual([]);
  });

  it('undo-move puts back the positions from before the last drag, through the graph', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    const undo = screen.getByRole('button', { name: 'Undo move' });
    expect(undo).toHaveAttribute('aria-disabled', 'true');
    expect(undo.style.color).toBe('var(--iconLine)');

    // React Flow drags through d3-drag, which reads `event.view`; jsdom refuses its own window in
    // MouseEventInit, so the view is set on the event itself.
    const mouse = (type: string, target: EventTarget, x: number, y: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      });
      Object.defineProperty(event, 'view', { value: window });
      act(() => {
        target.dispatchEvent(event);
      });
    };
    const target = nodes[1]!;
    mouse('mousedown', card(target.id), 10, 10);
    mouse('mousemove', window, 60, 40);
    mouse('mousemove', window, 110, 70);
    mouse('mouseup', window, 110, 70);
    await settle(workflow.id);
    const moved = db.nodesOf(workflow.id).find((n) => n.id === target.id)!.position;
    expect(moved).not.toEqual(target.position);
    await waitFor(() => expect(undo).toHaveAttribute('aria-disabled', 'false'));
    expect(undo.style.color).toBe('var(--ink)');

    await userEvent.click(undo);
    await settle(workflow.id);
    expect(db.nodesOf(workflow.id).find((n) => n.id === target.id)!.position).toEqual(
      target.position,
    );
    expect(undo).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('D332 the minimap', () => {
  it('a press centres the canvas on the world point under it', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    await waitFor(() => expect(saved(workflow.id)).toBeDefined());
    const view = fitted(nodes);
    const rects = nodes.map((n) => ({
      x: n.position.x,
      y: n.position.y,
      ...(n.kind === 'agent' ? { w: 210, h: 280 } : { w: 200, h: 170 }),
    }));
    // jsdom puts the minimap's box at 0,0: the press lands 40, 30 inside its padding
    const expected = miniJump(
      view,
      miniGeo(bounds(rects), view, CANVAS, CANVAS),
      40,
      30,
      CANVAS,
      CANVAS,
    );
    act(() => {
      fireEvent.mouseDown(screen.getByTestId('canvas-minimap'), { clientX: 46, clientY: 36 });
    });
    await waitFor(() => expect(saved(workflow.id)?.x).toBeCloseTo(expected.x));
    sameView(saved(workflow.id), expected);
    act(() => {
      fireEvent.mouseUp(window);
    });
  });

  it('draws one block per node: stages in their provider colour, documents in --iconLine', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    expect(screen.getByTestId(`minimap-node-${nodes[0]!.id}`).style.background).toBe(
      'var(--iconLine)',
    );
    // no provider: the Custom look, white
    expect(screen.getByTestId(`minimap-node-${nodes[1]!.id}`).style.background).toBe(
      'rgb(255, 255, 255)',
    );
    expect(screen.getByTestId('minimap-view').className).toContain('border-[#ef6b3f]');
  });
});

describe('D332 click to open settings', () => {
  it('a click on a card selects it and opens its settings; Shift-click only adds to the selection', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    fireEvent.click(card(nodes[1]!.id));
    expect(useSelectionStore.getState().nodeIds).toEqual([nodes[1]!.id]);
    expect(usePanelsStore.getState().settings).toEqual({ kind: 'node', id: nodes[1]!.id });

    act(() => usePanelsStore.getState().closeSettings());
    fireEvent.click(card(nodes[0]!.id), { shiftKey: true });
    expect(usePanelsStore.getState().settings).toBeUndefined();
  });

  it('a double-click does the same', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    fireEvent.doubleClick(card(nodes[0]!.id));
    expect(usePanelsStore.getState().settings).toEqual({ kind: 'node', id: nodes[0]!.id });
  });

  it('a click on a port is not a click on the card', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    fireEvent.click(screen.getByTestId(`port-${nodes[1]!.outputs[0]!.id}`));
    expect(usePanelsStore.getState().settings).toBeUndefined();
  });
});

describe('D332 Add node', () => {
  it('adds a linked "New agent" after the last stage, as one undo step, then opens its settings', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    db.setProviderStatus(provider.id, 'CONNECTED');
    await mount(workflow.id);
    const last = nodes[1]!;

    await userEvent.click(screen.getByTestId('new-node-button'));
    await settle(workflow.id);
    const added = db.nodesOf(workflow.id).find((n) => !nodes.some((o) => o.id === n.id))!;
    expect(added.kind).toBe('agent');
    expect(added.name).toBe('New agent');
    // the second stage: k = 2 is even, so 50 up
    expect(added.position).toEqual({ x: last.position.x + 320, y: last.position.y - 50 });
    expect(added.kind === 'agent' && added.config.providerId).toBe(provider.id);
    expect(added.kind === 'agent' && added.config.modelId).toEqual(expect.any(String));
    expect(
      db
        .edgesOf(workflow.id)
        .some((e) => e.from.nodeId === last.id && e.to.nodeId === added.id && e.kind === 'data'),
    ).toBe(true);
    expect(useSelectionStore.getState().nodeIds).toEqual([added.id]);
    expect(usePanelsStore.getState().settings).toEqual({ kind: 'node', id: added.id });
    await waitFor(() =>
      sameView(
        saved(workflow.id),
        centreOn(
          saved(workflow.id) ?? { x: 0, y: 0, zoom: 1 },
          added.position.x + 105,
          added.position.y + 140,
          CANVAS,
          CANVAS,
        ),
      ),
    );

    // one undo step takes back the node and its edge together
    act(() => {
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    });
    await settle(workflow.id);
    expect(
      db
        .nodesOf(workflow.id)
        .map((n) => n.id)
        .sort(),
    ).toEqual(nodes.map((n) => n.id).sort());
    expect(db.edgesOf(workflow.id)).toHaveLength(1);
  });
});

describe('D333 removeNodeReconnecting', () => {
  it('removes the node and joins its incoming edge to its outgoing one, as one undo step', async () => {
    const { workflow, nodes } = seed(['input', 'agent', 'output']);
    await mount(workflow.id);
    const [input, agent, output] = nodes as [Node, Node, Node];
    act(() => useCanvasApi.getState().api?.removeNodeReconnecting?.(agent.id));
    await settle(workflow.id);
    expect(db.nodesOf(workflow.id).map((n) => n.id)).not.toContain(agent.id);
    const edges = db.edgesOf(workflow.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from: { nodeId: input.id, portId: input.outputs[0]!.id },
      to: { nodeId: output.id },
    });

    act(() => {
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    });
    await settle(workflow.id);
    expect(db.nodesOf(workflow.id).map((n) => n.id)).toContain(agent.id);
    expect(db.edgesOf(workflow.id)).toHaveLength(2);
  });
});

describe('D331 the breadcrumb', () => {
  it('HOME → Home, the project’s name in the pill (uppercase in CSS only), then the workspace menu', async () => {
    const { project, workflow } = seed(['input']);
    renderWithQuery(
      <MemoryRouter initialEntries={[`/projects/${project.id}/workflows/${workflow.id}`]}>
        <Routes>
          <Route
            path="/projects/:projectId/workflows/:workflowId"
            element={<Canvas workflowId={workflow.id} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(crumb).toHaveClass('left-[18px]', 'top-[14px]', 'font-machine', 'text-[10px]');
    expect(within(crumb).getByRole('link', { name: 'HOME' })).toHaveAttribute('href', '/projects');
    const name = within(crumb).getByTestId('project-name');
    await waitFor(() => expect(name).toHaveTextContent(project.name));
    expect(name.textContent).toBe(project.name);
    expect(name).toHaveClass('uppercase', 'border-[var(--ink)]');
    // the workspace menu's "…" comes right after the project
    expect(name.nextElementSibling).toBe(within(crumb).getByTestId('workspace-menu'));
  });

  it('a bare Canvas (no router around it) has none', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });
});

describe('D332 the edge layer on the Canvas', () => {
  it('labels each data edge with its source port’s data type, above the nodes', async () => {
    const { workflow, edges } = seed(['input', 'agent']);
    await mount(workflow.id);
    const label = await screen.findByTestId(`edge-label-${edges[0]!.id}`);
    expect(label).toHaveTextContent('text');
    expect(
      screen.getByTestId('canvas-edges').closest('.react-flow__viewport-portal'),
    ).not.toBeNull();
  });

  it('stage cards are numbered in graph order', async () => {
    const { workflow, nodes } = seed(['input', 'agent', 'agent']);
    await mount(workflow.id);
    expect(screen.getByTestId(`stage-label-${nodes[1]!.id}`)).toHaveTextContent('STAGE 1 · AGENT');
    expect(screen.getByTestId(`stage-label-${nodes[2]!.id}`)).toHaveTextContent('STAGE 2 · AGENT');
    expect(screen.getByTestId(`node-attached-${nodes[0]!.id}`)).toHaveTextContent(
      'Attached to Stage 1',
    );
  });
});
