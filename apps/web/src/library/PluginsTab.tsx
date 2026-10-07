import { McpServersPanel } from './McpServersPanel';
import { useMcpStatusSubscription } from './tools-hooks';

/**
 * Library › Plugins (ACE parity P1, D273, FR-TOOL-007): a plugin is an MCP server. Connecting one
 * adds its tools to the registry; it enables them for no agent — each agent turns tools on in its
 * own Tools section. `mcp.status` keeps the chips current.
 */
export function PluginsTab() {
  useMcpStatusSubscription();
  return (
    <section className="flex flex-col gap-4" data-testid="plugins-tab">
      <header>
        <h2 className="font-human text-lg font-semibold">Plugins</h2>
        <p className="mt-1 font-human text-sm text-fg-muted">
          A plugin is an MCP server that gives agents more tools. Connecting one enables nothing:
          turn its tools on per agent, in the agent’s Tools section.
        </p>
      </header>
      <McpServersPanel />
    </section>
  );
}
