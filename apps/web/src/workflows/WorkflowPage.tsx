import { Link, useParams } from 'react-router-dom';

import { useWorkflowSubscription } from '../app/socket';
import { usePanelsStore } from '../app/stores/panels';
import { BottomPanel } from '../bottom-panel/BottomPanel';
import { Canvas } from '../canvas/Canvas';
import { NewNodeDialog } from '../canvas/NewNodeDialog';
import { useCanvasApi } from '../canvas/canvas-api';
import { ChatAside } from '../chat';
import { CompactWorkflowLayout } from '../responsive/CompactWorkflowLayout';
import { useIsCompact } from '../responsive/useIsCompact';
import { PreflightIssues } from '../runs/PreflightIssues';
import { CanvasHaltNote } from '../runs/controls/CanvasHaltNote';
import { useAdoptActiveRun, useRunEvents } from '../runs/hooks';
import { WorkflowSheet } from './WorkflowSheet';
import { useWorkflowGraph } from './hooks';

/**
 * The Canvas screen (Arch §33.1 step 5) in the POC Theme V2 layout: the Canvas over the bottom
 * panel, with the Configure · Inspector · Runs · Memory sheet floating over the Canvas when opened,
 * and Chat as a permanent column on the right (FR-CHAT-004). Nodes are added from the New node
 * dialog (FR-CAN-002), opened from the top bar. At phone width (≤ 640 px) it is a monitoring screen
 * instead: a read-only Canvas and tabs for runs, inspector, chat and memory (FR-MOB-001/003) — no
 * sheet, Chat column or dialog is mounted there.
 */
export function WorkflowPage() {
  const { projectId = '', workflowId = '' } = useParams();
  const graph = useWorkflowGraph(workflowId);
  useWorkflowSubscription(workflowId);
  // Every §2.4 run frame folds into the overlay store while this screen is mounted (FR-EXE-008/009).
  useRunEvents(workflowId);
  // A reload mid-run rebuilds the overlay from the engine's records (FR-EXE-014, D-028).
  useAdoptActiveRun(workflowId);
  const bottomOpen = usePanelsStore((s) => s.bottomOpen);
  const newNodeOpen = usePanelsStore((s) => s.newNodeOpen);
  const closeNewNode = usePanelsStore((s) => s.closeNewNode);
  const canvasApi = useCanvasApi((s) => s.api);
  const compact = useIsCompact();

  if (graph.isError) {
    return (
      <p role="alert" className="p-6 text-danger">
        Workflow not found.{' '}
        <Link to={`/projects/${projectId}`} className="underline">
          Back to the project
        </Link>
      </p>
    );
  }

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
    <div data-testid="workflow-page" className="grid h-full grid-cols-[minmax(0,1fr)_340px]">
      <div className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
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
      </div>
      <aside
        data-testid="chat-column"
        className="flex min-h-0 min-w-0 flex-col border-l border-border bg-panel"
      >
        <ChatAside workflowId={workflowId} />
      </aside>
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
