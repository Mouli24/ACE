import {
  AgentConfigSchema,
  type Edge,
  type Model,
  type Node,
  type Provider,
  type ProviderCheckResult,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { preflight, type PreflightInput } from '../runs/preflight.js';

const NOW = '2026-09-22T10:00:00.000Z';
const WORKFLOW = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const INPUT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const AGENT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const OUTPUT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0OUTP';
const EDGE_1 = '01JBXQ8Z9KQ4R7N2VWXYZ0EDG1';
const EDGE_2 = '01JBXQ8Z9KQ4R7N2VWXYZ0EDG2';

const inputNode = (text: string | null = 'the brief'): Node => ({
  id: INPUT_ID,
  workflowId: WORKFLOW,
  kind: 'input',
  name: 'Brief',
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [{ id: `${INPUT_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: { ...(text === null ? {} : { text }), artifactIds: [], outputTypes: ['text'] },
});

const agentNode = (overrides: Record<string, unknown> = {}): Node => ({
  id: AGENT_ID,
  workflowId: WORKFLOW,
  kind: 'agent',
  name: 'Writer',
  position: { x: 200, y: 0 },
  inputs: [{ id: `${AGENT_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${AGENT_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'mock-text',
    instructions: 'Summarise the brief.',
    inputTypes: ['text'],
    outputTypes: ['text'],
    ...overrides,
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
    id: EDGE_1,
    workflowId: WORKFLOW,
    kind: 'data',
    from: { nodeId: INPUT_ID, portId: `${INPUT_ID}:out:text` },
    to: { nodeId: AGENT_ID, portId: `${AGENT_ID}:in:text` },
  },
  {
    id: EDGE_2,
    workflowId: WORKFLOW,
    kind: 'data',
    from: { nodeId: AGENT_ID, portId: `${AGENT_ID}:out:text` },
    to: { nodeId: OUTPUT_ID, portId: `${OUTPUT_ID}:in:text` },
  },
];

const provider = (overrides: Partial<Provider> = {}): Provider => ({
  id: PROVIDER_ID,
  type: 'mock',
  name: 'Mock',
  keySet: false,
  status: 'CONNECTED',
  concurrency: 20,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const model = (overrides: Partial<Model> = {}): Model => ({
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
  providerId: PROVIDER_ID,
  modelId: 'mock-text',
  displayName: 'Mock text',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
  ...overrides,
});

let checked: string[] = [];

const run = (overrides: Partial<PreflightInput> = {}) => {
  checked = [];
  return preflight({
    nodes: [inputNode(), agentNode(), outputNode()],
    edges: edges(),
    inputs: {},
    providers: [provider()],
    models: [model()],
    checkProvider: async (id): Promise<ProviderCheckResult> => {
      checked.push(id);
      return { status: 'CONNECTED', checkedAt: NOW };
    },
    ...overrides,
  });
};

const codes = (issues: { code: string }[]): string[] => issues.map((issue) => issue.code);

describe('FR-EXE-003 a workflow that is ready to run has no issues', () => {
  it('passes a connected Input -> Agent -> Output', async () => {
    expect(await run()).toEqual([]);
  });

  it('checks the provider the agent uses, freshly (§2.7 item 2)', async () => {
    await run();

    expect(checked).toEqual([PROVIDER_ID]);
  });

  it('checks each provider once, however many nodes use it', async () => {
    const second = { ...agentNode(), id: '01JBXQ8Z9KQ4R7N2VWXYZ0AGN2', name: 'Second' };
    await run({ nodes: [inputNode(), agentNode(), second, outputNode()] });

    expect(checked).toEqual([PROVIDER_ID]);
  });
});

describe('§2.7 item 1 — a structural error blocks the run', () => {
  it('reports a workflow with no Input node', async () => {
    const issues = await run({ nodes: [agentNode(), outputNode()], edges: [edges()[1]!] });

    expect(codes(issues)).toContain('no_input_node');
  });

  it('reports a disconnected agent', async () => {
    const issues = await run({ edges: [edges()[1]!] });

    expect(codes(issues)).toContain('unconnected_required_input');
  });
});

describe('§2.7 item 2 — the provider and the model', () => {
  it('TC-NODE-007 names the node when no model is chosen', async () => {
    const issues = await run({ nodes: [inputNode(), agentNode({ modelId: undefined }), outputNode()] });

    expect(codes(issues)).toContain('missing_model');
    expect(issues.find((i) => i.code === 'missing_model')?.nodeId).toBe(AGENT_ID);
    expect(issues.find((i) => i.code === 'missing_model')?.message).toContain('Writer');
  });

  it('reports a provider that is no longer there (FR-PRV-005)', async () => {
    const issues = await run({ providers: [] });

    expect(codes(issues)).toContain('provider_missing');
  });

  it('TC-EXE-003 reports a provider that does not answer', async () => {
    const issues = await run({
      checkProvider: async (id) => {
        checked.push(id);
        return { status: 'UNREACHABLE', message: 'nothing listening', checkedAt: NOW };
      },
    });

    expect(codes(issues)).toContain('provider_unreachable');
    expect(issues.find((i) => i.code === 'provider_unreachable')?.message).toContain(
      'nothing listening',
    );
  });

  it.each(['AUTH_FAILED', 'RATE_LIMITED', 'UNKNOWN'] as const)(
    'refuses to start when the provider is %s',
    async (status) => {
      const issues = await run({
        checkProvider: async () => ({ status, checkedAt: NOW }),
      });

      expect(codes(issues)).toContain('provider_unreachable');
    },
  );

  it('TC-MOD-004 reports a model that is not available', async () => {
    const issues = await run({ models: [model({ available: false })] });

    expect(codes(issues)).toContain('unavailable_model');
  });

  it('reports a model that is not in the catalog at all', async () => {
    const issues = await run({ models: [] });

    expect(codes(issues)).toContain('unavailable_model');
  });

  it('reports a model whose data types do not cover the node', async () => {
    const issues = await run({
      nodes: [inputNode(), agentNode({ inputTypes: ['image'] }), outputNode()],
      models: [model()],
    });

    expect(codes(issues)).toContain('incompatible_model');
  });
});

describe('§2.7 item 3 — every Input node needs something to start from', () => {
  it('accepts text in the node config', async () => {
    expect(codes(await run())).not.toContain('missing_input');
  });

  it('accepts text supplied at start (FR-NODE-011)', async () => {
    const issues = await run({
      nodes: [inputNode(null), agentNode(), outputNode()],
      inputs: { [INPUT_ID]: [{ type: 'text', text: 'typed into the dialog' }] },
    });

    expect(codes(issues)).not.toContain('missing_input');
  });

  it('TC-NODE-010 reports an Input node with nothing in it', async () => {
    const issues = await run({ nodes: [inputNode(null), agentNode(), outputNode()] });

    expect(codes(issues)).toContain('missing_input');
    expect(issues.find((i) => i.code === 'missing_input')?.nodeId).toBe(INPUT_ID);
  });

  it('treats empty text as nothing', async () => {
    const issues = await run({ nodes: [inputNode(''), agentNode(), outputNode()] });

    expect(codes(issues)).toContain('missing_input');
  });

  it('accepts an empty parts list at start as nothing', async () => {
    const issues = await run({
      nodes: [inputNode(null), agentNode(), outputNode()],
      inputs: { [INPUT_ID]: [] },
    });

    expect(codes(issues)).toContain('missing_input');
  });
});

describe('§2.7 item 4 — TC-PRM-003 placeholders must resolve', () => {
  it('accepts the placeholders §2.8 defines', async () => {
    const issues = await run({
      nodes: [
        inputNode(),
        agentNode({ instructions: 'Rewrite {{input.text}} for pass {{run.iteration}}.' }),
        outputNode(),
      ],
    });

    expect(codes(issues)).not.toContain('unknown_placeholder');
  });

  it('reports one it cannot resolve, naming it', async () => {
    const issues = await run({
      nodes: [inputNode(), agentNode({ instructions: 'Use {{foo.bar}}.' }), outputNode()],
    });

    expect(codes(issues)).toContain('unknown_placeholder');
    expect(issues.find((i) => i.code === 'unknown_placeholder')?.message).toContain('foo.bar');
  });
});

describe('§2.7 item 5 — node kinds that arrive in a later round', () => {
  it.each(['merge', 'retrieval', 'guardrail', 'custom'] as const)(
    'refuses a %s node with not_supported_yet',
    async (kind) => {
      const unsupported = { ...outputNode(), id: '01JBXQ8Z9KQ4R7N2VWXYZ0LATR', kind, name: kind };
      const issues = await run({
        nodes: [inputNode(), agentNode(), outputNode(), unsupported as Node],
      });

      const issue = issues.find((i) => i.code === 'not_supported_yet');
      expect(issue, kind).toBeDefined();
      expect(issue?.nodeId).toBe('01JBXQ8Z9KQ4R7N2VWXYZ0LATR');
    },
  );

  it('allows the kinds round 2 does execute', async () => {
    expect(codes(await run())).not.toContain('not_supported_yet');
  });

  it('refuses a loop edge, which arrives in round 3', async () => {
    const loop: Edge = {
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0LOOP',
      workflowId: WORKFLOW,
      kind: 'loop',
      from: { nodeId: AGENT_ID, portId: `${AGENT_ID}:out:text` },
      to: { nodeId: AGENT_ID, portId: `${AGENT_ID}:in:text` },
    };

    expect(codes(await run({ edges: [...edges(), loop] }))).toContain('loop_not_supported');
  });
});

describe('FR-EXE-003 every issue is reported at once', () => {
  it('does not stop at the first problem', async () => {
    const issues = await run({
      nodes: [inputNode(null), agentNode({ modelId: undefined }), outputNode()],
    });

    expect(new Set(codes(issues))).toEqual(new Set(['missing_input', 'missing_model']));
  });

  it('reports only error severities as blocking', async () => {
    const issues = await run({ providers: [] });

    expect(issues.every((issue) => issue.severity === 'error')).toBe(true);
  });
});
