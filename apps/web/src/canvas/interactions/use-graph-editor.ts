import type { WorkflowGraphResponse } from '@ace/contracts';
import { toast } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { queryKeys } from '../../workflows/query-keys';
import type { GraphSync } from '../../workflows/graph-sync';
import { createGraphEditor, type GraphEditor } from './graph-editor';
import { useHistoryStore } from './history';

/** The Canvas's editor for one workflow: every user edit recorded, undo/redo through `sync`. */
export function useGraphEditor(workflowId: string, sync: GraphSync): GraphEditor {
  const queryClient = useQueryClient();
  return useMemo(
    () =>
      createGraphEditor({
        workflowId,
        sync,
        read: () => {
          const graph = queryClient.getQueryData<WorkflowGraphResponse>(
            queryKeys.workflow(workflowId),
          );
          return graph && { nodes: graph.nodes, edges: graph.edges };
        },
        notify: (message, description) =>
          toast.warning(message, description === undefined ? undefined : { description }),
      }),
    [workflowId, sync, queryClient],
  );
}

/** Whether there is anything to undo or redo in this workflow (for the buttons). */
export function useHistoryDepth(workflowId: string): { canUndo: boolean; canRedo: boolean } {
  const canUndo = useHistoryStore((s) => (s.byWorkflow[workflowId]?.past.length ?? 0) > 0);
  const canRedo = useHistoryStore((s) => (s.byWorkflow[workflowId]?.future.length ?? 0) > 0);
  return { canUndo, canRedo };
}
