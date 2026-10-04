import {
  AgentConfigSchema,
  REVIEW_CONTRACT_SCHEMA,
  TEMPLATE_IDS,
  derivePorts,
  portId,
  type Edge,
  type Id,
  type LoopConfig,
  type Node,
  type Template,
  type TemplateId,
} from '@ace/contracts';

/**
 * The four onboarding templates (round 5 §2.7, FR-ONB-002, Arch §33.1): graphs defined in code and
 * wired to the mock provider, so each one runs with no key and no network.
 */

/** The mock models the templates use — all of them exist in the mock provider's catalogue. */
export const TEMPLATE_MODELS = {
  text: 'mock-text',
  /** Takes text and json in, so it can read the Merge node's json output. */
  json: 'mock-json',
  reviewer: 'mock-reject-twice',
  cite: 'mock-cite',
  embed: 'mock-embed',
} as const;

/** The review-fix loop's settings (§2.7): approved ends it, three rounds at most. */
export const REVIEW_FIX_LOOP: LoopConfig = {
  maxIterations: 3,
  exitCondition: { path: 'verdict', equals: 'approved' },
  onMax: 'continue',
};

/** The sample document `rag-qa` seeds its knowledge base with (§2.7). */
export const SAMPLE_DOCUMENT_NAME = 'ace-sample.md';
export const SAMPLE_DOCUMENT_MIME = 'text/markdown';
export const SAMPLE_DOCUMENT = `# About ACE

ACE is a local-first workbench for building multi-agent workflows. A workflow is a graph of nodes
joined by edges, and a run executes it on your own machine.

## Knowledge bases

A knowledge base holds documents. Each document is parsed, split into chunks and embedded, so an
agent can retrieve the passages that answer a question and cite where they came from.

## Mock provider

The mock provider needs no key and no network. It is what the onboarding templates run on, so a
first workflow completes straight away.
`;

export const TEMPLATE_DEFINITIONS: readonly Template[] = [
  {
    id: 'linear-chain',
    name: 'Linear chain',
    description: 'A drafter writes, an editor polishes: the simplest two-step workflow.',
    requires: { knowledgeBase: false },
  },
  {
    id: 'review-fix',
    name: 'Review and fix',
    description: 'A writer drafts and a reviewer sends it back until it is approved.',
    requires: { knowledgeBase: false },
  },
  {
    id: 'parallel-research',
    name: 'Parallel research',
    description: 'Two researchers work at once and a synthesiser merges their findings.',
    requires: { knowledgeBase: false },
  },
  {
    id: 'rag-qa',
    name: 'Question answering over documents',
    description: 'An answerer cites a knowledge base seeded with a sample document.',
    requires: { knowledgeBase: true },
  },
];

if (TEMPLATE_DEFINITIONS.some((t, i) => t.id !== TEMPLATE_IDS[i])) {
  throw new Error('TEMPLATE_DEFINITIONS must list the templates in TEMPLATE_IDS order.');
}

export interface TemplateIds {
  workflowId: Id;
  newId: () => Id;
}

type NodeSpec =
  | { kind: 'input'; name: string; text: string }
  | { kind: 'output'; name: string }
  | { kind: 'merge'; name: string }
  | {
      kind: 'agent';
      name: string;
      modelId: string;
      instructions: string;
      outputTypes: ('text' | 'json')[];
      inputTypes?: ('text' | 'json')[];
      review?: boolean;
      knowledgeBaseIds?: Id[];
    };

const COLUMN = 320;

