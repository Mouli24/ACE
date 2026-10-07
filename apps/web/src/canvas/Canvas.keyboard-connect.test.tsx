import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import { createNode } from '../nodes/factory';
import { db, installMockServer, renderWithQuery } from '../test/app';
import { peekGraphSync } from '../workflows/sync-registry';
import { Canvas } from './Canvas';
import { useHistoryStore } from './interactions/history';

installMockServer();

beforeEach(() => {
  useHistoryStore.getState().clear();
});

/** An Input and an Agent, not yet connected. */
function seed() {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const input = createNode('input', workflow.id, { x: 0, y: 0 });
  const agent = createNode('agent', workflow.id, { x: 300, y: 0 });
  db.commitGraph(workflow.id, [input, agent], []);
  return { workflow, input, agent };
}

async function mount(workflowId: string) {
  renderWithQuery(<Canvas workflowId={workflowId} />);
  await screen.findByTestId('canvas');
  await waitFor(() => expect(document.querySelectorAll('.react-flow__node')).toHaveLength(2));
}

const handle = (portId: string) => screen.getByTestId(`port-${portId}`);

describe('NFR-USE-02 keyboard connect', () => {
  it('connects when Enter on the input follows the arming Enter before the canvas re-renders', async () => {
    const { workflow, input, agent } = seed();
    await mount(workflow.id);
    const out = handle(input.outputs[0]!.id);
    const into = handle(agent.inputs[0]!.id);

    // One act, so no render runs between the two presses: the input's handler is the one from
    // before the arming, as it is when a person (or a script) presses quickly.
    act(() => {
      fireEvent.keyDown(out, { key: 'Enter' });
      fireEvent.keyDown(into, { key: 'Enter' });
    });
    await peekGraphSync(workflow.id)?.whenIdle();

    expect(db.edgesOf(workflow.id)).toEqual([
      expect.objectContaining({
        from: { nodeId: input.id, portId: input.outputs[0]!.id },
        to: { nodeId: agent.id, portId: agent.inputs[0]!.id },
      }),
    ]);
  });

  it('Escape disarms, so a later Enter on an input connects nothing', async () => {
    const { workflow, input, agent } = seed();
    await mount(workflow.id);

    act(() => {
      fireEvent.keyDown(handle(input.outputs[0]!.id), { key: 'Enter' });
    });
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    act(() => {
      fireEvent.keyDown(handle(agent.inputs[0]!.id), { key: 'Enter' });
    });
    await peekGraphSync(workflow.id)?.whenIdle();

    expect(db.edgesOf(workflow.id)).toEqual([]);
  });
});
