import { McpServersPanel } from './McpServersPanel';
import { ToolRegistryTable } from './ToolRegistryTable';
import { useMcpServers, useMcpStatusSubscription, useTools } from './tools-hooks';

/**
 * `/library/tools` (Arch §33.2, Library › Tools; round 4 §5 item 6, FR-TOOL-001/007): the tool
 * registry — every built-in and every connected MCP server's tools, with their permissions and
 * timeout — over the panel that connects, checks and removes MCP servers. `mcp.status` keeps both
 * current without a reload.
 */
export function ToolsLibraryPage() {
  useMcpStatusSubscription();
  const tools = useTools();
  const servers = useMcpServers();

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col gap-8 overflow-y-auto px-4 py-10">
      <header>
        <h1 className="font-human text-2xl font-semibold">Tools</h1>
        <p className="mt-1 font-human text-sm text-fg-muted">
          The tools agents can call — built-ins and those from connected MCP servers (FR-TOOL-001).
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="font-human text-lg font-semibold">Registry</h2>
        {tools.isPending && <p className="text-fg-muted">Loading tools…</p>}
        {tools.isError && (
          <p role="alert" className="text-danger">
            Could not load tools: {tools.error.message}
          </p>
        )}
        {tools.data && <ToolRegistryTable tools={tools.data} servers={servers.data ?? []} />}
      </section>

      <McpServersPanel />
    </main>
  );
}
