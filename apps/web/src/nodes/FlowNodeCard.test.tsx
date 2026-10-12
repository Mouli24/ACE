import { ReactFlow, ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { act, screen, waitFor } from '@testing-library/react';

import { db, installMockServer, renderWithQuery } from '../test/app';
import { createNode } from './factory';
import { nodeTypes, type AceFlowNode } from './NodeCard';

installMockServer();

type FlowStore = ReturnType<typeof useStoreApi<AceFlowNode>>;

function GrabStore({ into }: { into: { store?: FlowStore } }) {
  into.store = useStoreApi<AceFlowNode>();
  return null;
}

describe('FlowNodeCard keeps its handle positions', () => {
  it('measures a node again when it is measured but React Flow has lost its handle positions', async () => {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    const node = createNode('agent', workflow.id, { x: 0, y: 0 });
    const flowNode: AceFlowNode = {
      id: node.id,
      type: 'ace',
      position: node.position,
      data: {
        node,
        connectedPortIds: new Set(),
        armedPortId: undefined,
        onPortKey: () => undefined,
      },
    };
    const held: { store?: FlowStore } = {};
    renderWithQuery(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow nodes={[flowNode]} edges={[]} nodeTypes={nodeTypes} />
        </div>
        <GrabStore into={held} />
      </ReactFlowProvider>,
    );
    await screen.findByTestId(`node-card-${node.id}`);
    const store = held.store!;
    const remeasure = vi.fn();
    store.setState({ updateNodeInternals: remeasure });
    expect(remeasure).not.toHaveBeenCalled();

    // The race (Bug 2): a node array with `measured` lands after one without it wiped the
    // handle positions, so React Flow holds a measured node it cannot draw an edge to.
    act(() => store.getState().setNodes([{ ...flowNode, measured: { width: 210, height: 280 } }]));
    expect(store.getState().nodeLookup.get(node.id)?.internals.handleBounds).toBeUndefined();

    await waitFor(() => expect(remeasure).toHaveBeenCalled());
    const [updates] = remeasure.mock.calls[0] as [Map<string, { id: string; force: boolean }>];
    expect(updates.get(node.id)).toMatchObject({ id: node.id, force: true });
  });
});
