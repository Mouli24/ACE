import {
  isAddressableNode,
  type Edge,
  type LoopConfig,
  type Node,
  type WorkflowGraphResponse,
} from '@ace/contracts';
import { Dialog, DialogContent, DialogTitle, chipFill } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useResolvedTheme } from '../app/theme';
import { useCanvasApi } from '../canvas/canvas-api';
import { LoopConfigFields } from '../edges/loop/LoopConfigFields';
import { NODE_KIND_LABEL, type CanvasNodeKind } from '../nodes/factory';
import { useProviders } from '../providers/hooks';
import { useNodeOverlay, useRunStore } from '../runs/run-store';
import { agentsOf } from '../theme/agents';
import { th, themeProviderOf, type ProviderTheme } from '../theme/constants';
import { nodeStatusLook } from '../theme/format';
import { ProviderOrb } from '../theme/primitives';
import { useGraphSync, useWorkflowGraph } from '../workflows/hooks';
import { queryKeys } from '../workflows/query-keys';
import { HELP_CLASS } from './fields';
import { KindPanel } from './panels';
import { PendingEditsProvider, usePendingEditsRegistry } from './pending-edits';
import { ReadsSection } from './ReadsSection';

/*
 * The node settings modal (D333; Ace Canvas.dc.html 145–353), opened by `openSettings` when a node
 * — or a loop edge — is clicked on the canvas. A 640×760 dialog: the provider orb, name and chips
 * over a scrolling body of the target's settings, and "Changes save automatically" with Done.
 *
 * Everything saves as it is edited: text and numbers debounced, selects and toggles at once. Every
 * way out — Done, Close, Esc, a click outside — first commits what is still waiting.
 */

/** The theme's mono header chip (8.5px, 0.08em, 500). */
const CHIP_CLASS =
  'shrink-0 rounded-[4px] px-1.5 py-0.5 font-machine text-[8.5px] font-medium tracking-[0.08em]';

/** The theme's focus ring for its own buttons: the accent, 2px. */
const FOCUS_CLASS = 'outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/** "Remove node from canvas": the theme's destructive text button (11.5px / 600, #c94c27). */
const REMOVE_CLASS = `h-7 cursor-pointer self-start border-none bg-transparent px-0.5 text-[11.5px] font-semibold text-[#c94c27] ${FOCUS_CLASS}`;

interface Chip {
  label: string;
  background: string;
  color: string;
}

export function NodeSettingsModal({ workflowId }: { workflowId: string }) {
  const target = usePanelsStore((s) => s.settings);
  const closeSettings = usePanelsStore((s) => s.closeSettings);
  const graph = useWorkflowGraph(workflowId);
  const pending = usePendingEditsRegistry();

  const node =
    target?.kind === 'node' ? graph.data?.nodes.find((each) => each.id === target.id) : undefined;
  const edge =
    target?.kind === 'edge'
      ? graph.data?.edges.find((each) => each.id === target.id && each.kind === 'loop')
      : undefined;

  // a target that is gone (deleted elsewhere, undone) closes the modal rather than pointing at nothing
  const gone = target !== undefined && graph.isSuccess && node === undefined && edge === undefined;
  useEffect(() => {
    if (gone) closeSettings();
  }, [gone, closeSettings]);

  const close = useCallback(() => {
    pending.flushAll();
    closeSettings();
  }, [pending, closeSettings]);

  if (node === undefined && edge === undefined) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        hideClose
        data-cfg="1"
        aria-describedby={undefined}
        // the canvas's shortcuts (F, Ctrl+Z, Ctrl+D…) listen on window; none of them may act behind the modal
        onKeyDown={(event) => event.stopPropagation()}
        className="flex h-[760px] max-h-[calc(100vh-48px)] w-[640px] max-w-[calc(100vw-48px)] flex-col gap-0 overflow-hidden p-0"
      >
        <PendingEditsProvider value={pending}>
          <section
            aria-label="Node configuration"
            data-testid="config-panel"
            className="flex min-h-0 flex-1 flex-col"
          >
            {node !== undefined ? (
              <NodeSettings
                key={node.id}
                node={node}
                nodes={graph.data?.nodes ?? []}
                edges={graph.data?.edges ?? []}
                workflowId={workflowId}
                onClose={close}
                flushPending={pending.flushAll}
              />
            ) : edge !== undefined ? (
              <LoopEdgeSettings
                key={edge.id}
                edge={edge}
                workflowId={workflowId}
                onClose={close}
                flushPending={pending.flushAll}
              />
            ) : null}
          </section>
        </PendingEditsProvider>
      </DialogContent>
    </Dialog>
  );
}

