import type { Edge, Node } from '@ace/contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

function seed(kinds: Array<Parameters<typeof createNode>[0]> = ['input', 'agent']) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const nodes = kinds.map((kind, i) => createNode(kind, workflow.id, { x: i * 300, y: 0 }));
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

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await settle(workflow.id);
    expect(nodesInDb(workflow.id).find((n) => n.id === nodes[1]!.id)?.config).toEqual(
      nodes[1]!.config,
    );
    expect(db.edgesOf(workflow.id).map((e) => e.id)).toEqual(edges.map((e) => e.id));

    await userEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await settle(workflow.id);
    expect(nodesInDb(workflow.id)).toHaveLength(1);
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

    await userEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }));
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
  it('a node offers Duplicate, Copy, Configure and Delete', async () => {
    const { workflow, nodes } = seed(['input', 'agent']);
    await mount(workflow.id);
    fireEvent.contextMenu(flowNode(nodes[1]!.id));
    const menu = await screen.findByTestId('node-context-menu');
    for (const name of [/Duplicate/, /Copy/, /Configure/, /Delete/]) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    expect(menu).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    await settle(workflow.id);
    expect(nodesInDb(workflow.id).map((n) => n.id)).toEqual([nodes[0]!.id]);
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
    await settle(workflow.id);
    expect(
      nodesInDb(workflow.id)
        .map((n) => n.kind)
        .sort(),
    ).toEqual(['agent', 'input']);
  });

  it('the toolbar, minimap and controls get no menu', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Fit to view' }));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('FR-CAN-001 Canvas chrome (POC Theme V2)', () => {
  it('swaps React Flow controls for the zoom pill and groups the history buttons in one pill', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    expect(document.querySelector('.react-flow__controls')).toBeNull();
    const pill = screen.getByTestId('canvas-zoom-pill');
    expect(pill.closest('.react-flow__panel')).toHaveClass('bottom', 'left');
    expect(screen.getByTestId('canvas-zoom-level')).toHaveTextContent('%');

    const history = screen.getByTestId('canvas-tools-pill');
    expect(history.closest('.react-flow__panel')).toHaveClass('top', 'right');
    for (const name of ['Undo', 'Redo', 'Auto-arrange']) {
      expect(history).toContainElement(screen.getByRole('button', { name }));
    }
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveAttribute(
      'title',
      expect.stringMatching(/^Undo \(/),
    );
    expect(document.querySelector('.react-flow__minimap')).toHaveClass(
      'rounded-card',
      'border-border',
    );
  });

  it('has one Fit control, the zoom pill’s, named "Fit to view"; the F key still fits', async () => {
    const { workflow } = seed(['input']);
    await mount(workflow.id);
    const fits = screen.getAllByRole('button', { name: /fit/i });
    expect(fits).toHaveLength(1);
    const [fit] = fits as [HTMLElement];
    expect(fit).toHaveAccessibleName('Fit to view');
    expect(fit).toHaveTextContent('Fit');
    expect(screen.getByTestId('canvas-zoom-pill')).toContainElement(fit);
    expect(screen.getByTestId('canvas-tools-pill')).not.toContainElement(fit);
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
    // nothing left to edit with, so no empty tools pill either
    expect(screen.queryByTestId('canvas-tools-pill')).toBeNull();
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
  });
});
