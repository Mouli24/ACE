import type { Edge, Node } from '@ace/contracts';
import { Toaster } from '@ace/ui';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { createNode } from '../nodes/factory';
import { db, installMockServer, renderWithQuery } from '../test/app';
import { peekGraphSync } from '../workflows/sync-registry';
import { Canvas } from './Canvas';
import { useCanvasApi } from './canvas-api';
import { clearClipboard } from './interactions/clipboard';
import { useHistoryStore } from './interactions/history';

installMockServer();

beforeEach(() => {
  useHistoryStore.getState().clear();
  clearClipboard();
});

/** An Agent/Model on a mock provider — a node with none would make Duplicate ask first (D351). */
function onProvider(node: Node, providerId: string): Node {
  return node.kind === 'agent' || node.kind === 'model'
    ? ({ ...node, config: { ...node.config, providerId, modelId: 'mock-text' } } as Node)
    : node;
}

function seed(kinds: Array<Parameters<typeof createNode>[0]> = ['input', 'agent']) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });
  const nodes = kinds.map((kind, i) =>
    onProvider(createNode(kind, workflow.id, { x: i * 300, y: 0 }), provider.id),
  );
  const edges: Edge[] =
    nodes.length >= 2
      ? [
          {
            id: db.nextId(),
            workflowId: workflow.id,
            kind: 'data',
            from: { nodeId: nodes[0]!.id, portId: nodes[0]!.outputs[0]!.id },
            to: { nodeId: nodes[1]!.id, portId: nodes[1]!.inputs[0]!.id },
          },
        ]
      : [];
  db.commitGraph(workflow.id, nodes, edges);
  return { project, workflow, nodes, edges };
}

async function mount(workflowId: string, readOnly = false) {
  renderWithQuery(<Canvas workflowId={workflowId} readOnly={readOnly} />);
  await screen.findByTestId('canvas');
  await waitFor(() =>
    expect(document.querySelectorAll('.react-flow__node').length).toBeGreaterThan(0),
  );
  // let React Flow report its initial (empty) selection before a test starts selecting
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

const settle = (workflowId: string) => peekGraphSync(workflowId)?.whenIdle();
const nodesInDb = (workflowId: string): Node[] => db.nodesOf(workflowId);
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });
const flowNode = (id: string) =>
  document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;

describe('TC-CAN-010 shortcuts (FR-CAN-012)', () => {
  it('Ctrl+A selects every node, Ctrl+D duplicates them, Ctrl+Z / Ctrl+Y / Cmd+Z / Ctrl+Shift+Z step through it', async () => {
    const { workflow } = seed(['input', 'agent', 'output']);
    await mount(workflow.id);

    press('a', { ctrlKey: true });
    expect(useSelectionStore.getState().nodeIds).toHaveLength(3);

    press('d', { ctrlKey: true });
    await settle(workflow.id);
    expect(nodesInDb(workflow.id)).toHaveLength(6);

    press('z', { ctrlKey: true });
    await settle(workflow.id);
    expect(nodesInDb(workflow.id)).toHaveLength(3);

    press('y', { ctrlKey: true });
    await settle(workflow.id);
    expect(nodesInDb(workflow.id)).toHaveLength(6);

    press('z', { metaKey: true });
    await settle(workflow.id);
    expect(nodesInDb(workflow.id)).toHaveLength(3);
    press('z', { ctrlKey: true, shiftKey: true });
    await settle(workflow.id);
    expect(nodesInDb(workflow.id)).toHaveLength(6);
  });

  it('Ctrl+D is swallowed even with nothing selected (no bookmark dialog)', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    const event = new KeyboardEvent('keydown', {
      key: 'd',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(nodesInDb(workflow.id)).toHaveLength(1);
  });

  it('ignores shortcuts typed into an editable field', async () => {
    const { workflow } = seed(['input', 'agent']);
    await mount(workflow.id);
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      fireEvent.keyDown(input, { key: 'a', ctrlKey: true });
    });
    expect(useSelectionStore.getState().nodeIds).toHaveLength(0);
    input.remove();
  });

  it('Ctrl+C then Ctrl+V pastes copies with new ids and the edge between them, one undo step', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    press('a', { ctrlKey: true });
    press('c', { ctrlKey: true });
    press('v', { ctrlKey: true });
    await settle(workflow.id);
    const after = nodesInDb(workflow.id);
    expect(after).toHaveLength(4);
    expect(db.edgesOf(workflow.id)).toHaveLength(2);
    const fresh = after.filter((n) => !nodes.some((o) => o.id === n.id));
    expect(fresh.map((n) => n.kind).sort()).toEqual(['agent', 'input']);

    press('z', { ctrlKey: true });
    await settle(workflow.id);
    expect(nodesInDb(workflow.id)).toHaveLength(2);
    expect(db.edgesOf(workflow.id)).toHaveLength(1);
  });
});

