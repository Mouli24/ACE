import type { Node, WorkflowGraphResponse } from '@ace/contracts';
import { Button } from '@ace/ui';
import { Copy, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useSelectionStore } from '../app/stores/selection';
import { useCanvasApi } from '../canvas/canvas-api';
import { KIND_ICON } from '../nodes/NodeCard';
import { NODE_KIND_LABEL, type Round1NodeKind } from '../nodes/factory';
import { useGraphSync, useWorkflowGraph } from '../workflows/hooks';
import { queryKeys } from '../workflows/query-keys';
import { TextField } from './fields';
import { KindPanel } from './panels';

/** Right pane (FR-NODE-002): the selected node's configuration, every edit an `update_node` op. */
export function ConfigPanel({ workflowId }: { workflowId: string }) {
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const selectedCount = useSelectionStore((s) => s.nodeIds.length);
  const graph = useWorkflowGraph(workflowId);
  const node = graph.data?.nodes.find((n) => n.id === focusedNodeId);

  return (
    <aside
      aria-label="Node configuration"
      className="flex h-full flex-col overflow-y-auto"
      data-testid="config-panel"
    >
      {node ? (
        <NodeEditor key={node.id} node={node} workflowId={workflowId} />
      ) : (
        <p className="p-4 text-sm text-fg-muted">
          {selectedCount > 1
            ? `${selectedCount} nodes selected. Select one node to configure it.`
            : 'Select a node to configure it.'}
        </p>
      )}
    </aside>
  );
}

function NodeEditor({ node, workflowId }: { node: Node; workflowId: string }) {
  const sync = useGraphSync(workflowId);
  const clearSelection = useSelectionStore((s) => s.clear);
  const canvas = useCanvasApi((s) => s.api);
  const Icon = KIND_ICON[node.kind as Round1NodeKind];

  const queryClient = useQueryClient();

  /**
   * Every patch carries the whole config, read from the cache at call time so two edits in one
   * tick compose. A partial patch would be contract-valid too, but the engine currently re-applies
   * Zod defaults to the keys a partial patch leaves out (defect D-001), which would silently reset
   * the other fields; the whole config is immune either way.
   */
  const patchConfig = useCallback(
    (patch: Partial<Node['config']>) => {
      const latest = queryClient
        .getQueryData<WorkflowGraphResponse>(queryKeys.workflow(workflowId))
        ?.nodes.find((n) => n.id === node.id);
      const config = { ...(latest ?? node).config, ...patch } as Node['config'];
      sync.enqueue([{ op: 'update_node', nodeId: node.id, patch: { config } }]);
    },
    [sync, node, workflowId, queryClient],
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-fg-muted" aria-hidden />}
        <h2 className="font-human text-sm font-semibold">
          {NODE_KIND_LABEL[node.kind as Round1NodeKind] ?? node.kind} node
        </h2>
        <span className="ml-auto font-machine text-[10px] text-fg-muted" title={node.id}>
          {node.id.slice(-6)}
        </span>
      </header>

      <TextField
        label="Name"
        value={node.name}
        maxLength={80}
        onCommit={(name) =>
          name.trim() &&
          sync.enqueue([{ op: 'update_node', nodeId: node.id, patch: { name: name.trim() } }])
        }
      />

      <KindPanel node={node} patch={patchConfig} />

      <footer className="mt-2 flex gap-2 border-t border-border pt-4">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => canvas?.duplicateSelection()}
          aria-label="Duplicate node"
        >
          <Copy className="h-3.5 w-3.5" /> Duplicate
        </Button>
        <Button
          variant="destructive"
          size="sm"
          aria-label="Delete node"
          onClick={() => {
            sync.enqueue([{ op: 'delete_node', nodeId: node.id }]);
            clearSelection();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </Button>
      </footer>
    </div>
  );
}
