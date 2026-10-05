import type { Edge, LoopConfig, Node, WorkflowGraphResponse } from '@ace/contracts';
import { Button } from '@ace/ui';
import { Copy, Repeat, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useParams } from 'react-router-dom';

import { useSelectionStore } from '../app/stores/selection';
import { LoopConfigFields } from '../edges/loop/LoopConfigFields';
import { useRunStore } from '../runs/run-store';
import { useProviders } from '../providers/hooks';
import { useCanvasApi } from '../canvas/canvas-api';
import { KIND_ICON } from '../nodes/NodeCard';
import { NODE_KIND_LABEL, type CanvasNodeKind } from '../nodes/factory';
import { useGraphSync, useWorkflowGraph } from '../workflows/hooks';
import { queryKeys } from '../workflows/query-keys';
import { TextField } from './fields';
import { KindPanel } from './panels';

/**
 * Right pane (FR-NODE-002): the selected node's configuration, every edit an `update_node` op.
 *
 * From round 3 a selected loop edge has settings of its own (FR-CON-007), so the pane shows whichever
 * one thing is selected — a node, or the loop edge.
 */
export function ConfigPanel({ workflowId }: { workflowId: string }) {
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const selectedCount = useSelectionStore((s) => s.nodeIds.length);
  const selectedEdgeIds = useSelectionStore((s) => s.edgeIds);
  const graph = useWorkflowGraph(workflowId);
  const node = graph.data?.nodes.find((n) => n.id === focusedNodeId);
  const edge =
    selectedEdgeIds.length === 1
      ? graph.data?.edges.find((each) => each.id === selectedEdgeIds[0])
      : undefined;

  return (
    <aside
      aria-label="Node configuration"
      className="flex h-full flex-col overflow-y-auto"
      data-testid="config-panel"
    >
      {node ? (
        <NodeEditor key={node.id} node={node} workflowId={workflowId} />
      ) : edge?.kind === 'loop' ? (
        <LoopEdgeEditor key={edge.id} edge={edge} workflowId={workflowId} />
      ) : (
        <div className="flex flex-col gap-2 p-4" data-testid="config-workflow">
          <h2 className="font-human text-[21px] font-semibold leading-tight">
            {graph.data?.workflow.name ?? 'Workflow'}
          </h2>
          <p className="font-human text-sm text-fg-muted">
            {selectedCount > 1
              ? `${selectedCount} nodes selected. Select one node to configure it.`
              : 'Select a node to configure it. These settings apply to the whole workflow.'}
          </p>
        </div>
      )}
    </aside>
  );
}

/**
 * The loop edge's settings (FR-CON-007, TC-CON-007). A committed change is one `update_edge` op, and
 * only a draft the contract accepts commits — 0 and 51 iterations never leave the editor.
 */
function LoopEdgeEditor({ edge, workflowId }: { edge: Edge; workflowId: string }) {
  const sync = useGraphSync(workflowId);
  const graph = useWorkflowGraph(workflowId);
  const clearSelection = useSelectionStore((s) => s.clear);
  const runActive = useRunStore((store) => store.active && store.workflowId === workflowId);
  const nameOf = (nodeId: string) =>
    graph.data?.nodes.find((node) => node.id === nodeId)?.name ?? 'unknown node';

  const commit = (loop: LoopConfig) =>
    sync.enqueue([{ op: 'update_edge', edgeId: edge.id, patch: { loop } }]);

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="loop-edge-editor">
      <header className="flex items-center gap-2">
        <Repeat className="h-4 w-4 text-fg-muted" aria-hidden />
        <h2 className="font-human text-sm font-semibold">Loop edge</h2>
        <span className="ml-auto font-machine text-[10px] text-fg-muted" title={edge.id}>
          {edge.id.slice(-6)}
        </span>
      </header>

      <p className="font-human text-xs text-fg-muted">
        {nameOf(edge.from.nodeId)} sends its output back to {nameOf(edge.to.nodeId)}.
      </p>

      {runActive && (
        <p
          role="status"
          data-testid="applies-next-run"
          className="rounded-field border border-border bg-card px-3 py-2 text-xs text-fg-muted"
        >
          A run is in flight. Edits apply to the next run — this one keeps the values it started
          with.
        </p>
      )}

      {edge.loop && <LoopConfigFields value={edge.loop} onCommit={commit} />}

      <footer className="mt-2 flex gap-2 border-t border-border pt-4">
        <Button
          variant="destructive"
          size="sm"
          aria-label="Delete loop edge"
          onClick={() => {
            sync.enqueue([{ op: 'delete_edge', edgeId: edge.id }]);
            clearSelection();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </Button>
      </footer>
    </div>
  );
}

function NodeEditor({ node, workflowId }: { node: Node; workflowId: string }) {
  const sync = useGraphSync(workflowId);
  // The project the Canvas was opened under; the guardrail policy picker lists its policies.
  const { projectId } = useParams<{ projectId: string }>();
  /**
   * FR-NODE-009: a run executes the snapshot it froze at start (BR-04), so an edit made while a run
   * is in flight cannot affect it. The panel says so rather than pretending the edit took hold.
   */
  const runActive = useRunStore((store) => store.active && store.workflowId === workflowId);
  const clearSelection = useSelectionStore((s) => s.clear);
  const canvas = useCanvasApi((s) => s.api);
  const Icon = KIND_ICON[node.kind as CanvasNodeKind];
  const providers = useProviders();
  const providerId = (node.config as { providerId?: string }).providerId;
  const providerType = providers.data?.find((p) => p.id === providerId)?.type;
  const tone =
    providerType === undefined ? 'var(--color-fg-soft)' : `var(--color-provider-${providerType})`;

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
      <header className="flex items-center gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border"
          style={{
            color: tone,
            borderColor: `color-mix(in oklab, ${tone} 40%, var(--color-border))`,
            background: `color-mix(in oklab, ${tone} 14%, transparent)`,
          }}
        >
          {Icon && <Icon className="h-4 w-4" aria-hidden />}
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 className="font-machine text-[10px] uppercase tracking-[0.18em] text-fg-faint">
            {NODE_KIND_LABEL[node.kind as CanvasNodeKind] ?? node.kind} node
          </h2>
          <span className="truncate font-machine text-[11px] text-fg-soft" title={node.id}>
            {node.id.slice(-6)}
          </span>
        </div>
      </header>

      {runActive && (
        <p
          role="status"
          data-testid="applies-next-run"
          className="rounded-field border border-border bg-card px-3 py-2 text-xs text-fg-muted"
        >
          A run is in flight. Edits apply to the next run — this one keeps the values it started
          with.
        </p>
      )}

      <TextField
        label="Name"
        value={node.name}
        maxLength={80}
        onCommit={(name) =>
          name.trim() &&
          sync.enqueue([{ op: 'update_node', nodeId: node.id, patch: { name: name.trim() } }])
        }
      />

      <KindPanel
        node={node}
        patch={patchConfig}
        workflowId={workflowId}
        {...(projectId === undefined ? {} : { projectId })}
      />

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
