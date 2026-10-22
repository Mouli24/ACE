import type { Edge, Node } from '@ace/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useViewportStore } from '../app/stores/viewport';
import { createNode } from '../nodes/factory';
import { useRunStore } from '../runs/run-store';
import { db, installMockServer, renderWithQuery } from '../test/app';
import { peekGraphSync } from '../workflows/sync-registry';
import { Canvas } from './Canvas';
import { useHistoryStore } from './interactions/history';

/*
 * PG-1.1 and PG-1.2 on the real Canvas (D350, D360): a click opens settings only when the pointer
 * did not travel, every card carries Settings and More, and More's "Connect to…" draws an edge
 * without a drag. Drawing a line and dropping it on a card are pure logic (`interactions/ports`)
 * plus real pointer geometry, so they are covered by `ports.test.ts` and the acceptance e2e.
 */

installMockServer();

beforeEach(() => {
  useHistoryStore.getState().clear();
  useViewportStore.setState({ viewports: {} });
  usePanelsStore.getState().closeSettings();
  useSelectionStore.getState().setSelection([], []);
});

function seed(kinds: Array<Parameters<typeof createNode>[0]>, link = false) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  // An Agent/Model on a mock provider: one with none would make Duplicate ask first (D351).
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });
  const nodes = kinds.map((kind, i) => {
    const node = createNode(kind, workflow.id, { x: i * 320, y: 0 });
    return node.kind === 'agent' || node.kind === 'model'
      ? ({ ...node, config: { ...node.config, providerId: provider.id, modelId: 'mock-text' } } as Node)
      : node;
  });
  const edges: Edge[] = [];
  if (link) {
    for (let i = 1; i < nodes.length; i += 1) {
      edges.push({
        id: db.nextId(),
        workflowId: workflow.id,
        kind: 'data',
        from: { nodeId: nodes[i - 1]!.id, portId: nodes[i - 1]!.outputs[0]!.id },
        to: { nodeId: nodes[i]!.id, portId: nodes[i]!.inputs[0]!.id },
      });
    }
  }
  db.commitGraph(workflow.id, nodes, edges);
  return { workflow, nodes };
}

