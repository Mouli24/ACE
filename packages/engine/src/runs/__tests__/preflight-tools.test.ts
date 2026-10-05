import {
  AgentConfigSchema,
  FORMAT_VERSION,
  type Edge,
  type McpServer,
  type Model,
  type Node,
  type Provider,
  type ProviderCheckResult,
  type ToolDefinition,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { createGraphService } from '../../graph/index.js';
import { validateGraph, type ToolLookup } from '../../graph/validate.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import { preflight, type PreflightInput } from '../preflight.js';

/**
 * Round 4 §2.4 (D-069): an agent that still enables a tool the registry no longer has — the MCP
 * server that contributed it was removed — is `tool_not_registered`, an **error**: validation reports
 * it and pre-flight blocks the run before a single provider call (BR-08). A tool that *is* registered
 * but whose MCP server is known and unreachable is `mcp_server_unreachable`, a **warning**: the run may
 * start, and the user is told why that tool may fail.
 */

const NOW = '2026-09-30T10:00:00.000Z';
const WORKFLOW = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const INPUT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const AGENT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const OUTPUT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0OUTP';
const SERVER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0MCPS';

const inputNode = (): Node => ({
  id: INPUT_ID,
  workflowId: WORKFLOW,
  kind: 'input',
  name: 'Brief',
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [{ id: `${INPUT_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: { text: 'ping it', artifactIds: [], outputTypes: ['text'] },
});

const agentNode = (enabled: string[]): Node => ({
  id: AGENT_ID,
  workflowId: WORKFLOW,
  kind: 'agent',
  name: 'Connector',
  position: { x: 200, y: 0 },
  inputs: [{ id: `${AGENT_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${AGENT_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'mock-mcp',
    instructions: 'Call the tool.',
    inputTypes: ['text'],
    outputTypes: ['text'],
    tools: { enabled, maxToolCalls: 5, allowedDomains: [] },
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
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDL1',
  providerId: PROVIDER_ID,
  modelId: 'mock-mcp',
  displayName: 'mock-mcp',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: true,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
};

const definition = (name: string, mcpServerId?: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  permissions: { network: mcpServerId !== undefined, fsPaths: [], destructive: false },
  timeoutMs: 1_000,
  ...(mcpServerId === undefined ? { source: 'builtin' } : { source: 'mcp', mcpServerId }),
});

/** A registry holding exactly these definitions — the shape the gateway binds `ToolRegistry` to. */
const registry = (...definitions: ToolDefinition[]): ToolLookup => ({
  get: (name) => {
    const found = definitions.find((candidate) => candidate.name === name);
    return found === undefined ? undefined : { definition: found };
  },
});

const server = (status: McpServer['status']): McpServer => ({
  id: SERVER_ID,
  name: 'fixtures',
  transport: 'stdio',
  command: 'node',
  args: [],
  status,
  toolCount: status === 'connected' ? 2 : 0,
});

const run = (enabled: string[], overrides: Partial<PreflightInput> = {}) =>
  preflight({
    nodes: [inputNode(), agentNode(enabled), outputNode()],
    edges: edges(),
    inputs: {},
    providers: [provider],
    models: [model],
    checkProvider: async (): Promise<ProviderCheckResult> => ({
      status: 'CONNECTED',
      checkedAt: NOW,
    }),
    knowledgeBaseExists: async () => true,
    ...overrides,
  });

describe('§2.4 tool_not_registered: an enabled tool the registry no longer has (D-069)', () => {
  it('is a pre-flight error on the agent that enables it, naming the tool', async () => {
    const issues = await run(['echo', 'mcp_goners_ping'], { tools: registry(definition('echo')) });

    const issue = issues.find((candidate) => candidate.code === 'tool_not_registered');
    expect(issue).toMatchObject({ severity: 'error', nodeId: AGENT_ID });
    expect(issue?.message).toContain('mcp_goners_ping');
    expect(issues.filter((candidate) => candidate.code === 'tool_not_registered')).toHaveLength(1);
  });

  it('raises nothing when every enabled tool is registered', async () => {
    const issues = await run(['echo', 'mcp_fixtures_ping'], {
      tools: registry(definition('echo'), definition('mcp_fixtures_ping', SERVER_ID)),
      mcpServers: [server('connected')],
    });

    expect(issues).toEqual([]);
  });

  it('is not judged at all without a registry (a round 2/3 harness)', async () => {
    expect(await run(['anything_at_all'])).toEqual([]);
  });

  it('is reported by validation too, where the tools panel reads it', () => {
    const issues = validateGraph([inputNode(), agentNode(['gone_tool']), outputNode()], edges(), {
      tools: registry(),
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: 'error', code: 'tool_not_registered', nodeId: AGENT_ID }),
    ]);
  });
});

describe('§2.4 mcp_server_unreachable: a registered tool whose server is known and unreachable (D-069)', () => {
  it('is a warning — pre-flight reports it and the run may start', async () => {
    const issues = await run(['mcp_fixtures_ping'], {
      tools: registry(definition('mcp_fixtures_ping', SERVER_ID)),
      mcpServers: [server('unreachable')],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'mcp_server_unreachable',
        nodeId: AGENT_ID,
      }),
    ]);
    expect(issues[0]?.message).toContain('fixtures');
    expect(issues.some((issue) => issue.severity === 'error')).toBe(false);
  });

  it('says nothing for a server that is connected, still starting, or not known at all', async () => {
    const tools = registry(definition('mcp_fixtures_ping', SERVER_ID));

    expect(await run(['mcp_fixtures_ping'], { tools, mcpServers: [server('connected')] })).toEqual(
      [],
    );
    expect(await run(['mcp_fixtures_ping'], { tools, mcpServers: [server('starting')] })).toEqual(
      [],
    );
    expect(await run(['mcp_fixtures_ping'], { tools, mcpServers: [] })).toEqual([]);
    expect(await run(['mcp_fixtures_ping'], { tools })).toEqual([]);
  });

  it('keeps the other validation warnings out of pre-flight, as before', async () => {
    // A registered builtin needs no server; nothing about it is a pre-flight issue.
    expect(
      await run(['echo'], {
        tools: registry(definition('echo')),
        mcpServers: [server('unreachable')],
      }),
    ).toEqual([]);
  });
});

describe('POST /workflows/:id/validate raises both, with the registry the gateway wires in', () => {
  it('validateWorkflow reads the registry and the stored MCP servers', async () => {
    const repository = new FakeRepository();
    const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
    const project = await repository.projects.create(LOCAL_SCOPE, {
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC',
      name: 'Tools',
      folderPath: '/tmp/tools',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repository.workflows.create(LOCAL_SCOPE, {
      id: WORKFLOW,
      projectId: project.id,
      name: 'Connector',
      version: 1,
      formatVersion: FORMAT_VERSION,
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const node of [
      inputNode(),
      agentNode(['mcp_goners_ping', 'mcp_fixtures_ping']),
      outputNode(),
    ]) {
      await repository.nodes.insert(LOCAL_SCOPE, node);
    }
    for (const edge of edges()) await repository.edges.insert(LOCAL_SCOPE, edge);
    await repository.mcpServers.create(LOCAL_SCOPE, server('unreachable'));

    const graph = createGraphService({
      repository,
      scope: LOCAL_SCOPE,
      logger,
      tools: registry(definition('mcp_fixtures_ping', SERVER_ID)),
    });
    const issues = await graph.validateWorkflow(WORKFLOW);

    expect(issues.map((issue) => [issue.severity, issue.code])).toEqual([
      ['error', 'tool_not_registered'],
      ['warning', 'mcp_server_unreachable'],
    ]);
  });

  it('without a registry, validation stays exactly as it was', async () => {
    const repository = new FakeRepository();
    const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
    const graph = createGraphService({ repository, scope: LOCAL_SCOPE, logger });

    expect(validateGraph([inputNode(), agentNode(['gone_tool']), outputNode()], edges())).toEqual(
      [],
    );
    await expect(graph.validateWorkflow('01JBXQ8Z9KQ4R7N2VWXYZ0NONE')).rejects.toThrow();
  });
});
