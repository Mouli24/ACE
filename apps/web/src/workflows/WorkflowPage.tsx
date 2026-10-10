import { useParams } from 'react-router-dom';

import { usePanelsStore } from '../app/stores/panels';
import { BottomPanel } from '../bottom-panel/BottomPanel';
import { Canvas } from '../canvas/Canvas';
import { NewNodeDialog } from '../canvas/NewNodeDialog';
import { useCanvasApi } from '../canvas/canvas-api';
import { CompactWorkflowLayout } from '../responsive/CompactWorkflowLayout';
import { useIsCompact } from '../responsive/useIsCompact';
import { PreflightIssues } from '../runs/PreflightIssues';
import { CanvasHaltNote } from '../runs/controls/CanvasHaltNote';
import { WorkflowSheet } from './WorkflowSheet';
import { useWorkflowGraph } from './hooks';

/**
 * The Canvas screen (Arch §33.1 step 5) in the POC Theme V2 layout: the Canvas over the bottom
 * panel, with the Configure · Inspector · Runs · Memory sheet floating over the Canvas when opened.
 * Chat (FR-CHAT-004), the workflow subscription, the run events and adopting an active run live in
 * WorkflowLayout, the parent of both modes (D299). Nodes are added from the New node
 * dialog (FR-CAN-002), opened from the top bar. At phone width (≤ 640 px) it is a monitoring screen
 * instead: a read-only Canvas and tabs for runs, inspector, chat and memory (FR-MOB-001/003) — no
 * sheet, Chat column or dialog is mounted there.
 */
export function WorkflowPage() {
  const { workflowId = '' } = useParams();
  const graph = useWorkflowGraph(workflowId);
  const bottomOpen = usePanelsStore((s) => s.bottomOpen);
  const newNodeOpen = usePanelsStore((s) => s.newNodeOpen);
  const closeNewNode = usePanelsStore((s) => s.closeNewNode);
  const canvasApi = useCanvasApi((s) => s.api);
  const compact = useIsCompact();

  if (compact) {
    return (
      <CompactWorkflowLayout
        workflowId={workflowId}
        canvas={
          <>
            <Canvas workflowId={workflowId} readOnly />
            <PreflightIssues workflowId={workflowId} />
          </>
        }
      />
    );
  }

  return (
    <div
      data-testid="workflow-page"
      className="relative grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden"
    >
      {/* `relative` + an absolutely filled Canvas: a percentage height inside a grid row would
          collapse to 0 and leave the Canvas unmeasurable (no fit, no minimap). */}
      <div className="relative min-h-0">
        <Canvas workflowId={workflowId} />
        <PreflightIssues workflowId={workflowId} />
        <CanvasHaltNote workflowId={workflowId} />
      </div>
      <WorkflowSheet workflowId={workflowId} />
      <section
        data-testid="bottom-section"
        className="border-t border-border bg-panel transition-[height] duration-200"
        style={{ height: bottomOpen ? 232 : 40 }}
      >
        <BottomPanel workflowId={workflowId} />
      </section>
      <NewNodeDialog
        workflowId={workflowId}
        workflowName={graph.data?.workflow.name ?? 'Workflow'}
        open={newNodeOpen}
        onClose={closeNewNode}
        // the dialog closes itself after an add
        onAdd={(kind, init) => canvasApi?.addNode(kind, init)}
      />
    </div>
  );
}
