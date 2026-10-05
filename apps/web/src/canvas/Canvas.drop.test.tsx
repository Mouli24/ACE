import type { Node } from '@ace/contracts';
import { act, createEvent, fireEvent, screen, waitFor } from '@testing-library/react';

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

  it('still adds the kind with defaults when the init JSON is malformed', async () => {
    const workflowId = await mount();
    drop({ [PALETTE_DRAG_TYPE]: 'agent', [PALETTE_INIT_TYPE]: '{not json' });
    await waitFor(() => expect(agentsOf(workflowId)).toHaveLength(1));
    expect(agentsOf(workflowId)[0]?.name).toBe('Agent');
  });

  it('ignores init JSON that is not an object', async () => {
    const workflowId = await mount();
    drop({ [PALETTE_DRAG_TYPE]: 'agent', [PALETTE_INIT_TYPE]: 'null' });
    await waitFor(() => expect(agentsOf(workflowId)).toHaveLength(1));
    expect(agentsOf(workflowId)[0]?.name).toBe('Agent');
  });

  it('drops init fields of the wrong type; a lone modelId is ignored without a provider', async () => {
    const workflowId = await mount();
    drop({
      [PALETTE_DRAG_TYPE]: 'agent',
      [PALETTE_INIT_TYPE]: JSON.stringify({ name: 5, providerId: 7, modelId: 'm1' }),
    });
    await waitFor(() => expect(agentsOf(workflowId)).toHaveLength(1));
    const [agent] = agentsOf(workflowId);
    expect(agent?.name).toBe('Agent');
    expect(agent?.kind === 'agent' && agent.config.providerId).toBeUndefined();
    expect(agent?.kind === 'agent' && agent.config.modelId).toBeUndefined();
  });

  it('deleteNodes on the Canvas API removes the nodes', async () => {
    const workflowId = await mount();
    const [input] = db.nodesOf(workflowId);
    act(() => useCanvasApi.getState().api?.deleteNodes([input!.id]));
    await peekGraphSync(workflowId)?.whenIdle();
    expect(db.nodesOf(workflowId)).toHaveLength(0);
  });
});
