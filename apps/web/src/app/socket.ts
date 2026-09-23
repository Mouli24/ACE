import { createAceSocket, type AceSocket } from '@ace/sdk';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { patchProviderStatus } from '../providers/status-patch';
import { peekGraphSync } from '../workflows/sync-registry';
import { queryKeys } from '../workflows/query-keys';
import { wsUrl } from './env';

let socket: AceSocket | undefined;

export interface StartSocketOptions {
  token: string;
  queryClient: QueryClient;
  url?: string;
  WebSocket?: typeof WebSocket;
}

/**
 * The single WebSocket client (Arch §10.1). `workflow.updated` patches the query cache: the open
 * workflow's GraphSync decides (it knows about pending edits); any other workflow is invalidated.
 */
export function startSocket(options: StartSocketOptions): AceSocket {
  if (socket) return socket;
  socket = createAceSocket({
    url: options.url ?? wsUrl(),
    token: options.token,
    ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
  });
  socket.on('workflow.updated', ({ workflowId, version }) => {
    const sync = peekGraphSync(workflowId);
    if (sync) void sync.onRemoteVersion(version);
    else void options.queryClient.invalidateQueries({ queryKey: queryKeys.workflow(workflowId) });
  });
  // FR-PRV-004: provider status is engine-scope and patches the cache, so no screen reloads.
  socket.on('provider.status', (payload) => patchProviderStatus(options.queryClient, payload));
  socket.subscribe({ scope: 'engine' });
  socket.connect();
  return socket;
}

export function getSocket(): AceSocket | undefined {
  return socket;
}

/** Tests only. */
export function stopSocket(): void {
  socket?.close();
  socket = undefined;
}

/** Subscribe to `workflow.updated` for the open workflow while its Canvas is mounted (§2.9). */
export function useWorkflowSubscription(workflowId: string | undefined): void {
  useEffect(() => {
    if (!workflowId || !socket) return;
    const payload = { scope: 'workflow' as const, id: workflowId };
    socket.subscribe(payload);
    return () => socket?.unsubscribe(payload);
  }, [workflowId]);
}
