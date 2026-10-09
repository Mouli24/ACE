import { z } from 'zod';

import { IdSchema, TimestampSchema } from './graph.js';
import { VerdictSchema } from './guardrails.js';

/**
 * Tools, tool calls and MCP servers (round 4 §2.2, FR-TOOL-001..003, 005..007, 009, 010,
 * FR-GRD-005/006, Arch §16, D13 sandbox, D14 SearXNG, D16 MCP).
 *
 * Every body here is strict, as round 3's are. On this seam a stray key is how a permission would
 * appear that no guardrail checks (FR-GRD-005), or how the raw result of a tool call would ride
 * along beside its 500-character summary into the event log (FR-TOOL-009).
 */

/* -------------------------------------------------------------------------- */
/* Tool definitions (§2.2, FR-TOOL-001)                                        */
/* -------------------------------------------------------------------------- */

/**
 * A tool's input and output schema, as JSON Schema. Typed the way an agent's `outputContract` is
 * (`graph.ts`): an open record, of which `SUPPORTED_JSON_SCHEMA_KEYWORDS` is the part the engine
 * evaluates (D53).
 */
export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

/** A tool name is snake_case: lowercase, digits and underscores, starting with a letter (§2.2). */
export const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
export const ToolNameSchema = z
  .string()
  .regex(TOOL_NAME_REGEX, 'must be snake_case, such as web_search');

/**
 * What a tool is allowed to touch (FR-TOOL-001). All three are required, so a tool cannot be
 * registered with a permission left unstated: §2.2's table writes `web_search` as `{ network:true }`
 * and the registry fills in `fsPaths: []` and `destructive: false`.
 *
 * `destructive: true` is what makes a call wait for approval (FR-GRD-006, BR-14).
 */
export const ToolPermissionsSchema = z.strictObject({
  network: z.boolean(),
  /** The folders the tool may read or write; a code sandbox names `<runId>`'s sandbox folder. */
  fsPaths: z.array(z.string()),
  destructive: z.boolean(),
});
export type ToolPermissions = z.infer<typeof ToolPermissionsSchema>;

/** Where a tool came from: the engine's own registry, or a connected MCP server (FR-TOOL-007). */
export const TOOL_SOURCES = ['builtin', 'mcp'] as const;
export const ToolSourceSchema = z.enum(TOOL_SOURCES);
export type ToolSource = z.infer<typeof ToolSourceSchema>;

export const ToolDefinitionSchema = z
  .strictObject({
    name: ToolNameSchema,
    description: z.string(),
    inputSchema: JsonSchemaSchema,
    outputSchema: JsonSchemaSchema,
    permissions: ToolPermissionsSchema,
    timeoutMs: z.number().int().positive(),
    source: ToolSourceSchema,
    /** Present exactly when `source` is `mcp`: the server whose tool this is. */
    mcpServerId: IdSchema.optional(),
  })
  .superRefine((tool, ctx) => {
    if (tool.source === 'mcp' && tool.mcpServerId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['mcpServerId'],
        message: 'An mcp tool names the server it came from, so it can be dropped with it.',
      });
    }
    if (tool.source === 'builtin' && tool.mcpServerId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['mcpServerId'],
        message: 'A builtin tool belongs to no MCP server.',
      });
    }
  });
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/**
 * The registry's list. A name is unique across the whole registry — an agent's
 * `tools.enabled` holds names, so two tools called the same thing would make "which tool did the
 * agent enable?" unanswerable (§2.2).
 */
const ToolDefinitionsSchema = z.array(ToolDefinitionSchema).superRefine((tools, ctx) => {
  const seen = new Set<string>();
  tools.forEach((tool, index) => {
    if (seen.has(tool.name)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'name'],
        message: `Tool ${tool.name} is registered twice.`,
      });
    }
    seen.add(tool.name);
  });
});