describe('TC-CAN-008 deleting is one undoable step (FR-CAN-009)', () => {
  it('Delete removes the node and its edge; undo restores both with the same ids and config', async () => {
    const { workflow, nodes, edges } = seed(['input', 'agent']);
    await mount(workflow.id);
    act(() => useSelectionStore.getState().setSelection([nodes[1]!.id], []));
    await waitFor(() => expect(flowNode(nodes[1]!.id)).toHaveClass('selected'));
    act(() => {
      fireEvent.keyDown(flowNode(nodes[1]!.id), { key: 'Delete' });
    });
    await waitFor(() => expect(nodesInDb(workflow.id)).toHaveLength(1));
    await settle(workflow.id);
    expect(db.edgesOf(workflow.id)).toHaveLength(0);

    // the tools pill is gone (D332): Ctrl+Z / Ctrl+Y are the general undo and redo
    press('z', { ctrlKey: true });
    await settle(workflow.id);
    expect(nodesInDb(workflow.id).find((n) => n.id === nodes[1]!.id)?.config).toEqual(
      nodes[1]!.config,
    );
    expect(db.edgesOf(workflow.id).map((e) => e.id)).toEqual(edges.map((e) => e.id));

    press('y', { ctrlKey: true });
    await settle(workflow.id);
    expect(nodesInDb(workflow.id)).toHaveLength(1);
  });
});

describe('[audit W-6] a delete says what went and offers Undo', () => {
  it('Delete shows "Node deleted" with Undo, and Undo brings the node and its edge back', async () => {
    const { workflow, nodes, edges } = seed(['input', 'agent']);
    renderWithQuery(
      <>
        <Canvas workflowId={workflow.id} />
        <Toaster />
      </>,
    );
    await waitFor(() => expect(flowNode(nodes[1]!.id)).not.toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    act(() => useSelectionStore.getState().setSelection([nodes[1]!.id], []));
    await waitFor(() => expect(flowNode(nodes[1]!.id)).toHaveClass('selected'));
    act(() => {
      fireEvent.keyDown(flowNode(nodes[1]!.id), { key: 'Delete' });
    });
    await waitFor(() => expect(nodesInDb(workflow.id)).toHaveLength(1));
    await settle(workflow.id);

    const [message] = await screen.findAllByText('Node deleted');
    const toast = message!.closest('[data-sonner-toast]') as HTMLElement;
    await userEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(nodesInDb(workflow.id)).toHaveLength(2));
    await settle(workflow.id);
    expect(db.edgesOf(workflow.id).map((e) => e.id)).toEqual(edges.map((e) => e.id));
  });
});

describe('TC-CAN-007 auto-arrange (FR-CAN-008)', () => {
  it('moves every node in one batch, left to right, and is one undo step', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    // scatter: the agent sits left of its input
    db.commitGraph(
      workflow.id,
      [
        { ...nodes[0]!, position: { x: 900, y: 400 } },
        { ...nodes[1]!, position: { x: 0, y: 0 } },
      ],
      db.edgesOf(workflow.id),
    );
    await mount(workflow.id);
    const before = db.getWorkflow(workflow.id)!.version;

    // the tools pill is gone (D332): Auto-arrange lives in the empty Canvas's menu
    fireEvent.contextMenu(document.querySelector('.react-flow__pane') as HTMLElement);
    await userEvent.click(await screen.findByRole('menuitem', { name: /Auto-arrange/ }));
    await settle(workflow.id);
    const [input, agent] = [nodes[0]!.id, nodes[1]!.id].map((id) =>
      nodesInDb(workflow.id).find((n) => n.id === id)!,
    );
    expect(input!.position.x).toBeLessThan(agent!.position.x);
    expect(db.getWorkflow(workflow.id)!.version).toBe(before + 1);

    press('z', { ctrlKey: true });
    await settle(workflow.id);
    expect(nodesInDb(workflow.id).find((n) => n.id === nodes[0]!.id)!.position).toEqual({
      x: 900,
      y: 400,
    });
  });
});

