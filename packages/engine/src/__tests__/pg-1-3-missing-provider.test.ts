/**
 * PG-1.3 No node without a provider (docs/team-prompts/product-gaps-fix-prompt.md).
 *
 * Phase 0 red test: pre-flight and `/validate` must name an Agent/Model node with no provider with
 * its own issue, `missing_provider` (D358); `missing_model` (provider set, no model) and
 * `provider_missing` (provider deleted) stay as they are. Graph ops that create such a node must still be
 * accepted, so an old workflow keeps loading — that half passes today and guards against
 * over-fixing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentConfigSchema, type Model, type Node, type Provider } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { validateGraph } from '../graph/validate.js';
import { preflight } from '../runs/preflight.js';

import {
  addNode,
  agentNode as helperAgentNode,
  createHarness,
  createProject,
  createWorkflow,
  graphOps,
} from './graph-helpers.js';

const NOW = '2026-10-15T10:00:00.000Z';
const WORKFLOW = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const AGENT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';

const agent = (overrides: Record<string, unknown> = {}): Node => ({
  id: AGENT_ID,
  workflowId: WORKFLOW,
  kind: 'agent',
  name: 'Writer',
  position: { x: 0, y: 0 },
  inputs: [{ id: `${AGENT_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${AGENT_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'mock-text',
    instructions: 'Write a haiku.',
    inputTypes: ['text'],
    outputTypes: ['text'],
    ...overrides,
  }),
});

const provider: Provider = {
  id: PROVIDER_ID,
  type: 'mock',
  name: 'Mock',
  keySet: false,
  status: 'CONNECTED',
  concurrency: 20,
  createdAt: NOW,
  updatedAt: NOW,
};

const model: Model = {
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
};

const runPreflight = (nodes: Node[]) =>
  preflight({
    nodes,
    edges: [],
    inputs: {},
    providers: [provider],
    models: [model],
    checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
    knowledgeBaseExists: async () => true,
    embeddingProviderOf: async () => undefined,
  });

const codes = (issues: { code: string }[]): string[] => issues.map((issue) => issue.code);

describe('PG-1.3 pre-flight names a node with no provider (missing_provider)', () => {
  it(
    'an Agent with no provider is blocked with missing_provider, naming the node',
    async () => {
      const issues = await runPreflight([agent({ providerId: undefined })]);

      const issue = issues.find((candidate) => candidate.code === 'missing_provider');
      expect(codes(issues)).toContain('missing_provider');
      expect(issue?.nodeId).toBe(AGENT_ID);
      expect(issue?.severity).toBe('error');
    },
  );

  it('D358: a provider with no model stays missing_model, not missing_provider (passes today)', async () => {
    const issues = await runPreflight([agent({ modelId: undefined })]);

    expect(codes(issues)).toContain('missing_model');
    expect(codes(issues)).not.toContain('missing_provider');
  });

  it('POST /validate (validateGraph) raises missing_provider for the same node', () => {
    const issues = validateGraph([agent({ providerId: undefined, modelId: undefined })], [], {
      providers: [provider],
      models: [model],
    });

    expect(codes(issues)).toContain('missing_provider');
  });
});

describe('PG-1.3 graph ops that create a providerless node are not refused (old workflows load)', () => {
  it('add_node of an Agent with no provider and no model is accepted', async () => {
    const h = createHarness();
    const dir = mkdtempSync(join(tmpdir(), 'ace-pg13-'));
    try {
      const project = await createProject(h.app, join(dir, 'project'));
      const workflow = await createWorkflow(h.app, project.id);
      const node = helperAgentNode(workflow.id);
      expect(node.kind === 'agent' && node.config.providerId).toBeFalsy();

      const response = await graphOps(h.app, workflow.id, 0, [addNode(node)]);

      expect(response.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
