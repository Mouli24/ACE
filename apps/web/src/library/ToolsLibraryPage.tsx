import { McpServersPanel } from './McpServersPanel';
import { ToolRegistryTable } from './ToolRegistryTable';
import { useMcpServers, useMcpStatusSubscription, useTools } from './tools-hooks';

/**
 * `/library/tools` (Arch §33.2, Library › Tools; round 4 §5 item 6, FR-TOOL-001/007): the tool
 * registry — every built-in and every connected MCP server's tools, with their permissions and
 * timeout — over the panel that connects, checks and removes MCP servers. `mcp.status` keeps both
 * current without a reload. Theme page layout, table and cards (D328).
 */
export function ToolsLibraryPage() {
  useMcpStatusSubscription();
  const tools = useTools();
  const servers = useMcpServers();

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-8 px-6 py-8">
        <header>
          <h1 className="text-[20px] font-bold tracking-[-0.01em]">Tools</h1>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            The tools agents can call — built-ins and those from connected MCP servers
            (FR-TOOL-001).
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-[14px] font-bold">Registry</h2>
          {tools.isPending && <p className="text-[13px] text-[var(--muted)]">Loading tools…</p>}
          {tools.isError && (
            <p role="alert" className="text-[12px] text-[#c94c27]">
              Could not load tools: {tools.error.message}
            </p>
          )}
          {tools.data && <ToolRegistryTable tools={tools.data} servers={servers.data ?? []} />}
        </section>

        <McpServersPanel />
      </div>
    </main>
  );
}
