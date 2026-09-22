import {
  DEFAULT_CONTEXT_POLICY,
  defaultAgentTools,
  defaultExecutionSettings,
  defaultRouting,
  derivePorts,
  type Node,
  type NodeKind,
  type NodePortSource,
  type Position,
} from '@ace/contracts';

import { newId } from '../lib/ulid';

/** The six kinds round 1 ships (FR-NODE-001); retrieval, guardrail and custom arrive later. */
export const ROUND_1_NODE_KINDS = [
  'input',
  'agent',
  'model',
  'output',
  'merge',
  'transform',
] as const satisfies readonly NodeKind[];

export type Round1NodeKind = (typeof ROUND_1_NODE_KINDS)[number];

export const NODE_KIND_LABEL: Record<Round1NodeKind, string> = {
  input: 'Input',
  agent: 'Agent',
  model: 'Model',
  output: 'Output',
  merge: 'Merge',
  transform: 'Transform',
};

/** Default config per kind, straight from the §2.4 defaults. */
function defaultConfig(kind: Round1NodeKind): NodePortSource['config'] {
  switch (kind) {
    case 'input':
      return { artifactIds: [], outputTypes: ['text'] };
    case 'output':
      return {};
    case 'agent':
      return {
        routing: defaultRouting(),
        instructions: '',
        inputTypes: ['text'],
        outputTypes: ['text'],
        execution: defaultExecutionSettings(),
        contextPolicy: { ...DEFAULT_CONTEXT_POLICY },
        tools: defaultAgentTools(),
        knowledgeBaseIds: [],
        memory: { enabled: false },
        skillIds: [],
      };
    case 'model':
      return { inputTypes: ['text'], outputTypes: ['text'], execution: defaultExecutionSettings() };
    case 'merge':
      return { mode: 'all' };
    case 'transform':
      return { op: 'template', template: '' };
  }
}

/** A new node with a fresh ULID, the kind's default config and its derived ports (FR-NODE-006). */
export function createNode(kind: Round1NodeKind, workflowId: string, position: Position): Node {
  const base = { id: newId(), kind, config: defaultConfig(kind) } as NodePortSource;
  const node = {
    ...base,
    workflowId,
    name: NODE_KIND_LABEL[kind],
    position,
  } as Node;
  return { ...node, ...derivePorts(node) } as Node;
}