describe('FR-CAN-011 right-click menus', () => {
  it('a node offers Duplicate, Copy, Settings, Inspect and Delete', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    fireEvent.contextMenu(flowNode(nodes[1]!.id));
    const menu = await screen.findByTestId('node-context-menu');
    for (const name of [/Duplicate/, /Copy/, /Settings/, /Inspect/, /Delete/]) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    expect(menu).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    await settle(workflow.id);
    expect(nodesInDb(workflow.id).map((n) => n.id)).toEqual([nodes[0]!.id]);
  });

  it('Duplicate leaves the copy selected, from the menu and from Ctrl+D', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    const copyOf = async (originals: string[]) => {
      await settle(workflow.id);
      const known = new Set(originals);
      return nodesInDb(workflow.id).filter((n) => !known.has(n.id));
    };

    fireEvent.contextMenu(flowNode(nodes[1]!.id));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Duplicate/ }));
    const [fromMenu] = await copyOf(nodes.map((n) => n.id));
    // React Flow's echo of "nothing selected", sent before the copy reached it, used to win
    await waitFor(() => expect(flowNode(fromMenu!.id)).toHaveClass('selected'));
    expect(useSelectionStore.getState().nodeIds).toEqual([fromMenu!.id]);

    press('d', { ctrlKey: true });
    const [fromKey] = await copyOf([...nodes.map((n) => n.id), fromMenu!.id]);
    await waitFor(() => expect(flowNode(fromKey!.id)).toHaveClass('selected'));
    expect(useSelectionStore.getState().nodeIds).toEqual([fromKey!.id]);
  });

  it('PG-1.3 duplicating an Agent with no provider asks for one; Cancel copies nothing', async () => {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    const bare = createNode('agent', workflow.id, { x: 0, y: 0 });
    db.commitGraph(workflow.id, [bare], []);
    await mount(workflow.id);

    fireEvent.contextMenu(flowNode(bare.id));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Duplicate/ }));
    let picker = await screen.findByRole('dialog', { name: /provider/i });
    await userEvent.click(within(picker).getByRole('button', { name: 'Cancel' }));
    await settle(workflow.id);
    expect(nodesInDb(workflow.id)).toHaveLength(1);

    fireEvent.contextMenu(flowNode(bare.id));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Duplicate/ }));
    picker = await screen.findByRole('dialog', { name: /provider/i });
    await userEvent.click(await within(picker).findByRole('option', { name: /Mock/ }));
    await userEvent.click(await within(picker).findByRole('option', { name: /Mock JSON/ }));
    await userEvent.click(within(picker).getByRole('button', { name: 'Duplicate' }));
    await settle(workflow.id);
    const copy = nodesInDb(workflow.id).find((n) => n.id !== bare.id);
    expect(copy?.kind === 'agent' && copy.config.providerId).toBe(provider.id);
    expect(copy?.kind === 'agent' && copy.config.modelId).toBe('mock-json');
  });

  it('D332 Settings opens the node settings modal; Inspect opens the workflow panel’s Inspector', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    fireEvent.contextMenu(flowNode(nodes[1]!.id));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Settings/ }));
    expect(usePanelsStore.getState().settings).toEqual({ kind: 'node', id: nodes[1]!.id });

    act(() => usePanelsStore.getState().closeSettings());
    fireEvent.contextMenu(flowNode(nodes[0]!.id));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Inspect/ }));
    expect(useSelectionStore.getState().nodeIds).toEqual([nodes[0]!.id]);
    expect(usePanelsStore.getState()).toMatchObject({ sheetOpen: true, sheetTab: 'inspect' });
    expect(usePanelsStore.getState().settings).toBeUndefined();
  });

  it('the empty Canvas offers Paste, Add node kinds, Select all, Auto-arrange and Fit view', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    fireEvent.contextMenu(document.querySelector('.react-flow__pane') as HTMLElement);
    await screen.findByTestId('pane-context-menu');
    for (const name of [/Paste/, /Add Agent/, /Select all/, /Auto-arrange/, /Fit view/]) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    // nothing copied yet
    expect(screen.getByRole('menuitem', { name: /Paste/ })).toHaveAttribute('data-disabled');
    await userEvent.click(screen.getByRole('menuitem', { name: /Add Agent/ }));
    // D351 (PG-1.3): an Agent waits for its provider and model
    const picker = await screen.findByRole('dialog', { name: /provider/i });
    expect(nodesInDb(workflow.id)).toHaveLength(1);
    await userEvent.click(await within(picker).findByRole('option', { name: /Mock/ }));
    await userEvent.click(await within(picker).findByRole('option', { name: /Mock text/ }));
    await userEvent.click(within(picker).getByRole('button', { name: 'Add node' }));
    await settle(workflow.id);
    expect(
      nodesInDb(workflow.id)
        .map((n) => n.kind)
        .sort(),
    ).toEqual(['agent', 'input']);
  });

  it('the toolbar, minimap and Add node get no menu', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Fit to view' }));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('canvas-minimap'));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('new-node-button'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('D332 the Canvas chrome is the theme’s', () => {
  it('the theme toolbar, minimap and Add node replace React Flow’s controls, background and minimap', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    expect(document.querySelector('.react-flow__controls')).toBeNull();
    expect(document.querySelector('.react-flow__background')).toBeNull();
    expect(document.querySelector('.react-flow__minimap')).toBeNull();
    expect(document.querySelector('.react-flow__attribution')).toBeNull();
    // the tools pill (Undo, Redo, Auto-arrange, Duplicate) and the zoom pill are gone
    expect(screen.queryByTestId('canvas-tools-pill')).toBeNull();
    expect(screen.queryByTestId('canvas-zoom-pill')).toBeNull();
    for (const name of ['Auto-arrange', 'Duplicate selected nodes']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }

    const toolbar = screen.getByTestId('canvas-toolbar');
    expect(toolbar).toHaveClass('left-[18px]', 'bottom-[16px]', 'rounded-[10px]', 'p-[4px]');
    expect(
      Array.from(toolbar.querySelectorAll('button')).map((b) => b.getAttribute('title')),
    ).toEqual([
      'Zoom in',
      'Zoom out',
      'Reset to 100%',
      'Fit to screen',
      'Lock nodes',
      'Hand tool',
      'Undo move',
      // [audit W-6] general undo and redo are on the toolbar, not only Ctrl+Z / Ctrl+Y
      'Undo (Ctrl+Z)',
      'Redo (Ctrl+Y)',
    ]);
    expect(screen.getByTestId('canvas-zoom-level')).toHaveTextContent(/^\d+%$/);

    const minimap = screen.getByTestId('canvas-minimap');
    expect(minimap).toHaveClass('right-[16px]', 'bottom-[16px]', 'h-[116px]', 'w-[172px]');
    expect(minimap).toHaveTextContent('MAP');

    const add = screen.getByTestId('new-node-button');
    expect(add).toHaveAttribute('title', 'Add an agent node');
    expect(add).toHaveTextContent('+Add node');
  });

  it('draws the theme’s glows and dot grid on the canvas colour, with no text selection', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    const canvas = screen.getByTestId('canvas');
    expect(canvas).toHaveClass('bg-[var(--canvas)]', 'select-none');
    const grid = screen.getByTestId('canvas-grid');
    expect(grid.style.backgroundImage).toContain('radial-gradient');
    expect(grid.style.backgroundSize).toMatch(/^[\d.]+px [\d.]+px$/);
  });

  it('has one Fit control, named "Fit to view" and titled "Fit to screen"; F still fits', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    const fits = screen.getAllByRole('button', { name: /fit/i });
    expect(fits).toHaveLength(1);
    const [fit] = fits as [HTMLElement];
    expect(fit).toHaveAccessibleName('Fit to view');
    expect(fit).toHaveAttribute('title', 'Fit to screen');
    // PG-1.2 (D360): an SVG icon, not the ⛶ glyph
    expect(fit.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByTestId('canvas-toolbar')).toContainElement(fit);
    // F is still the Canvas's own fit shortcut: it handles (and so cancels) the key
    let notCancelled = true;
    act(() => {
      notCancelled = fireEvent.keyDown(document.body, { key: 'f' });
    });
    expect(notCancelled).toBe(false);
  });
});

