import { describe, expect, it } from 'vitest';

import {
  BUILTIN_TOOL_NAMES,
  CreateMcpServerRequestSchema,
  MCP_SERVER_STATUSES,
  MCP_TRANSPORTS,
  McpServerListResponseSchema,
  McpServerSchema,
  SANDBOX_LANGUAGES,
  TOOL_CALL_STATUSES,
  TOOL_NAME_REGEX,
  TOOL_RESULT_SUMMARY_MAX,
  TOOL_SOURCES,
  ToolCallSchema,
  ToolDefinitionSchema,
  ToolListResponseSchema,
  ToolPermissionsSchema,
} from '../tools.js';
import { NodeRunSchema } from '../runs.js';
import { ROUND_4_VALIDATION_ISSUE_CODES, VALIDATION_ISSUE_CODES } from '../validation.js';
import {
  MCP_SERVER_ID,
  NODE_A,
  NODE_RUN_ID,
  NOW,
  RUN_ID,
  TOOL_CALL_ID,
  VERDICT_ID,
} from './fixtures.js';

const permissions = { network: false, fsPaths: ['.ace/sandbox/run'], destructive: false };

const definition = {
  name: 'web_search',
  description: 'Search the web through SearXNG.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  outputSchema: { type: 'object', properties: { results: { type: 'array' } } },
  permissions: { network: true, fsPaths: [], destructive: false },
  timeoutMs: 15_000,
  source: 'builtin',
};

const verdict = {
  id: VERDICT_ID,
  nodeRunId: NODE_RUN_ID,
  point: 'tool',
  checkType: 'domain_allowlist',
  action: 'block',
  passed: false,
  reason: 'example.org is not on the allow-list.',
  at: NOW,
};

const toolCall = {
  id: TOOL_CALL_ID,
  nodeRunId: NODE_RUN_ID,
  toolName: 'http_request',
  args: { method: 'GET', url: 'https://example.org/' },
  resultSummary: 'blocked before the request was made',
  durationMs: 3,
  status: 'blocked',
  verdicts: [verdict],
  at: NOW,
};

const mcpServer = {
  id: MCP_SERVER_ID,
  name: 'Local test server',
  transport: 'stdio',
  command: 'node',
  args: ['./mcp-test-server.js'],
  status: 'connected',
  toolCount: 3,
  lastCheckedAt: NOW,
};

/* -------------------------------------------------------------------------- */
/* Tool definitions                                                            */
/* -------------------------------------------------------------------------- */

describe('FR-TOOL-001 ToolDefinition (round 4 §2.2)', () => {
  it('is exactly the shape §2.2 writes', () => {
    expect(ToolDefinitionSchema.parse(definition)).toEqual(definition);
  });

  it.each([
    'name',
    'description',
    'inputSchema',
    'outputSchema',
    'permissions',
    'timeoutMs',
    'source',
  ])('requires %s', (field) => {
    const partial: Record<string, unknown> = { ...definition };
    delete partial[field];

    expect(ToolDefinitionSchema.safeParse(partial).success).toBe(false);
  });

  it.each(['echo', 'web_search', 'code_sandbox', 'mcp_read_file', 'a', 'a1_b2'])(
    'accepts the snake_case name %s (round 4 §3)',
    (name) => {
      expect(ToolDefinitionSchema.safeParse({ ...definition, name }).success).toBe(true);
    },
  );

  it.each([
    ['camelCase', 'webSearch'],
    ['PascalCase', 'WebSearch'],
    ['SCREAMING_SNAKE', 'WEB_SEARCH'],
    ['kebab-case', 'web-search'],
    ['a dotted name', 'web.search'],
    ['a name with a space', 'web search'],
    ['a leading underscore', '_web_search'],
    ['a leading digit', '1_tool'],
    ['the empty name', ''],
  ])('refuses %s (%s)', (_label, name) => {
    expect(ToolDefinitionSchema.safeParse({ ...definition, name }).success).toBe(false);
  });

  it('pins the snake_case rule as a regex the engine and the UI share', () => {
    expect(TOOL_NAME_REGEX.test('code_sandbox')).toBe(true);
    expect(TOOL_NAME_REGEX.test('codeSandbox')).toBe(false);
  });

  it('states all three permissions, so none is left unchecked (FR-GRD-005)', () => {
    expect(ToolPermissionsSchema.parse(permissions)).toEqual(permissions);
    for (const field of ['network', 'fsPaths', 'destructive']) {
      const partial: Record<string, unknown> = { ...permissions };
      delete partial[field];
      expect(ToolPermissionsSchema.safeParse(partial).success, field).toBe(false);
    }
    expect(
      ToolPermissionsSchema.safeParse({ ...permissions, elevated: true }).success,
      'a permission §2.2 does not name is drift',
    ).toBe(false);
  });

  it('comes from the registry or from an MCP server, and says which (FR-TOOL-007)', () => {
    expect([...TOOL_SOURCES]).toEqual(['builtin', 'mcp']);
    expect(
      ToolDefinitionSchema.safeParse({
        ...definition,
        name: 'mcp_read_file',
        source: 'mcp',
        mcpServerId: MCP_SERVER_ID,
      }).success,
    ).toBe(true);
    expect(
      ToolDefinitionSchema.safeParse({ ...definition, source: 'mcp' }).success,
      'an mcp tool with no server could never be dropped with it',
    ).toBe(false);
    expect(
      ToolDefinitionSchema.safeParse({ ...definition, mcpServerId: MCP_SERVER_ID }).success,
      'a builtin tool belongs to no server',
    ).toBe(false);
  });

  it('refuses a timeout of zero or a fraction (FR-TOOL-001)', () => {
    for (const timeoutMs of [0, -1, 1.5]) {
      expect(ToolDefinitionSchema.safeParse({ ...definition, timeoutMs }).success).toBe(false);
    }
  });
});