export function templateGraph(
  id: TemplateId,
  ids: TemplateIds,
  providerId: Id,
  kbId?: Id,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const add = (spec: NodeSpec, column: number, row: number): Node => {
    const nodeId = ids.newId();
    const base = {
      id: nodeId,
      workflowId: ids.workflowId,
      name: spec.name,
      position: { x: 80 + column * COLUMN, y: 80 + row * 200 },
    };
    let draft: Parameters<typeof derivePorts>[0] & Pick<Node, 'workflowId' | 'name' | 'position'>;

    switch (spec.kind) {
      case 'input':
        draft = {
          ...base,
          kind: 'input',
          config: { text: spec.text, artifactIds: [], outputTypes: ['text'] },
        };
        break;
      case 'output':
        draft = { ...base, kind: 'output', config: {} };
        break;
      case 'merge':
        draft = { ...base, kind: 'merge', config: { mode: 'all' } };
        break;
      case 'agent':
        draft = {
          ...base,
          kind: 'agent',
          config: AgentConfigSchema.parse({
            providerId,
            modelId: spec.modelId,
            instructions: spec.instructions,
            inputTypes: spec.inputTypes ?? ['text'],
            outputTypes: spec.outputTypes,
            ...(spec.review === true
              ? { outputContract: { jsonSchema: structuredClone(REVIEW_CONTRACT_SCHEMA) } }
              : {}),
            ...(spec.knowledgeBaseIds === undefined
              ? {}
              : { knowledgeBaseIds: spec.knowledgeBaseIds }),
          }),
        };
        break;
    }

    const ports = derivePorts(draft);
    const node = { ...draft, inputs: ports.inputs, outputs: ports.outputs } as Node;
    nodes.push(node);
    return node;
  };

  const connect = (
    from: Node,
    outName: string,
    to: Node,
    inName: string,
    kind: 'data' | 'loop' = 'data',
  ): Edge => {
    const edge: Edge = {
      id: ids.newId(),
      workflowId: ids.workflowId,
      kind,
      from: { nodeId: from.id, portId: portId(from.id, 'out', outName) },
      to: { nodeId: to.id, portId: portId(to.id, 'in', inName) },
      ...(kind === 'loop' ? { loop: { ...REVIEW_FIX_LOOP } } : {}),
    };
    edges.push(edge);
    return edge;
  };

  switch (id) {
    case 'linear-chain': {
      const input = add(
        { kind: 'input', name: 'Input', text: 'Write a short note about ACE.' },
        0,
        0,
      );
      const drafter = add(
        {
          kind: 'agent',
          name: 'Drafter',
          modelId: TEMPLATE_MODELS.text,
          instructions: 'Write a first draft answering the input.',
          outputTypes: ['text'],
        },
        1,
        0,
      );
      const editor = add(
        {
          kind: 'agent',
          name: 'Editor',
          modelId: TEMPLATE_MODELS.text,
          instructions: 'Tighten the draft and fix its wording.',
          outputTypes: ['text'],
        },
        2,
        0,
      );
      const output = add({ kind: 'output', name: 'Output' }, 3, 0);
      connect(input, 'text', drafter, 'text');
      connect(drafter, 'text', editor, 'text');
      connect(editor, 'text', output, 'text');
      break;
    }

    case 'review-fix': {
      const input = add(
        { kind: 'input', name: 'Input', text: 'Draft a short paragraph on the quarterly result.' },
        0,
        0,
      );
      const writer = add(
        {
          kind: 'agent',
          name: 'Writer',
          modelId: TEMPLATE_MODELS.text,
          instructions:
            'Write a short paragraph on the input. When the reviewer asks for changes, rewrite it addressing every issue listed.',
          outputTypes: ['text'],
        },
        1,
        0,
      );
      const reviewer = add(
        {
          kind: 'agent',
          name: 'Reviewer',
          modelId: TEMPLATE_MODELS.reviewer,
          instructions:
            'Review the draft. Answer with a score out of ten, a verdict and the issues you found.',
          outputTypes: ['json'],
          review: true,
        },
        2,
        0,
      );
      const output = add({ kind: 'output', name: 'Output' }, 3, 0);
      connect(input, 'text', writer, 'text');
      connect(writer, 'text', reviewer, 'text');
      connect(reviewer, 'json', output, 'json');
      connect(reviewer, 'json', writer, 'text', 'loop');
      break;
    }

    case 'parallel-research': {
      const input = add(
        { kind: 'input', name: 'Input', text: 'What makes a workflow easy to understand?' },
        0,
        1,
      );
      const a = add(
        {
          kind: 'agent',
          name: 'Researcher A',
          modelId: TEMPLATE_MODELS.text,
          instructions: 'Research the question from the point of view of a newcomer.',
          outputTypes: ['text'],
        },
        1,
        0,
      );
      const b = add(
        {
          kind: 'agent',
          name: 'Researcher B',
          modelId: TEMPLATE_MODELS.text,
          instructions: 'Research the question from the point of view of an expert.',
          outputTypes: ['text'],
        },
        1,
        2,
      );
      const merge = add({ kind: 'merge', name: 'Merge' }, 2, 1);
      const synthesiser = add(
        {
          kind: 'agent',
          name: 'Synthesiser',
          modelId: TEMPLATE_MODELS.json,
          instructions: 'Combine both sets of findings into one summary.',
          inputTypes: ['json'],
          outputTypes: ['json'],
        },
        3,
        1,
      );
      const output = add({ kind: 'output', name: 'Output' }, 4, 1);
      connect(input, 'text', a, 'text');
      connect(input, 'text', b, 'text');
      connect(a, 'text', merge, 'in');
      connect(b, 'text', merge, 'in');
      connect(merge, 'out', synthesiser, 'json');
      connect(synthesiser, 'json', output, 'json');
      break;
    }

    case 'rag-qa': {
      const input = add(
        { kind: 'input', name: 'Input', text: 'What is a knowledge base in ACE?' },
        0,
        0,
      );
      const answerer = add(
        {
          kind: 'agent',
          name: 'Answerer',
          modelId: TEMPLATE_MODELS.cite,
          instructions: 'Answer the question from the retrieved passages and cite them.',
          outputTypes: ['text'],
          knowledgeBaseIds: kbId === undefined ? [] : [kbId],
        },
        1,
        0,
      );
      const output = add({ kind: 'output', name: 'Output' }, 2, 0);
      connect(input, 'text', answerer, 'text');
      connect(answerer, 'text', output, 'text');
      break;
    }
  }

  return { nodes, edges };
}