async function mount(workflowId: string) {
  renderWithQuery(<Canvas workflowId={workflowId} />);
  await screen.findByTestId('canvas');
  await waitFor(() =>
    expect(document.querySelectorAll('.react-flow__node').length).toBeGreaterThan(0),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

const card = (id: string) => screen.getByTestId(`node-card-${id}`);
const moreOf = (id: string) => screen.getByTestId(`node-more-${id}`);
const settingsOf = (id: string) => screen.getByTestId(`node-settings-${id}`);
const settle = (workflowId: string) => peekGraphSync(workflowId)?.whenIdle();

/*
 * The press goes to the Canvas wrapper, whose capture handler records where it went down: jsdom's
 * events carry no `view`, which React Flow's own drag (d3) on the card would need.
 */
describe('PG-1.1 no accidental settings (D350)', () => {
  it('a press and release within 4 px is a click: settings open', async () => {
    const { workflow, nodes } = seed(['agent', 'agent']);
    await mount(workflow.id);
    const target = card(nodes[1]!.id);
    fireEvent.mouseDown(screen.getByTestId('canvas'), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.click(target, { clientX: 103, clientY: 102 });
    expect(usePanelsStore.getState().settings).toEqual({ kind: 'node', id: nodes[1]!.id });
  });

  it('a press that travelled more than 4 px before its release is a drag: no settings', async () => {
    const { workflow, nodes } = seed(['agent', 'agent']);
    await mount(workflow.id);
    const target = card(nodes[1]!.id);
    fireEvent.mouseDown(screen.getByTestId('canvas'), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.click(target, { clientX: 130, clientY: 100 });
    expect(usePanelsStore.getState().settings).toBeUndefined();
  });

  it('a click on one of the card’s own buttons is not a click on the card', async () => {
    const { workflow, nodes } = seed(['agent']);
    await mount(workflow.id);
    fireEvent.click(moreOf(nodes[0]!.id));
    expect(usePanelsStore.getState().settings).toBeUndefined();
  });
});

describe('PG-1.2 every card has always-visible Settings and More (D360)', () => {
  it('both buttons are on every card, named for assistive tech', async () => {
    const { workflow, nodes } = seed(['input', 'agent', 'output']);
    await mount(workflow.id);
    for (const node of nodes) {
      // jsdom measures nothing, so React Flow keeps every node `visibility: hidden`; the e2e
      // (`pg-1-2-visible.e2e.ts`) asserts the buttons are seen without a hover.
      for (const [button, name] of [
        [settingsOf(node.id), 'Settings'],
        [moreOf(node.id), 'More'],
      ] as const) {
        expect(card(node.id)).toContainElement(button);
        expect(button.tagName).toBe('BUTTON');
        expect(button).toHaveAttribute('aria-label', name);
        expect(button.className).not.toMatch(/opacity-0|invisible|\bhidden\b/);
      }
    }
  });

  it('Settings selects the node and opens its settings', async () => {
    const { workflow, nodes } = seed(['agent']);
    await mount(workflow.id);
    await userEvent.click(settingsOf(nodes[0]!.id));
    expect(useSelectionStore.getState().nodeIds).toEqual([nodes[0]!.id]);
    expect(usePanelsStore.getState().settings).toEqual({ kind: 'node', id: nodes[0]!.id });
  });

  it('More holds Connect to…, Duplicate, Run from here and Delete', async () => {
    const { workflow, nodes } = seed(['agent']);
    await mount(workflow.id);
    await userEvent.click(moreOf(nodes[0]!.id));
    const menu = await screen.findByRole('menu');
    for (const item of ['Connect to…', 'Duplicate', 'Run from here', 'Delete']) {
      expect(within(menu).getByRole('menuitem', { name: item })).toBeVisible();
    }
  });

  it('[audit W-8] while a run is going, Run from here waits and says why', async () => {
    const { workflow, nodes } = seed(['agent']);
    await mount(workflow.id);
    act(() => useRunStore.setState({ workflowId: workflow.id, runId: 'run1', active: true }));
    await userEvent.click(moreOf(nodes[0]!.id));
    const item = within(await screen.findByRole('menu')).getByRole('menuitem', {
      name: 'Run from here',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', 'A run is going — stop it first');
    act(() => useRunStore.getState().reset());
  });

  it('More → Duplicate adds a copy; More → Delete removes the node', async () => {
    const { workflow, nodes } = seed(['agent']);
    await mount(workflow.id);
    await userEvent.click(moreOf(nodes[0]!.id));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    await settle(workflow.id);
    await waitFor(() => expect(db.nodesOf(workflow.id)).toHaveLength(2));

    await userEvent.click(moreOf(nodes[0]!.id));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await settle(workflow.id);
    await waitFor(() =>
      expect(db.nodesOf(workflow.id).map((node) => node.id)).not.toContain(nodes[0]!.id),
    );
  });
});

describe('PG-1.1 Connect to… — connecting without a drag (D350)', () => {
  it('picks a node and draws the edge from this node’s output to its input', async () => {
    const { workflow, nodes } = seed(['agent', 'agent']);
    await mount(workflow.id);
    await userEvent.click(moreOf(nodes[0]!.id));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Connect to…' }));
    const dialog = await screen.findByTestId('connect-to-dialog');
    await userEvent.click(within(dialog).getByTestId(`connect-to-${nodes[1]!.id}`));
    await settle(workflow.id);
    await waitFor(() => expect(db.edgesOf(workflow.id)).toHaveLength(1));
    const edge = db.edgesOf(workflow.id)[0]!;
    expect(edge.from).toEqual({ nodeId: nodes[0]!.id, portId: nodes[0]!.outputs[0]!.id });
    expect(edge.to).toEqual({ nodeId: nodes[1]!.id, portId: nodes[1]!.inputs[0]!.id });
    expect(screen.queryByTestId('connect-to-dialog')).not.toBeInTheDocument();
  });

  it('a pick that would close a cycle is refused in the dialog, with the reason', async () => {
    const { workflow, nodes } = seed(['agent', 'agent'], true);
    await mount(workflow.id);
    await userEvent.click(moreOf(nodes[1]!.id));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Connect to…' }));
    const dialog = await screen.findByTestId('connect-to-dialog');
    await userEvent.click(within(dialog).getByTestId(`connect-to-${nodes[0]!.id}`));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/cycle|loop/i);
    expect(db.edgesOf(workflow.id)).toHaveLength(1);
  });
});
