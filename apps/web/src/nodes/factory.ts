import {
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_SEARCH_K,
  DEFAULT_SEARCH_MODE,
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

/**
 * Every kind the Canvas can place: round 1's six plus round 5's Retrieval node (FR-RAG-006).
 * Guardrail and custom arrive in Rounds 6+.
 */
export const CANVAS_NODE_KINDS = [
  ...ROUND_1_NODE_KINDS,
  'retrieval',
] as const satisfies readonly NodeKind[];

export type CanvasNodeKind = (typeof CANVAS_NODE_KINDS)[number];

/**
 * The name the Canvas, the palette and the mock hooks still import. It now covers every placeable
 * kind, Retrieval included, so a dropped Retrieval node goes through the same `createNode`.
 */
export type Round1NodeKind = CanvasNodeKind;

export const NODE_KIND_LABEL: Record<CanvasNodeKind, string> = {
  input: 'Input',
  agent: 'Agent',
  model: 'Model',
  output: 'Output',
  merge: 'Merge',
  transform: 'Transform',
  retrieval: 'Retrieval',
};

/** Default config per kind, straight from the §2.4 defaults (round 5 §2.4 for Retrieval). */
function defaultConfig(kind: CanvasNodeKind): NodePortSource['config'] {
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
    case 'retrieval':
      // no base yet: pre-flight says `missing_knowledge_base` until one is chosen (§2.4)
      return { k: DEFAULT_SEARCH_K, mode: DEFAULT_SEARCH_MODE };
  }
}

/** A new node with a fresh ULID, the kind's default config and its derived ports (FR-NODE-006). */
export function createNode(kind: CanvasNodeKind, workflowId: string, position: Position): Node {
  const base = { id: newId(), kind, config: defaultConfig(kind) } as NodePortSource;
  const node = {
    ...base,
    workflowId,
    name: NODE_KIND_LABEL[kind],
    position,
  } as Node;
  return { ...node, ...derivePorts(node) } as Node;
}
