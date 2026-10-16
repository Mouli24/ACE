import type { Node } from '@ace/contracts';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createNode } from '../nodes/factory';
import { db, installMockServer, renderWithQuery } from '../test/app';
import { peekGraphSync } from '../workflows/sync-registry';
import { Canvas } from './Canvas';
import { useCanvasApi } from './canvas-api';
import { PALETTE_DRAG_TYPE, PALETTE_INIT_TYPE } from './drag';
import { useHistoryStore } from './interactions/history';

installMockServer();

beforeEach(() => useHistoryStore.getState().clear());

async function mount() {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  db.commitGraph(workflow.id, [createNode('input', workflow.id, { x: 0, y: 0 })], []);
  renderWithQuery(<Canvas workflowId={workflow.id} />);
  await screen.findByTestId('canvas');
  await waitFor(() =>
    expect(document.querySelectorAll('.react-flow__node').length).toBeGreaterThan(0),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  return workflow.id;
}

function drop(data: Record<string, string>) {
  const dataTransfer = {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
    dropEffect: 'none',
  };
  // jsdom has no DragEvent, so the pointer coordinates are set by hand
  const event = createEvent.drop(screen.getByTestId('canvas'), { dataTransfer });
  Object.defineProperties(event, { clientX: { value: 200 }, clientY: { value: 150 } });
  act(() => {
    fireEvent(screen.getByTestId('canvas'), event);
  });
}

const agentsOf = (workflowId: string): Node[] =>
  db.nodesOf(workflowId).filter((n) => n.kind === 'agent');

/** PG-1.3: answer the provider-first picker — no node exists until "Add node". */
async function choose(providerName: string, modelName: string, workflowId: string) {
  const picker = await screen.findByRole('dialog', { name: /provider/i });
  expect(agentsOf(workflowId)).toHaveLength(0);
  await userEvent.click(
    await within(picker).findByRole('option', { name: new RegExp(providerName) }),
  );
  await userEvent.click(await within(picker).findByRole('option', { name: new RegExp(modelName) }));
  await userEvent.click(within(picker).getByRole('button', { name: 'Add node' }));
}

describe('drop from the New node dialog (FR-CAN-002)', () => {
  it('creates a named Agent with the dragged provider and model', async () => {
    const workflowId = await mount();
    const providerId = db.nextId();
    drop({
      [PALETTE_DRAG_TYPE]: 'agent',
      [PALETTE_INIT_TYPE]: JSON.stringify({ name: 'Draft', providerId, modelId: 'm1' }),
    });
    await waitFor(() => expect(agentsOf(workflowId)).toHaveLength(1));
    const [agent] = agentsOf(workflowId);
    expect(agent?.name).toBe('Draft');
    expect(agent?.kind === 'agent' && agent.config.providerId).toBe(providerId);
    expect(agent?.kind === 'agent' && agent.config.modelId).toBe('m1');
  });

  // D351 (PG-1.3): a drop that names no provider opens the provider-first picker; nothing is
  // created until a provider and a model are chosen, and Cancel creates nothing.
  it('PG-1.3 malformed init JSON: the picker asks first, then adds the kind with defaults on the choice', async () => {
    const workflowId = await mount();
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    drop({ [PALETTE_DRAG_TYPE]: 'agent', [PALETTE_INIT_TYPE]: '{not json' });
    await choose('Mock', 'Mock text', workflowId);
    await waitFor(() => expect(agentsOf(workflowId)).toHaveLength(1));
    const [agent] = agentsOf(workflowId);
    expect(agent?.name).toBe('Agent');
    expect(agent?.kind === 'agent' && agent.config.providerId).toBe(provider.id);
    expect(agent?.kind === 'agent' && agent.config.modelId).toBe('mock-text');
  });

  it('PG-1.3 init JSON that is not an object is ignored; Cancel in the picker creates nothing', async () => {
    const workflowId = await mount();
    db.createProvider({ type: 'mock', name: 'Mock' });
    drop({ [PALETTE_DRAG_TYPE]: 'agent', [PALETTE_INIT_TYPE]: 'null' });
    const picker = await screen.findByRole('dialog', { name: /provider/i });
    await userEvent.click(within(picker).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /provider/i })).toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(agentsOf(workflowId)).toHaveLength(0);
  });

  it('PG-1.3 init fields of the wrong type are dropped; a lone modelId does not skip the picker', async () => {
    const workflowId = await mount();
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    drop({
      [PALETTE_DRAG_TYPE]: 'agent',
      [PALETTE_INIT_TYPE]: JSON.stringify({ name: 5, providerId: 7, modelId: 'm1' }),
    });
    await choose('Mock', 'Mock JSON', workflowId);
    await waitFor(() => expect(agentsOf(workflowId)).toHaveLength(1));
    const [agent] = agentsOf(workflowId);
    expect(agent?.name).toBe('Agent');
    expect(agent?.kind === 'agent' && agent.config.providerId).toBe(provider.id);
    expect(agent?.kind === 'agent' && agent.config.modelId).toBe('mock-json');
  });

  it('deleteNodes on the Canvas API removes the nodes', async () => {
    const workflowId = await mount();
    const [input] = db.nodesOf(workflowId);
    act(() => useCanvasApi.getState().api?.deleteNodes([input!.id]));
    await peekGraphSync(workflowId)?.whenIdle();
    expect(db.nodesOf(workflowId)).toHaveLength(0);
  });
});
