import type { McpServer, ToolDefinition } from '@ace/contracts';

/**
 * The tool registry the mock serves at `GET /tools` (round 4 §2.2, FR-TOOL-001). The built-ins
 * are the contract's own names and permissions, so the tools screen and an agent's `tools.enabled`
 * list mean the same thing here as against the real engine. A connected MCP server contributes its
 * tools prefixed `mcp_<server>_<tool>` (FR-TOOL-007, D16), which is what `mock-mcp` reaches for.
 */

/** The sandbox folder a code tool is confined to, as §2.2 writes it. */
export const SANDBOX_PATH = '<sandbox>';

/** X1's project tools (FR-TOOL-008), shaped as the engine registers them; `run_command` asks for approval. */
const projectTool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  outputSchema: { type: 'object' },
  permissions: {
    network: name === 'run_command',
    fsPaths: ['<project>'],
    destructive: name === 'run_command',
  },
  timeoutMs: name === 'run_command' ? 600_000 : 10_000,
  source: 'builtin',
});

export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'echo',
    description: 'Return the text it was given — the test tool.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    outputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    permissions: { network: false, fsPaths: [], destructive: false },
    timeoutMs: 5_000,
    source: 'builtin',
  },
  {
    name: 'code_sandbox',
    description: 'Run JavaScript, Python or shell in an isolated sandbox folder.',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['javascript', 'python', 'shell'] },
        code: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['language', 'code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        exitCode: { type: 'number' },
        files: { type: 'array' },
      },
      required: ['stdout', 'stderr', 'exitCode'],
    },
    permissions: { network: false, fsPaths: [SANDBOX_PATH], destructive: false },
    timeoutMs: 30_000,
    source: 'builtin',
  },
  {
    name: 'sandbox_delete',
    description: 'Delete a file inside the sandbox folder. Destructive — asks for approval.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    outputSchema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' } },
      required: ['deleted'],
    },
    permissions: { network: false, fsPaths: [SANDBOX_PATH], destructive: true },
    timeoutMs: 5_000,
    source: 'builtin',
  },
  {
    name: 'http_request',
    description: 'Make an HTTP request to an allow-listed domain.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        url: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'string' },
      },
      required: ['method', 'url'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'number' },
        headers: { type: 'object' },
        body: { type: 'string' },
      },
      required: ['status', 'headers', 'body'],
    },
    permissions: { network: true, fsPaths: [], destructive: false },
    timeoutMs: 15_000,
    source: 'builtin',
  },
  {
    name: 'web_search',
    description: 'Search the web and return the top results.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, k: { type: 'number' } },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: { results: { type: 'array' } },
      required: ['results'],
    },
    permissions: { network: true, fsPaths: [], destructive: false },
    timeoutMs: 15_000,
    source: 'builtin',
  },
  {
    name: 'web_fetch',
    description: 'Fetch a page and return its readable text.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    outputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, text: { type: 'string' } },
      required: ['title', 'text'],
    },
    permissions: { network: true, fsPaths: [], destructive: false },
    timeoutMs: 20_000,
    source: 'builtin',
  },
  projectTool('list_files', 'List files and folders in the project folder.', { path: { type: 'string' }, recursive: { type: 'boolean' } }, []),
  projectTool('read_file', 'Read a text file in the project folder.', { path: { type: 'string' } }, ['path']),
  projectTool('write_file', 'Create or overwrite a file in the project folder.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  projectTool('edit_file', 'Replace exact text in a file in the project folder.', { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } }, ['path', 'oldString', 'newString']),
  projectTool('git_status', 'Show the project repository’s branch and changed files.', {}, []),
  projectTool('git_diff', 'Show the project’s uncommitted changes.', { staged: { type: 'boolean' }, path: { type: 'string' } }, []),
  projectTool('run_command', 'Run a shell command in the project folder. Asks for approval.', { command: { type: 'string' } }, ['command']),
];

/** A server name reduced to a snake_case fragment a tool name can carry (`ToolNameSchema`). */
export function serverSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(slug) ? slug : `s_${slug || 'server'}`;
}

/** The two tools the fixture MCP test server contributes, without their `mcp_<server>_` prefix. */
export const MCP_FIXTURE_TOOL_NAMES = ['search', 'echo'] as const;

/**
 * The tool definitions a connected MCP server adds to the registry (FR-TOOL-007, D16). Named
 * `mcp_<server>_<tool>`; `mock-mcp` calls the first one whose name starts with `mcp_`. MCP tools
 * carry `network:true` and `destructive:false` unless the server annotates otherwise (D16).
 */
export function mcpToolDefinitions(server: McpServer): ToolDefinition[] {
  const slug = serverSlug(server.name);
  return MCP_FIXTURE_TOOL_NAMES.map((tool) => ({
    name: `mcp_${slug}_${tool}`,
    description: `${tool} tool from the "${server.name}" MCP server.`,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
    permissions: { network: true, fsPaths: [], destructive: false },
    timeoutMs: 15_000,
    source: 'mcp',
    mcpServerId: server.id,
  }));
}

/** How many tools a reachable MCP server contributes — the `toolCount` a `connected` server shows. */
export const MCP_FIXTURE_TOOL_COUNT = MCP_FIXTURE_TOOL_NAMES.length;
