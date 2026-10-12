import { useParams } from 'react-router-dom';

import { usePanelsStore } from '../app/stores/panels';
import { BottomPanel } from '../bottom-panel/BottomPanel';
import { Canvas } from '../canvas/Canvas';
import { NodeSettingsModal } from '../config-panel/NodeSettingsModal';
import { CompactWorkflowLayout } from '../responsive/CompactWorkflowLayout';
import { useIsCompact } from '../responsive/useIsCompact';
import { PreflightIssues } from '../runs/PreflightIssues';
import { CanvasHaltNote } from '../runs/controls/CanvasHaltNote';
import { WorkflowSheet } from './WorkflowSheet';

/**
 * The Ideate screen (Arch §33.1 step 5, D332): the theme's canvas — breadcrumb, Add node, toolbar
 * and minimap are the Canvas's own — with the Inspector · Runs · Memory sheet floating over it when
 * opened, the node settings modal (D333), and the bottom panel (Validation, Events, Errors,
 * Timeline) only while the workspace menu's "Problems & events" has it open. Chat (FR-CHAT-004),
 * the workflow subscription, the run events and adopting an active run live in WorkflowLayout,
 * the parent of every mode (D299). At phone width (≤ 640 px) it is a monitoring screen instead: a
 * read-only Canvas and tabs for runs, inspector, chat and memory (FR-MOB-001/003) — no sheet,
 * Chat column, modal or bottom panel is mounted there.
 */
export function WorkflowPage() {
  const { workflowId = '' } = useParams();
  const bottomOpen = usePanelsStore((s) => s.bottomOpen);
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
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--canvas)]"
    >
      {/* `relative` + an absolutely filled Canvas: a percentage height inside a flex item would
          collapse to 0 and leave the Canvas unmeasurable (no fit, no minimap). */}
      <div className="relative min-h-0 flex-1">
        <Canvas workflowId={workflowId} />
        <PreflightIssues workflowId={workflowId} />
        <CanvasHaltNote workflowId={workflowId} />
      </div>
      <WorkflowSheet workflowId={workflowId} />
      {bottomOpen && (
        <section
          data-testid="bottom-section"
          className="shrink-0 border-t border-[var(--line)] bg-[var(--panel)]"
          style={{ height: 232 }}
        >
          <BottomPanel workflowId={workflowId} />
        </section>
      )}
      <NodeSettingsModal workflowId={workflowId} />
    </div>
  );
}
