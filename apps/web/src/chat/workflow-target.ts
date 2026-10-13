import type { Node, WorkflowGraphResponse } from '@ace/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { usePanelsStore } from '../app/stores/panels';
import { useWorkflowGraph } from '../workflows/hooks';
import { queryKeys } from '../workflows/query-keys';

/** The nodes the chat talks to (D285): Agent and Model nodes. */
export const isChatNode = (node: Node): boolean => node.kind === 'agent' || node.kind === 'model';

/**
 * Whether `nodeId` is a chat node of the workflow, as the query cache holds its graph (fix F-I2).
 * False with no workflow, or while its graph is not loaded: nothing proves the node belongs.
 */
export function isChatNodeOf(
  queryClient: QueryClient,
  workflowId: string | undefined,
  nodeId: string,
): boolean {
  if (workflowId === undefined) return false;
  const graph = queryClient.getQueryData<WorkflowGraphResponse>(queryKeys.workflow(workflowId));
  return graph?.nodes.some((node) => node.id === nodeId && isChatNode(node)) === true;
}

/**
 * The chat's target is a node of the workflow on screen, or none (fix F-I2): once the graph is
 * loaded, a target that left it, cannot chat, or belongs to another workflow or project goes back
 * to the intro state. The workflow layout runs this whether or not the chat column is open, so a
 * target from elsewhere never outlives a switch while the column is closed.
 */
export function useDropStaleChatTarget(workflowId: string): void {
  const nodes = useWorkflowGraph(workflowId).data?.nodes;
  const chatNodeId = usePanelsStore((s) => s.chatNodeId);
  useEffect(() => {
    if (nodes === undefined || chatNodeId === undefined) return;
    if (!nodes.some((node) => node.id === chatNodeId && isChatNode(node))) {
      usePanelsStore.getState().chatWith(undefined);
    }
  }, [nodes, chatNodeId]);
}
