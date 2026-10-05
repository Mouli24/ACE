import { portId, type Edge, type Node, type Provider, type ProviderType } from '@ace/contracts';

import { createNode } from '../nodes/factory';
import { toFlowEdges } from './to-flow';

const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OPENAI = '01ARZ3NDEKTSV4RRFFQ69G5FP1';
const ANTHROPIC = '01ARZ3NDEKTSV4RRFFQ69G5FP2';

const provider = (id: string, type: ProviderType) => ({ id, type }) as Provider;
const providers = [provider(OPENAI, 'openai'), provider(ANTHROPIC, 'anthropic')];

function withProvider(kind: 'agent' | 'model', providerId: string | undefined): Node {
  const node = createNode(kind, WF, { x: 0, y: 0 });
  return { ...node, config: { ...node.config, providerId } } as Node;
}

function edge(from: Node, to: Node): Edge {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FE1',
    workflowId: WF,
    kind: 'data',
    from: { nodeId: from.id, portId: portId(from.id, 'out', 'text') },
    to: { nodeId: to.id, portId: portId(to.id, 'in', 'text') },
  };
}

describe('FR-EXE-015 toFlowEdges gives a data edge its provider accent', () => {
  it("takes the source node's provider type", () => {
    const writer = withProvider('agent', OPENAI);
    const editor = withProvider('agent', ANTHROPIC);
    const [flow] = toFlowEdges([edge(writer, editor)], [writer, editor], undefined, providers);
    expect(flow?.data).toMatchObject({ accent: 'openai' });
  });

  it("falls back to the target's when the source has no provider", () => {
    const input = createNode('input', WF, { x: 0, y: 0 });
    const editor = withProvider('model', ANTHROPIC);
    const [flow] = toFlowEdges([edge(input, editor)], [input, editor], undefined, providers);
    expect(flow?.data).toMatchObject({ accent: 'anthropic' });
  });

  it('has no accent when neither end has a known provider', () => {
    const input = createNode('input', WF, { x: 0, y: 0 });
    const ghost = withProvider('agent', '01ARZ3NDEKTSV4RRFFQ69G5FP9');
    const [flow] = toFlowEdges([edge(input, ghost)], [input, ghost], undefined, providers);
    expect(flow?.data).not.toHaveProperty('accent');
  });
});
