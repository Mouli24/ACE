/**
 * A local MCP test server over stdio (round 4 §4 item 6, TC-TOOL-008), matched to the engine's
 * minimal MCP client in `packages/tools/src/mcp` (D16). One JSON-RPC 2.0 message per line on stdin
 * and stdout — no MCP SDK, no network. Logs go to stderr only, because the client ignores any stdout
 * line that is not a JSON-RPC frame but stderr keeps them out of the way entirely.
 *
 * Launch it as a stdio MCP server:
 *   command: process.execPath            (the node binary)
 *   args:    ['tests/acceptance/fixtures/round-4/servers/mcp-server.mjs']
 * A harness sends that as a CreateMcpServerRequest, e.g.
 *   { name: 'fixtures', transport: 'stdio', command: <node>, args: [<abs path to this file>] }
 * and the engine namespaces the two tools below `mcp_<slug(name)>_<tool>` — with name 'fixtures':
 *   mcp_fixtures_ping      and      mcp_fixtures_reverse
 *
 * The two tools:
 *   - `ping`    ({})            -> text "pong". No required args, so `mock-mcp` (which calls the
 *                                  first mcp_ tool with `{}`) can call it. Listed first for that.
 *   - `reverse` ({ text })      -> the text reversed. Shows an MCP tool that takes an argument.
 * Both are read-only / non-destructive (no `destructiveHint`), so they map to
 * `{ network: true, destructive: false }` permissions in the registry.
 */

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'ping',
    description: 'Replies with "pong". Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  {
    name: 'reverse',
    description: 'Returns the given text reversed.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
];

/** Builds the `content` block a `tools/call` result carries: one text part the client flattens. */
const textResult = (text) => ({ content: [{ type: 'text', text }], isError: false });

function handle(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'ace-fixture-mcp', version: '0.0.0' },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'ping') return textResult('pong');
      if (name === 'reverse') {
        const text = typeof args.text === 'string' ? args.text : '';
        return textResult([...text].reverse().join(''));
      }
      return { __error: { code: -32601, message: `Unknown tool: ${String(name)}` } };
    }
    case 'ping':
      return {};
    default:
      return { __error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) dispatch(line);
    newline = buffer.indexOf('\n');
  }
});

function dispatch(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // Not a JSON-RPC frame.
  }
  // A notification (no `id`) — e.g. `notifications/initialized`. Nothing to answer.
  if (message.id === undefined || message.id === null) return;

  const outcome = handle(message.method, message.params);
  const response =
    outcome && outcome.__error
      ? { jsonrpc: '2.0', id: message.id, error: outcome.__error }
      : { jsonrpc: '2.0', id: message.id, result: outcome };
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

process.stderr.write('ace-fixture-mcp: ready (stdio)\n');
