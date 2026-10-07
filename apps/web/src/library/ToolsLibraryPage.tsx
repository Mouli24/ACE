import { McpServersPanel } from './McpServersPanel';
import { ToolRegistryTable } from './ToolRegistryTable';
import { useMcpServers, useMcpStatusSubscription, useTools } from './tools-hooks';

/**
 * Library › Tools (Arch §33.2; round 4 §5 item 6, FR-TOOL-001/007): the tool registry — every
 * built-in and every connected MCP server's tools, with their permissions and timeout — over the
 * panel that connects, checks and removes MCP servers, which the Plugins tab also shows (ACE
 * parity P1). `mcp.status` keeps both current without a reload. Rendered by `LibraryPage` at
 * `/library/tools`.
 */
export function ToolsTab() {
  useMcpStatusSubscription();
  const tools = useTools();
  const servers = useMcpServers();

  return (
    <div className="flex flex-col gap-8" data-testid="tools-tab">
      <header>
        <h2 className="font-human text-lg font-semibold">Tools</h2>
        <p className="mt-1 font-human text-sm text-fg-muted">
          The tools agents can call — built-ins and those from connected MCP servers (FR-TOOL-001).
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h3 className="font-human text-base font-semibold">Registry</h3>
        {tools.isPending && <p className="text-fg-muted">Loading tools…</p>}
        {tools.isError && (
          <p role="alert" className="text-danger">
            Could not load tools: {tools.error.message}
          </p>
        )}
        {tools.data && <ToolRegistryTable tools={tools.data} servers={servers.data ?? []} />}
      </section>

      <McpServersPanel />
    </div>
  );
}
