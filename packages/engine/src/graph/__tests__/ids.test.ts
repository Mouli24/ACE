import type { Edge } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import { agentNode, inputNode } from '../../guardrails/__tests__/fakes.js';
import { parsePortId, remapGraph } from '../ids.js';

/**
 * `parsePortId` / `remapGraph` (FR-WF-003 / FR-WF-008, §2.4): a graph copied under fresh ids keeps
 * its wiring, and an edge whose endpoints no longer resolve is dropped rather than copied dangling.
 */
describe('port id parsing and graph remap', () => {
  it('parsePortId reads the fixed format and rejects anything else', () => {
    expect(parsePortId('node1:in:main')).toEqual({ nodeId: 'node1', direction: 'in', name: 'main' });
    expect(parsePortId('node1:out:reply')).toEqual({
      nodeId: 'node1',
      direction: 'out',
      name: 'reply',
    });
    expect(parsePortId('not a port id')).toBeNull();
    expect(parsePortId('node1:sideways:main')).toBeNull();
  });

  it('remapGraph rewrites node and edge ids and re-derives ports', () => {
    const source = inputNode();
    const target = agentNode();
    const workflowId = newId();

    const edge: Edge = {
      id: newId(),
      workflowId: source.workflowId,
      kind: 'data',
      from: { nodeId: source.id, portId: source.outputs[0]!.id },
      to: { nodeId: target.id, portId: target.inputs[0]!.id },
    };

    const remapped = remapGraph([source, target], [edge], workflowId);

    expect(remapped.nodes).toHaveLength(2);
    // Every node got a fresh id and the target workflow, and no old id survives on an endpoint.
    expect(remapped.nodes.every((node) => node.workflowId === workflowId)).toBe(true);
    expect(remapped.nodes.map((node) => node.id)).not.toContain(source.id);
    expect(remapped.edges).toHaveLength(1);
    const [copiedEdge] = remapped.edges;
    expect(copiedEdge!.from.nodeId).not.toBe(source.id);
    expect(copiedEdge!.from.portId.startsWith(copiedEdge!.from.nodeId)).toBe(true);
    expect(copiedEdge!.workflowId).toBe(workflowId);
  });

  it('drops an edge whose endpoints are not in the copied set', () => {
    const source = inputNode();
    const target = agentNode();

    // An edge from a node that is not part of the graph being copied: its endpoint cannot be
    // remapped, so the copy leaves it out rather than pointing it at a missing node.
    const dangling: Edge = {
      id: newId(),
      workflowId: source.workflowId,
      kind: 'data',
      from: { nodeId: newId(), portId: `${newId()}:out:main` },
      to: { nodeId: target.id, portId: target.inputs[0]!.id },
    };

    const remapped = remapGraph([source, target], [dangling], newId());
    expect(remapped.edges).toHaveLength(0);
  });
});
