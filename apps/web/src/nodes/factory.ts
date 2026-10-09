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
 * What can be added to a Canvas (D285): one node — an Agent, given a goal and a model. The other
 * kinds stay in `CANVAS_NODE_KINDS` so a workflow that already has them still loads, renders, edits
 * and runs; they are just no longer offered. A node's input and its results are read in the chat
 * column, never on the Canvas.
 */
export const PALETTE_NODE_KINDS = ['agent'] as const satisfies readonly CanvasNodeKind[];

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

/** What the New node dialog hands over besides the kind: a name and, for model kinds, a model. */
export interface NewNodeInit {
  name?: string;
  providerId?: string;
  modelId?: string;
}

/** Applies a dialog's choices to a fresh node; a blank name and non-model kinds are left alone. */
export function applyNewNodeInit(node: Node, init: NewNodeInit = {}): Node {
  const name = init.name?.trim();
  const named = name ? { ...node, name } : node;
  if (init.providerId === undefined) return named;
  const model = {
    providerId: init.providerId,
    ...(init.modelId === undefined ? {} : { modelId: init.modelId }),
  };
  // one branch per kind: a spread over the agent | model union does not narrow the config type
  if (named.kind === 'agent') return { ...named, config: { ...named.config, ...model } };
  if (named.kind === 'model') return { ...named, config: { ...named.config, ...model } };
  return named;
}
