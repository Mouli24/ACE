import { LOCAL_SCOPE, newId } from '@ace/engine';
import type { Edge, Node, Project, Workflow } from '@ace/contracts';

/** Narrowed node types, so spreading a fixture keeps `kind` discriminating. */
export type InputNode = Extract<Node, { kind: 'input' }>;
export type OutputNode = Extract<Node, { kind: 'output' }>;

export const scope = LOCAL_SCOPE;

export const NOW = '2026-09-21T10:00:00.000Z';

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: newId(),
    name: 'Demo',
    folderPath: 'D:/projects/demo',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeWorkflow(projectId: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: newId(),
    projectId,
    name: 'Flow 1',
    version: 0,
    formatVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeOutputNode(workflowId: string, id = newId()): OutputNode {
  return {
    id,
    workflowId,
    kind: 'output',
    name: 'Output',
    position: { x: 0, y: 0 },
    inputs: [{ id: `${id}:in:text`, name: 'text', dataType: 'text', multi: false }],
    outputs: [],
    config: {},
  };
}

export function makeInputNode(workflowId: string, id = newId()): InputNode {
  return {
    id,
    workflowId,
    kind: 'input',
    name: 'Input',
    position: { x: 10, y: 20 },
    inputs: [],
    outputs: [{ id: `${id}:out:text`, name: 'text', dataType: 'text', multi: true }],
    config: { artifactIds: [], outputTypes: ['text'] },
  };
}

export function makeEdge(workflowId: string, from: Node, to: Node): Edge {
  return {
    id: newId(),
    workflowId,
    kind: 'data',
    from: { nodeId: from.id, portId: `${from.id}:out:text` },
    to: { nodeId: to.id, portId: `${to.id}:in:text` },
  };
}
