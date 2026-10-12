import type { McpServer, ToolDefinition } from '@ace/contracts';
import { Badge, ToolPermissionBadges } from '@ace/ui';

/**
 * The tool registry table (round 4 §5 item 6, FR-TOOL-001): one row per registered tool — its name,
 * description, source (a built-in, or the MCP server it came from), permission badges and timeout.
 * The engine owns the registry, so this only renders what `GET /tools` returned; a built-in and an
 * MCP tool differ only in the source column. A theme table: 12.5px rows on hairline dividers (D328).
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
      <p className="py-10 text-center text-[13px] text-[var(--muted)]">No tools registered.</p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-[12px] border border-[var(--line)] bg-[var(--surface)]">
      <table className="w-full border-collapse text-left text-[12.5px]" data-testid="tool-registry">
        <thead>
          <tr className="h-9 font-machine text-[9.5px] uppercase tracking-[0.1em] text-[var(--muted)]">
            <th className="px-3 font-medium">Tool</th>
            <th className="px-3 font-medium">Source</th>
            <th className="px-3 font-medium">Permissions</th>
            <th className="px-3 text-right font-medium">Timeout</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr
              key={tool.name}
              data-testid={`tool-row-${tool.name}`}
              data-source={tool.source}
              className="border-t border-[var(--line)] align-top"
            >
              <td className="px-3 py-[9px]">
                <p className="font-machine text-[12px] font-medium">{tool.name}</p>
                <p className="mt-0.5 text-[11px] leading-[1.45] text-[var(--muted)]">
                  {tool.description}
                </p>
              </td>
              <td className="px-3 py-[9px]">
                <Badge variant={tool.source === 'mcp' ? 'accent' : 'outline'}>
                  {sourceLabel(tool, servers)}
                </Badge>
              </td>
              <td className="px-3 py-[9px]">
                <ToolPermissionBadges permissions={tool.permissions} />
              </td>
              <td className="whitespace-nowrap px-3 py-[9px] text-right font-machine text-[11px] text-[var(--muted)]">
                {tool.timeoutMs} ms
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