describe('FR-TOOL-002 GET /tools registers each name once', () => {
  it('answers { items } (§2.4, D64)', () => {
    const body = { items: [definition, { ...definition, name: 'web_fetch' }] };

    expect(ToolListResponseSchema.parse(body)).toEqual(body);
  });

  it('refuses two tools of one name — `tools.enabled` holds names', () => {
    expect(ToolListResponseSchema.safeParse({ items: [definition, definition] }).success).toBe(
      false,
    );
  });
});

describe('§2.2 the six built-in tools', () => {
  it('names them in §2.2 order, and they are all snake_case', () => {
    expect([...BUILTIN_TOOL_NAMES]).toEqual([
      'echo',
      'code_sandbox',
      'sandbox_delete',
      'http_request',
      'web_search',
      'web_fetch',
    ]);
    for (const name of BUILTIN_TOOL_NAMES) {
      expect(TOOL_NAME_REGEX.test(name), name).toBe(true);
    }
  });

  it('runs code in the three languages §2.2 names (FR-TOOL-004, D13)', () => {
    expect([...SANDBOX_LANGUAGES]).toEqual(['javascript', 'python', 'shell']);
  });
});

/* -------------------------------------------------------------------------- */
/* Tool calls                                                                  */
/* -------------------------------------------------------------------------- */