/** `GET /tools` → `{ items: ToolDefinition[] }` (§2.4, D64). */
export const ToolListResponseSchema = z.strictObject({ items: ToolDefinitionsSchema });
export type ToolListResponse = z.infer<typeof ToolListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* The built-in tools (§2.2)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The built-in tool names, in §2.2's order and then X1's (FR-TOOL-008, D266). Frozen and shared, so
 * the engine's registry, an agent's `tools.enabled` list and the web app's tools screen cannot
 * disagree about what a built-in tool is called (D52's reasoning). `sandbox_delete` and
 * `run_command` are the destructive ones, so they are the ones that ask for approval (FR-GRD-006).
 */
export const BUILTIN_TOOL_NAMES = [
  'echo',
  'code_sandbox',
  'sandbox_delete',
  'http_request',
  'web_search',
  'web_fetch',
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'git_status',
  'git_diff',
  'run_command',
] as const;
export const BuiltinToolNameSchema = z.enum(BUILTIN_TOOL_NAMES);
export type BuiltinToolName = z.infer<typeof BuiltinToolNameSchema>;

/** The languages `code_sandbox` runs (§2.2, FR-TOOL-004, D13). */
export const SANDBOX_LANGUAGES = ['javascript', 'python', 'shell'] as const;
export const SandboxLanguageSchema = z.enum(SANDBOX_LANGUAGES);
export type SandboxLanguage = z.infer<typeof SandboxLanguageSchema>;

/* -------------------------------------------------------------------------- */
/* Tool calls (§2.2, FR-TOOL-009)                                              */
/* -------------------------------------------------------------------------- */

/**
 * How a call ended. `blocked` is a guardrail's verdict at the tool point and `rejected` a user's
 * answer to an approval card — kept apart from `error` because one is the system refusing and one
 * is the person refusing (BR-12's reasoning), and both fail the node `GUARDRAIL_VIOLATION`.
 */
export const TOOL_CALL_STATUSES = ['ok', 'error', 'blocked', 'rejected', 'timeout'] as const;
export const ToolCallStatusSchema = z.enum(TOOL_CALL_STATUSES);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/** Long enough to read in the inspector, short enough that a result cannot be smuggled in (§2.2). */
export const TOOL_RESULT_SUMMARY_MAX = 500;

/**
 * One logged call (FR-TOOL-009): what was called, with which arguments (secrets redacted by the
 * data guardrail, BR-07), a summary of what came back, how long it took, and the verdicts the tool
 * point recorded. The full result is never stored here — it goes back to the model as untrusted
 * content (FR-TOOL-010, BR-13) and the summary is what the inspector and the event log carry.
 */
export const ToolCallSchema = z.strictObject({
  id: IdSchema,
  nodeRunId: IdSchema,
  toolName: ToolNameSchema,
  /** Open, as §2.2 types it; the engine redacts key-shaped values before it stores them. */
  args: z.unknown(),
  resultSummary: z.string().max(TOOL_RESULT_SUMMARY_MAX),
  durationMs: z.number().int().min(0),
  status: ToolCallStatusSchema,
  verdicts: z.array(VerdictSchema),
  at: TimestampSchema,
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/* -------------------------------------------------------------------------- */
/* MCP servers (§2.2, FR-TOOL-007, D16)                                        */
/* -------------------------------------------------------------------------- */

export const MCP_SERVER_NAME_MAX = 80;
export const McpServerNameSchema = z.string().min(1).max(MCP_SERVER_NAME_MAX);

export const MCP_TRANSPORTS = ['stdio', 'http'] as const;
export const McpTransportSchema = z.enum(MCP_TRANSPORTS);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/**
 * A server's liveness. Lowercase, unlike `ProviderState`, because §2.2 writes it so — and there
 * are three, not six: an MCP server has no key to fail with and no rate limit to hit.
 */
export const MCP_SERVER_STATUSES = ['starting', 'connected', 'unreachable'] as const;
export const McpServerStatusSchema = z.enum(MCP_SERVER_STATUSES);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const McpServerSchema = z.strictObject({
  id: IdSchema,
  name: McpServerNameSchema,
  transport: McpTransportSchema,
  /** `stdio`: the command the engine spawns, and its arguments. */
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  /** `http`: the address the engine connects to. */
  url: z.url().optional(),
  status: McpServerStatusSchema,
  /** How many tools this server contributed to the registry at `lastCheckedAt`. */
  toolCount: z.number().int().min(0),
  lastCheckedAt: TimestampSchema.optional(),
  /** Why it is `unreachable`, in words the servers screen can show. */
  error: z.string().optional(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/**
 * `POST /mcp-servers` → `McpServer` (§2.4). The transport decides which address field is required:
 * a `stdio` server is a command, an `http` server is a URL, and the field belonging to the other
 * transport is refused rather than quietly ignored.
 */
export const CreateMcpServerRequestSchema = z
  .strictObject({
    name: McpServerNameSchema,
    transport: McpTransportSchema,
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.url().optional(),
  })
  .superRefine((request, ctx) => {
    const required = request.transport === 'stdio' ? 'command' : 'url';
    const forbidden = request.transport === 'stdio' ? 'url' : 'command';

    if (request[required] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [required],
        message: `A ${request.transport} MCP server needs a ${required}.`,
      });
    }
    if (request[forbidden] !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [forbidden],
        message: `A ${request.transport} MCP server has no ${forbidden}.`,
      });
    }
    if (request.transport === 'http' && request.args !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['args'],
        message: 'Arguments belong to a stdio command.',
      });
    }
  });
export type CreateMcpServerRequest = z.infer<typeof CreateMcpServerRequestSchema>;

/** `GET /mcp-servers` → `{ items: McpServer[] }` (§2.4, D64). */
export const McpServerListResponseSchema = z.strictObject({
  items: z.array(McpServerSchema),
});
export type McpServerListResponse = z.infer<typeof McpServerListResponseSchema>;
