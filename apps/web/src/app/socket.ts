import type { Provider } from '@ace/contracts';
import { createAceSocket, type AceSocket } from '@ace/sdk';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { patchProviderStatus } from '../providers/status-patch';
import { peekGraphSync } from '../workflows/sync-registry';
import { queryKeys } from '../workflows/query-keys';
import { wsUrl } from './env';
import { markSessionLost } from './stores/session';

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
  socket.on('provider.status', (payload) => {
    const cached = options.queryClient.getQueryData<Provider[]>(queryKeys.providers());
    const before = cached?.find((provider) => provider.id === payload.providerId);
    patchProviderStatus(options.queryClient, payload);
    // PG-1.4 (D359): a provider the engine added itself (the local Ollama) is not cached yet.
    if (cached !== undefined && before === undefined) {
      void options.queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
      void options.queryClient.invalidateQueries({ queryKey: queryKeys.modelsRoot() });
    } else if (payload.status === 'CONNECTED' && before?.status !== 'CONNECTED') {
      // Audit P-10: a provider that just connected has models now; an open model picker that said
      // "No provider is connected yet" fills in without a reload.
      void options.queryClient.invalidateQueries({ queryKey: queryKeys.modelsRoot() });
    }
  });
  let dropped = false;
  socket.onStatus((status) => {
    // Audit U-2: a 4401 close is a token the engine no longer takes (it restarted).
    if (status === 'unauthorized') markSessionLost();
    if (status === 'reconnecting') dropped = true;
    if (status !== 'open' || !dropped) return;
    // Audit U-9: back after a drop, whatever was read (or failed) while the engine was away is
    // read again. A workflow with edits still queued is left to its GraphSync, which knows them.
    dropped = false;
    void options.queryClient.invalidateQueries({
      predicate: ({ queryKey: [root, id] }) =>
        !(root === 'workflow' && typeof id === 'string' && (peekGraphSync(id)?.pending ?? 0) > 0),
    });
  });
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
    const current = socket;
    const payload = { scope: 'workflow' as const, id: workflowId };
    /*
     * Counted, because more than one screen can watch one workflow at a time — the Canvas and a run
     * page's trace (FR-OBS-001) — and the SDK keeps one subscription per scope: the first to mount
     * subscribes, the last to unmount unsubscribes, and nobody cuts another screen's feed.
     */
    const count = watchers.get(current)?.get(workflowId) ?? 0;
    const byWorkflow = watchers.get(current) ?? new Map<string, number>();
    watchers.set(current, byWorkflow);
    byWorkflow.set(workflowId, count + 1);
    if (count === 0) current.subscribe(payload);
    return () => {
      const left = (byWorkflow.get(workflowId) ?? 1) - 1;
      if (left > 0) {
        byWorkflow.set(workflowId, left);
        return;
      }
      byWorkflow.delete(workflowId);
      current.unsubscribe(payload);
    };
  }, [workflowId]);
}

/** Per socket, so a restarted socket (tests) starts from zero. */
const watchers = new WeakMap<AceSocket, Map<string, number>>();