describe('FR-MOB-003 readOnly Canvas', () => {
  it('hides editing, ignores editing shortcuts and offers only look-only menu items', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id, true);
    expect(screen.getByTestId('canvas')).toHaveAttribute('data-readonly', 'true');
    expect(screen.queryByRole('button', { name: 'Auto-arrange' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Fit to view' })).toBeInTheDocument();
    // nothing left to edit with: no Add node, no lock, no undo-move
    expect(screen.queryByTestId('new-node-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock nodes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo move' })).toBeNull();
    expect(useCanvasApi.getState().api?.readOnly).toBe(true);

    press('a', { ctrlKey: true });
    expect(useSelectionStore.getState().nodeIds).toHaveLength(2); // selecting is looking
    press('d', { ctrlKey: true });
    press('v', { ctrlKey: true });
    act(() => {
      fireEvent.keyDown(flowNode(nodes[0]!.id), { key: 'Delete' });
    });
    await settle(workflow.id);
    expect(nodesInDb(workflow.id)).toHaveLength(2);
    expect(useCanvasApi.getState().api?.addNode('agent')).toBeUndefined();

    fireEvent.contextMenu(flowNode(nodes[1]!.id));
    await screen.findByTestId('node-context-menu');
    expect(screen.getByRole('menuitem', { name: /Inspect/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Duplicate/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Settings/ })).toBeNull();
  });
});
