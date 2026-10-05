import {
  AgentConfigSchema,
  type DataType,
  type Edge,
  type Model,
  type Node,
  type Provider,
  type ProviderCheckResult,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { preflight, type PreflightInput } from '../preflight.js';

/**
 * The multimodal pre-flight capability check (round 4 §2.1, FR-MM-005, TC-MM-005): a media artifact
 * an Input node attaches must be a type the model it feeds can read, refused before a provider call.
 */

const NOW = '2026-09-30T10:00:00.000Z';
const WORKFLOW = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const INPUT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const AGENT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const OUTPUT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0OUTP';
const ART_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ART1';

const inputNode = (artifactIds: string[] = [ART_ID]): Node => ({
  id: INPUT_ID,
  workflowId: WORKFLOW,
  kind: 'input',
  name: 'Brief',
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [{ id: `${INPUT_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: { text: 'describe this', artifactIds, outputTypes: ['text'] },
});

const agentNode = (modelId: string, inputTypes: DataType[] = ['text']): Node => ({
  id: AGENT_ID,
  workflowId: WORKFLOW,
  kind: 'agent',
  name: 'Vision',
  position: { x: 200, y: 0 },
  inputs: [{ id: `${AGENT_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${AGENT_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId,
    instructions: 'Describe.',
    inputTypes,
    outputTypes: ['text'],
  }),
});

const outputNode = (): Node => ({
  id: OUTPUT_ID,
  workflowId: WORKFLOW,
  kind: 'output',
  name: 'Result',
  position: { x: 400, y: 0 },
  inputs: [{ id: `${OUTPUT_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [],
  config: {},
});

const edges = (): Edge[] => [
  {
    id: '01JBXQ8Z9KQ4R7N2VWXYZ0EDG1',
    workflowId: WORKFLOW,
    kind: 'data',
    from: { nodeId: INPUT_ID, portId: `${INPUT_ID}:out:text` },
    to: { nodeId: AGENT_ID, portId: `${AGENT_ID}:in:text` },
  },
  {
    id: '01JBXQ8Z9KQ4R7N2VWXYZ0EDG2',
    workflowId: WORKFLOW,
    kind: 'data',
    from: { nodeId: AGENT_ID, portId: `${AGENT_ID}:out:text` },
    to: { nodeId: OUTPUT_ID, portId: `${OUTPUT_ID}:in:text` },
  },
];

const provider = (): Provider => ({
  id: PROVIDER_ID,
  type: 'mock',
  name: 'Mock',
  keySet: false,
  status: 'CONNECTED',
  concurrency: 20,
  createdAt: NOW,
  updatedAt: NOW,
});

const model = (modelId: string, inputTypes: DataType[]): Model => ({
  id: `01JBXQ8Z9KQ4R7N2VWXYZ0MD${modelId.length}`,
  providerId: PROVIDER_ID,
  modelId,
  displayName: modelId,
  inputTypes,
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
});

const run = (overrides: Partial<PreflightInput>) =>
  preflight({
    nodes: [inputNode(), agentNode('vision', ['text', 'image']), outputNode()],
    edges: edges(),
    inputs: {},
    providers: [provider()],
    models: [model('vision', ['text', 'image']), model('text-only', ['text'])],
    checkProvider: async (): Promise<ProviderCheckResult> => ({
      status: 'CONNECTED',
      checkedAt: NOW,
    }),
    knowledgeBaseExists: async () => true,
    embeddingProviderOf: async () => undefined,
    ...overrides,
  });

const codes = (issues: { code: string }[]): string[] => issues.map((issue) => issue.code);

describe('TC-MM-005 a media artifact into a model that cannot read it is refused', () => {
  it('flags incompatible_model for a PNG into a text-only model', async () => {
    const issues = await run({
      nodes: [inputNode(), agentNode('text-only', ['text']), outputNode()],
      artifactTypesFor: async () => ['image'],
    });

    expect(codes(issues)).toContain('incompatible_model');
    expect(issues.find((i) => i.code === 'incompatible_model')?.nodeId).toBe(AGENT_ID);
  });

  it('passes a PNG into a vision model that accepts images', async () => {
    const issues = await run({
      nodes: [inputNode(), agentNode('vision', ['text', 'image']), outputNode()],
      artifactTypesFor: async () => ['image'],
    });

    expect(codes(issues)).not.toContain('incompatible_model');
  });

  it('does not run the check at all when no artifact type resolver is wired', async () => {
    const issues = await run({
      nodes: [inputNode(), agentNode('text-only', ['text']), outputNode()],
    });

    expect(codes(issues)).not.toContain('incompatible_model');
  });

  it('ignores an Input node with no attached artifacts', async () => {
    const issues = await run({
      nodes: [inputNode([]), agentNode('text-only', ['text']), outputNode()],
      artifactTypesFor: async () => ['image'],
    });

    expect(codes(issues)).not.toContain('incompatible_model');
  });
});
