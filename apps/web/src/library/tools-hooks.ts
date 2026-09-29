import type { CreateMcpServerRequest, Id, McpServer, ToolDefinition } from '@ace/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '../app/api';
import { getSocket } from '../app/socket';

/**
 * Engine data for the Tools library (round 4 §5 item 6, FR-TOOL-001/007). The registry and the MCP
 * server list are their own query keys — a server coming up or going away adds or drops its tools,
 * so a write to one always invalidates the other (a connected server contributes `mcp_<name>_*`
 * tools; removing it takes them back out). Keys are local to this screen; nothing else reads them.
 */
export const toolQueryKeys = {
  tools: () => ['tools'] as const,
  mcpServers: () => ['mcp-servers'] as const,
};

/** `GET /tools` → `{ items }` (FR-TOOL-001). The registry is small, so it is fetched whole. */
export function useTools() {
  return useQuery({
    queryKey: toolQueryKeys.tools(),
    queryFn: async () => (await api().listTools()).items,
  });
}

/** `GET /mcp-servers` → `{ items }` (FR-TOOL-007). */
export function useMcpServers() {
  return useQuery({
    queryKey: toolQueryKeys.mcpServers(),
    queryFn: async () => (await api().listMcpServers()).items,
  });
}

/** A server's tools join or leave the registry on any change, so both lists refetch (FR-TOOL-007). */
function invalidateToolsAndServers(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: toolQueryKeys.tools() });
  void queryClient.invalidateQueries({ queryKey: toolQueryKeys.mcpServers() });
}

/** `POST /mcp-servers` (FR-TOOL-007). Answers the `McpServer` with its status and tool count. */
export function useCreateMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMcpServerRequest): Promise<McpServer> => api().createMcpServer(body),
    onSuccess: () => invalidateToolsAndServers(queryClient),
  });
}

/** `POST /mcp-servers/:id/check` (FR-TOOL-007): re-checks liveness and the tool count. */
export function useCheckMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id): Promise<McpServer> => api().checkMcpServer(id),
    onSuccess: () => invalidateToolsAndServers(queryClient),
  });
}

/** `DELETE /mcp-servers/:id` (FR-TOOL-007): its tools leave the registry with it. */
export function useDeleteMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id): Promise<void> => api().deleteMcpServer(id),
    onSuccess: () => invalidateToolsAndServers(queryClient),
  });
}

/**
 * `mcp.status` is engine scope (§2.5): a server changing state, or its tool count changing, patches
 * the cache so the chip and the registry follow without a reload — the engine owns the truth (BR-01),
 * the same shape as `provider.status`. The global socket is already subscribed to the engine scope,
 * so this only attaches a handler while the screen is mounted.
 */
export function useMcpStatusSubscription(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    return socket.on('mcp.status', () => invalidateToolsAndServers(queryClient));
  }, [queryClient]);
}

/** Group the registry by source so the table can show built-ins first, then each MCP server's. */
export function toolsBySource(tools: ToolDefinition[]): {
  builtin: ToolDefinition[];
  mcp: ToolDefinition[];
} {
  return {
    builtin: tools.filter((tool) => tool.source === 'builtin'),
    mcp: tools.filter((tool) => tool.source === 'mcp'),
  };
}