/** The modal's header (theme 149–162): orb with its stage badge, title, sub row, Close pill. */
function SettingsHeader({
  look,
  stage,
  title,
  modelLabel,
  chips,
  onClose,
}: {
  look: ProviderTheme;
  /** The agent's position among the workflow's agents (1-based), for the orb's badge. */
  stage?: number;
  title: string;
  modelLabel?: string;
  chips: readonly Chip[];
  onClose: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-[var(--line)] px-5 pb-4 pt-[18px]">
      <ProviderOrb look={look} size={40} logo={20} className="relative">
        {stage !== undefined && (
          <span
            data-testid="settings-stage"
            className="absolute -bottom-[3px] -left-[3px] flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-[#fff] shadow-[0_0_0_2px_var(--surface)]"
            style={{ background: look.badge }}
          >
            {stage}
          </span>
        )}
      </ProviderOrb>
      <div className="min-w-0 flex-1">
        <DialogTitle className="truncate">{title}</DialogTitle>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          {modelLabel !== undefined && (
            <span
              data-testid="settings-model-label"
              className="min-w-0 truncate whitespace-nowrap text-[11.5px] text-[var(--muted)]"
            >
              {modelLabel}
            </span>
          )}
          {chips.map((chip) => (
            <span
              key={chip.label}
              className={CHIP_CLASS}
              style={{ background: chip.background, color: chip.color }}
            >
              {chip.label}
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className={`h-[30px] shrink-0 cursor-pointer rounded-full border border-[var(--line)] bg-[var(--soft)] px-[14px] text-[12px] font-semibold text-[var(--ink)] hover:bg-[var(--hover)] ${FOCUS_CLASS}`}
      >
        Close
      </button>
    </header>
  );
}

/** The footer (theme 347–350): the autosave note and the Done pill. */
function SettingsFooter({ onClose }: { onClose: () => void }) {
  return (
    <footer className="flex items-center justify-between gap-2.5 border-t border-[var(--line)] px-5 py-3">
      <span className="text-[11.5px] text-[var(--muted)]">Changes save automatically</span>
      <button
        type="button"
        onClick={onClose}
        className={`h-[34px] cursor-pointer rounded-full border-none bg-[var(--ink)] px-[22px] text-[13px] font-semibold text-[var(--canvas)] ${FOCUS_CLASS}`}
      >
        Done
      </button>
    </footer>
  );
}

/**
 * FR-NODE-009: a run executes the snapshot it froze at start (BR-04), so an edit made while a run
 * is in flight cannot affect it. The modal says so rather than pretending the edit took hold.
 */
function AppliesNextRun({ workflowId }: { workflowId: string }) {
  const runActive = useRunStore((store) => store.active && store.workflowId === workflowId);
  if (!runActive) return null;
  return (
    <p role="status" data-testid="applies-next-run" className={HELP_CLASS}>
      A run is in flight. Edits apply to the next run — this one keeps the values it started with.
    </p>
  );
}

/** The body: scrolls, padding 20, 20px between blocks. */
const BODY_CLASS = 'flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5';

function NodeSettings({
  node,
  nodes,
  edges,
  workflowId,
  onClose,
  flushPending,
}: {
  node: Node;
  nodes: readonly Node[];
  edges: readonly Edge[];
  workflowId: string;
  onClose: () => void;
  flushPending: () => void;
}) {
  const sync = useGraphSync(workflowId);
  const queryClient = useQueryClient();
  const closeSettings = usePanelsStore((s) => s.closeSettings);
  const readOnly = useCanvasApi((s) => s.api?.readOnly === true);
  const dark = useResolvedTheme() === 'dark';
  const providers = useProviders();
  const overlay = useNodeOverlay(node.id);

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

  const rename = useCallback(
    (name: string) => sync.enqueue([{ op: 'update_node', nodeId: node.id, patch: { name } }]),
    [sync, node.id],
  );

  /**
   * D333: the canvas removes the node as one undoable step and reconnects every incoming edge to
   * every outgoing one the types allow. Pending edits land first, so an undo brings back the node
   * as it was left.
   */
  const remove = () => {
    flushPending();
    const canvas = useCanvasApi.getState().api;
    if (canvas?.removeNodeReconnecting) canvas.removeNodeReconnecting(node.id);
    else if (canvas) canvas.deleteNodes([node.id]);
    else sync.enqueue([{ op: 'delete_node', nodeId: node.id }]);
    closeSettings();
  };

  const addressable = isAddressableNode(node);
  const provider = addressable
    ? providers.data?.find((each) => each.id === node.config.providerId)
    : undefined;
  const look = th(addressable ? themeProviderOf(provider?.type) : { provider: 'Custom' }, dark);
  const stage = addressable
    ? agentsOf(nodes).findIndex((agent) => agent.nodeId === node.id) + 1
    : 0;
  const modelLabel = addressable
    ? provider === undefined
      ? 'no provider'
      : `${provider.name} · ${node.config.modelId || 'no model set'}`
    : undefined;
  const status = nodeStatusLook(overlay.state);
  const kind = NODE_KIND_LABEL[node.kind as CanvasNodeKind] ?? node.kind;

  return (
    <>
      <SettingsHeader
        look={look}
        {...(stage > 0 ? { stage } : {})}
        title={node.name}
        {...(modelLabel === undefined ? {} : { modelLabel })}
        chips={[
          { label: kind.toUpperCase(), background: look.chipBg, color: look.chipInk },
          {
            label: status.label.toUpperCase(),
            background: chipFill(status.color),
            color: status.color,
          },
        ]}
        onClose={onClose}
      />
      <div className={BODY_CLASS}>
        <AppliesNextRun workflowId={workflowId} />
        <KindPanel node={node} patch={patchConfig} rename={rename} workflowId={workflowId} />
        {/* PG-4.1: what this node will be handed, before a run. */}
        <ReadsSection node={node} nodes={nodes} edges={edges} />
        {!readOnly && (
          <button type="button" className={REMOVE_CLASS} onClick={remove}>
            Remove node from canvas
          </button>
        )}
      </div>
      <SettingsFooter onClose={onClose} />
    </>
  );
}

/**
 * The loop edge's settings (FR-CON-007, TC-CON-007). A committed change is one `update_edge` op, and
 * only a draft the contract accepts commits — 0 and 51 iterations never leave the editor.
 */
function LoopEdgeSettings({
  edge,
  workflowId,
  onClose,
  flushPending,
}: {
  edge: Edge;
  workflowId: string;
  onClose: () => void;
  flushPending: () => void;
}) {
  const sync = useGraphSync(workflowId);
  const graph = useWorkflowGraph(workflowId);
  const closeSettings = usePanelsStore((s) => s.closeSettings);
  const readOnly = useCanvasApi((s) => s.api?.readOnly === true);
  const dark = useResolvedTheme() === 'dark';
  const look = th({ provider: 'Custom' }, dark);
  const nameOf = (nodeId: string) =>
    graph.data?.nodes.find((node) => node.id === nodeId)?.name ?? 'unknown node';

  const commit = (loop: LoopConfig) =>
    sync.enqueue([{ op: 'update_edge', edgeId: edge.id, patch: { loop } }]);

  const remove = () => {
    flushPending();
    sync.enqueue([{ op: 'delete_edge', edgeId: edge.id }]);
    useSelectionStore.getState().clear();
    closeSettings();
  };

  return (
    <>
      <SettingsHeader
        look={look}
        title="Loop edge"
        chips={[{ label: 'LOOP', background: look.chipBg, color: look.chipInk }]}
        onClose={onClose}
      />
      <div className={BODY_CLASS} data-testid="loop-edge-editor">
        <AppliesNextRun workflowId={workflowId} />
        <p className={HELP_CLASS}>
          {nameOf(edge.from.nodeId)} sends its output back to {nameOf(edge.to.nodeId)}.
        </p>
        {edge.loop && <LoopConfigFields value={edge.loop} onCommit={commit} />}
        {!readOnly && (
          <button type="button" className={REMOVE_CLASS} onClick={remove}>
            Remove loop edge
          </button>
        )}
      </div>
      <SettingsFooter onClose={onClose} />
    </>
  );
}