describe('FR-TOOL-009 ToolCall (round 4 §2.2)', () => {
  it('is exactly the shape §2.2 writes', () => {
    expect(ToolCallSchema.parse(toolCall)).toEqual(toolCall);
  });

  it.each([...TOOL_CALL_STATUSES])('records a call that ended %s', (status) => {
    expect(ToolCallSchema.safeParse({ ...toolCall, status }).success).toBe(true);
  });

  it('declares exactly the five statuses §2.2 names', () => {
    expect([...TOOL_CALL_STATUSES]).toEqual(['ok', 'error', 'blocked', 'rejected', 'timeout']);
    expect(ToolCallSchema.safeParse({ ...toolCall, status: 'refused' }).success).toBe(false);
  });

  it('caps resultSummary at 500 characters (round 4 §3)', () => {
    expect(TOOL_RESULT_SUMMARY_MAX).toBe(500);
    expect(ToolCallSchema.safeParse({ ...toolCall, resultSummary: 'x'.repeat(500) }).success).toBe(
      true,
    );
    expect(ToolCallSchema.safeParse({ ...toolCall, resultSummary: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });

  it('carries the tool point verdicts that decided the call (FR-GRD-005, FR-GRD-015)', () => {
    const parsed = ToolCallSchema.parse(toolCall);

    expect(parsed.verdicts[0]?.checkType).toBe('domain_allowlist');
    expect(
      ToolCallSchema.safeParse({ ...toolCall, verdicts: [{ ...verdict, value: 'secret' }] }).success,
      'a verdict never carries the value it redacted (FR-GRD-014)',
    ).toBe(false);
  });

  it('refuses a full result beside the summary (FR-TOOL-010)', () => {
    for (const key of ['result', 'output', 'body', 'stdout']) {
      expect(ToolCallSchema.safeParse({ ...toolCall, [key]: 'x' }).success, key).toBe(false);
    }
  });

  it('refuses a negative duration and a name that is not snake_case', () => {
    expect(ToolCallSchema.safeParse({ ...toolCall, durationMs: -1 }).success).toBe(false);
    expect(ToolCallSchema.safeParse({ ...toolCall, toolName: 'httpRequest' }).success).toBe(false);
  });

  it('types NodeRun.toolCalls, which round 2 left as unknown[] (§2.2)', () => {
    const nodeRun = {
      id: NODE_RUN_ID,
      runId: RUN_ID,
      nodeId: NODE_A,
      iteration: 1,
      attempt: 1,
      status: 'COMPLETED',
      inputEnvelopes: [],
      usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
      verdicts: [],
      toolCalls: [toolCall],
    };

    const parsed = NodeRunSchema.parse(nodeRun);
    expect(parsed.toolCalls[0]?.toolName).toBe('http_request');
    expect(
      NodeRunSchema.safeParse({ ...nodeRun, toolCalls: [{ toolName: 'http_request' }] }).success,
      'an untyped tool call no longer passes',
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* MCP servers                                                                 */
/* -------------------------------------------------------------------------- */

describe('FR-TOOL-007 McpServer (round 4 §2.2, D16)', () => {
  it('is exactly the shape §2.2 writes', () => {
    expect(McpServerSchema.parse(mcpServer)).toEqual(mcpServer);
  });

  it('has exactly the three statuses §2.2 names (round 4 §3)', () => {
    expect([...MCP_SERVER_STATUSES]).toEqual(['starting', 'connected', 'unreachable']);
    for (const status of MCP_SERVER_STATUSES) {
      expect(McpServerSchema.safeParse({ ...mcpServer, status }).success, status).toBe(true);
    }
    for (const status of ['CONNECTED', 'UNKNOWN', 'AUTH_FAILED', 'stopped']) {
      expect(McpServerSchema.safeParse({ ...mcpServer, status }).success, status).toBe(false);
    }
  });

  it('is reached over one of the two transports §2.2 names', () => {
    expect([...MCP_TRANSPORTS]).toEqual(['stdio', 'http']);
    expect(
      McpServerSchema.safeParse({
        id: MCP_SERVER_ID,
        name: 'Remote',
        transport: 'http',
        url: 'http://127.0.0.1:9000/mcp',
        status: 'starting',
        toolCount: 0,
      }).success,
    ).toBe(true);
    expect(McpServerSchema.safeParse({ ...mcpServer, transport: 'sse' }).success).toBe(false);
  });

  it('names itself in 1..80 characters and counts its tools from zero', () => {
    expect(McpServerSchema.safeParse({ ...mcpServer, name: 'x'.repeat(80) }).success).toBe(true);
    expect(McpServerSchema.safeParse({ ...mcpServer, name: 'x'.repeat(81) }).success).toBe(false);
    expect(McpServerSchema.safeParse({ ...mcpServer, toolCount: 0 }).success).toBe(true);
    expect(McpServerSchema.safeParse({ ...mcpServer, toolCount: -1 }).success).toBe(false);
  });

  it('says why it is unreachable, and refuses a key-shaped extra field', () => {
    expect(
      McpServerSchema.parse({ ...mcpServer, status: 'unreachable', error: 'spawn ENOENT' }).error,
    ).toBe('spawn ENOENT');
    expect(McpServerSchema.safeParse({ ...mcpServer, apiKey: 'sk-live-1' }).success).toBe(false);
  });

  it('answers GET /mcp-servers as { items } (§2.4, D64)', () => {
    expect(McpServerListResponseSchema.parse({ items: [mcpServer] })).toEqual({
      items: [mcpServer],
    });
  });
});

describe('FR-TOOL-007 POST /mcp-servers', () => {
  it('takes a stdio server as a command with arguments', () => {
    const body = { name: 'Local', transport: 'stdio', command: 'node', args: ['server.js'] };

    expect(CreateMcpServerRequestSchema.parse(body)).toEqual(body);
  });

  it('takes an http server as a URL', () => {
    const body = { name: 'Remote', transport: 'http', url: 'http://127.0.0.1:9000/mcp' };

    expect(CreateMcpServerRequestSchema.parse(body)).toEqual(body);
  });

  it('refuses a server with no address at all', () => {
    for (const transport of MCP_TRANSPORTS) {
      expect(
        CreateMcpServerRequestSchema.safeParse({ name: 'Nowhere', transport }).success,
        transport,
      ).toBe(false);
    }
  });

  it('refuses the field belonging to the other transport, rather than ignoring it', () => {
    expect(
      CreateMcpServerRequestSchema.safeParse({
        name: 'Local',
        transport: 'stdio',
        command: 'node',
        url: 'http://127.0.0.1:9000/mcp',
      }).success,
    ).toBe(false);
    expect(
      CreateMcpServerRequestSchema.safeParse({
        name: 'Remote',
        transport: 'http',
        url: 'http://127.0.0.1:9000/mcp',
        args: ['--verbose'],
      }).success,
    ).toBe(false);
  });

  it('refuses a url that is not a URL, and a status the client tried to set', () => {
    expect(
      CreateMcpServerRequestSchema.safeParse({ name: 'Remote', transport: 'http', url: 'nope' })
        .success,
    ).toBe(false);
    expect(
      CreateMcpServerRequestSchema.safeParse({ ...mcpServer, id: undefined }).success,
      'the engine owns id, status and toolCount',
    ).toBe(false);
  });
});

describe('round 4 §2.4 the two validation codes tools add', () => {
  it('names an enabled tool that no longer exists, and an unreachable server', () => {
    expect([...ROUND_4_VALIDATION_ISSUE_CODES]).toEqual([
      'tool_not_registered',
      'mcp_server_unreachable',
    ]);
    expect(VALIDATION_ISSUE_CODES).toContain('tool_not_registered');
    expect(VALIDATION_ISSUE_CODES).toContain('mcp_server_unreachable');
  });

  it('keeps incompatible_model as round 2 named it, now covering media inputs (FR-MM-005)', () => {
    expect(VALIDATION_ISSUE_CODES.filter((code) => code === 'incompatible_model')).toHaveLength(1);
    expect(ROUND_4_VALIDATION_ISSUE_CODES).not.toContain('incompatible_model');
  });
});
