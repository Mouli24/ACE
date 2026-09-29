import type { McpServer, ToolDefinition } from '@ace/contracts';
import { Badge, ToolPermissionBadges } from '@ace/ui';

/**
 * The tool registry table (round 4 §5 item 6, FR-TOOL-001): one row per registered tool — its name,
 * description, source (a built-in, or the MCP server it came from), permission badges and timeout.
 * The engine owns the registry, so this only renders what `GET /tools` returned; a built-in and an
 * MCP tool differ only in the source column.
 */

/** The MCP server a tool came from, named for the source column; `builtin` tools have none. */
function sourceLabel(tool: ToolDefinition, servers: McpServer[]): string {
  if (tool.source === 'builtin') return 'builtin';
  const server = servers.find((each) => each.id === tool.mcpServerId);
  return server ? server.name : 'MCP';
}

export function ToolRegistryTable({
  tools,
  servers,
}: {
  tools: ToolDefinition[];
  servers: McpServer[];
}) {
  if (tools.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-border p-8 text-center text-fg-muted">
        No tools registered.
      </p>
    );
  }

  return (
    <table className="w-full border-collapse text-left text-sm" data-testid="tool-registry">
      <thead>
        <tr className="border-b border-border font-machine text-[10px] uppercase tracking-wider text-fg-muted">
          <th className="py-2 pr-3 font-medium">Tool</th>
          <th className="py-2 pr-3 font-medium">Source</th>
          <th className="py-2 pr-3 font-medium">Permissions</th>
          <th className="py-2 pr-3 text-right font-medium">Timeout</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((tool) => (
          <tr
            key={tool.name}
            data-testid={`tool-row-${tool.name}`}
            data-source={tool.source}
            className="border-b border-border/60 align-top"
          >
            <td className="py-2.5 pr-3">
              <p className="font-machine text-sm text-fg">{tool.name}</p>
              <p className="mt-0.5 font-human text-xs text-fg-muted">{tool.description}</p>
            </td>
            <td className="py-2.5 pr-3">
              <Badge variant={tool.source === 'mcp' ? 'accent' : 'outline'}>
                {sourceLabel(tool, servers)}
              </Badge>
            </td>
            <td className="py-2.5 pr-3">
              <ToolPermissionBadges permissions={tool.permissions} />
            </td>
            <td className="py-2.5 pr-3 text-right font-machine text-xs text-fg-muted">
              {tool.timeoutMs} ms
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
