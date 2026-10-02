import type { Id, MemoryEntry } from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '../app/api';
import { getSocket } from '../app/socket';

/** One agent's long-term memory (round 5 §2.2, FR-MEM-004). Local to the Memory tab. */
export const memoryQueryKeys = {
  node: (nodeId: Id) => ['node-memory', nodeId] as const,
};

/** `GET /nodes/:id/memory` → `MemoryEntry[]`, oldest first; idle without a node. */
export function useNodeMemory(nodeId: Id | undefined) {
  return useQuery({
    queryKey: memoryQueryKeys.node(nodeId ?? ''),
    queryFn: (): Promise<MemoryEntry[]> => api().listNodeMemory(nodeId!),
    enabled: nodeId !== undefined,
  });
}

/** `DELETE /nodes/:id/memory/:entryId` (FR-MEM-004). */
export function useDeleteMemoryEntry(nodeId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryId: Id) => api().deleteNodeMemoryEntry(nodeId, entryId),
    onSuccess: (_void, entryId) => {
      queryClient.setQueryData<MemoryEntry[]>(memoryQueryKeys.node(nodeId), (entries) =>
        entries?.filter((entry) => entry.id !== entryId),
      );
      void queryClient.invalidateQueries({ queryKey: memoryQueryKeys.node(nodeId) });
    },
  });
}

/** `DELETE /nodes/:id/memory` (FR-MEM-004): every entry of the node. */
export function useClearMemory(nodeId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api().clearNodeMemory(nodeId),
    onSuccess: () => {
      queryClient.setQueryData<MemoryEntry[]>(memoryQueryKeys.node(nodeId), []);
      void queryClient.invalidateQueries({ queryKey: memoryQueryKeys.node(nodeId) });
    },
  });
}

/**
 * `memory.updated` is engine scope (D230): a run saving a fact, or a delete from anywhere, refetches
 * that node's list so the tab follows without a reload — the engine owns the truth (BR-01). The
 * global socket is already subscribed to the engine scope; this only attaches a handler.
 */
export function useMemorySubscription(nodeId: Id | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    if (!socket || nodeId === undefined) return;
    return socket.on('memory.updated', (payload) => {
      if (payload.nodeId !== nodeId) return;
      void queryClient.invalidateQueries({ queryKey: memoryQueryKeys.node(nodeId) });
    });
  }, [queryClient, nodeId]);
}
