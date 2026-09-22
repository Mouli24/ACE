import { toast } from '@ace/ui';
import type { QueryClient } from '@tanstack/react-query';

import { api } from '../app/api';
import { GraphSync } from './graph-sync';

const registry = new Map<string, GraphSync>();

/** One GraphSync per open workflow, shared by the Canvas, the config panel and the socket. */
export function getGraphSync(workflowId: string, queryClient: QueryClient): GraphSync {
  let sync = registry.get(workflowId);
  if (!sync) {
    sync = new GraphSync({
      workflowId,
      client: api(),
      queryClient,
      onConflictUnresolved: (error) =>
        toast.error('Your last edit was dropped: the workflow changed elsewhere.', {
          description: error.message,
        }),
      onRejected: (error) =>
        toast.error('The engine refused that edit.', { description: error.message }),
    });
    registry.set(workflowId, sync);
  }
  return sync;
}

export function peekGraphSync(workflowId: string): GraphSync | undefined {
  return registry.get(workflowId);
}

export function dropGraphSync(workflowId: string): void {
  registry.get(workflowId)?.dispose();
  registry.delete(workflowId);
}

/** Tests only: forget every controller. */
export function resetGraphSyncRegistry(): void {
  for (const sync of registry.values()) sync.dispose();
  registry.clear();
}
