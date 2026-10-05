import { BarChart3, CircleHelp, PanelRight, Plus, Settings, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { cn } from '@ace/ui';
import { useProject } from '../../projects/hooks';
import { ProviderStatusBar } from '../../providers/ProviderStatusBar';
import { CompactMenu } from '../../responsive/CompactMenu';
import { useIsCompact } from '../../responsive/useIsCompact';
import { RunBar } from '../../runs/RunBar';
import { ApprovalsBadge } from '../../runs/approvals/ApprovalsBadge';
import { useRunStore } from '../../runs/run-store';
import { DayTotalsChip } from '../../usage/DayTotalsChip';
import { SHEET_ID } from '../../workflows/WorkflowSheet';
import { WorkflowTabs } from '../../workflows/WorkflowTabs';
import { usePanelsStore } from '../stores/panels';

const ICON_BUTTON =
  'grid h-8 w-8 place-items-center rounded-chip text-fg-muted hover:bg-border hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * Top bar: project name, workflow tabs, live provider status (FR-PRV-004), and — on a Canvas — the
 * run controls with the run's status and totals (FR-EXE-001, FR-OBS-002, FR-CTL-001..004), plus a
 * count of the approvals waiting on a person (FR-GRD-013).
 *
 * At phone width (FR-MOB-001) the links and status chips fold into one menu, the approvals badge
 * stays in sight (FR-MOB-002), and the run bar gets a row of its own.
 */
export function TopBar() {
  const { projectId, workflowId } = useParams();
  const project = useProject(projectId);
  const runId = useRunStore((store) => store.runId);
  const compact = useIsCompact();
  const sheetOpen = usePanelsStore((store) => store.sheetOpen);
  const openSheet = usePanelsStore((store) => store.openSheet);
  const closeSheet = usePanelsStore((store) => store.closeSheet);
  const openNewNode = usePanelsStore((store) => store.openNewNode);

  if (compact) {
    return (
      <header
        className="flex shrink-0 flex-col border-b border-border bg-panel"
        data-testid="topbar-compact"
      >
        <div className="flex h-12 min-w-0 items-center gap-2 px-3">
          <Link
            to="/projects"
            className="shrink-0 font-human text-base font-semibold tracking-tight"
          >
            ACE
          </Link>
          {project.data && (
            <>
              <span className="text-fg-muted">/</span>
              <Link
                to={`/projects/${project.data.id}`}
                className="min-w-0 truncate font-human text-sm"
                data-testid="project-name"
              >
                {project.data.name}
              </Link>
            </>
          )}
          <div className="flex-1" />
          <ApprovalsBadge runId={runId} />
          <CompactMenu
            {...(projectId === undefined ? {} : { projectId })}
            status={
              <>
                <ProviderStatusBar />
                <DayTotalsChip />
              </>
            }
          />
        </div>
        {workflowId && (
          <div className="min-w-0 overflow-x-auto px-3 pb-2">
            <RunBar workflowId={workflowId} />
          </div>
        )}
      </header>
    );
  }

  return (
    <header className="flex h-[52px] min-w-0 shrink-0 items-center gap-3.5 border-b border-border bg-panel pl-[18px] pr-3.5">
      <div className="flex shrink-0 items-baseline gap-2">
        <Link
          to="/projects"
          className="font-human text-xl font-semibold tracking-[-0.01em] text-fg"
        >
          ACE
        </Link>
        {project.data && (
          <>
            <span className="text-fg-faint">/</span>
            <Link
              to={`/projects/${project.data.id}`}
              className="max-w-[14rem] truncate text-[15px] text-fg-soft hover:text-fg"
              data-testid="project-name"
            >
              {project.data.name}
            </Link>
          </>
        )}
      </div>
      {/* A floor for the tabs: without it every other item keeps its width and the tabs (with
          "Add workflow" and each tab's actions menu) are squeezed to nothing under them. */}
      {projectId && (
        <div className="min-w-48 shrink">
          <WorkflowTabs projectId={projectId} activeWorkflowId={workflowId} />
        </div>
      )}
      <div className="flex-1" />
      <ProviderStatusBar />
      {/* On a Canvas the run bar already shows this run's totals; the day's wait for a wide screen. */}
      <div className={workflowId ? 'hidden shrink-0 2xl:flex' : 'flex shrink-0'}>
        <DayTotalsChip />
      </div>
      <div aria-hidden className="h-[22px] w-px shrink-0 bg-border" />
      {workflowId && <RunBar workflowId={workflowId} haltInline={false} />}
      <div className="flex shrink-0 items-center gap-0.5">
        <ApprovalsBadge runId={runId} />
        {workflowId && (
          <button
            type="button"
            data-testid="sheet-toggle"
            aria-label="Workflow panel"
            aria-pressed={sheetOpen}
            aria-controls={SHEET_ID}
            title="Workflow panel"
            className={cn(ICON_BUTTON, sheetOpen && 'bg-border text-fg')}
            onClick={() => (sheetOpen ? closeSheet() : openSheet())}
          >
            <PanelRight className="h-4 w-4" aria-hidden />
          </button>
        )}
        <Link to="/usage" aria-label="Usage" className={ICON_BUTTON}>
          <BarChart3 className="h-4 w-4" aria-hidden />
        </Link>
        <Link to="/guardrails" aria-label="Guardrail policies" className={ICON_BUTTON}>
          <ShieldCheck className="h-4 w-4" aria-hidden />
        </Link>
        <Link to="/settings" aria-label="Settings" className={ICON_BUTTON}>
          <Settings className="h-4 w-4" aria-hidden />
        </Link>
        <Link to="/help/getting-started" aria-label="Help" className={ICON_BUTTON}>
          <CircleHelp className="h-4 w-4" aria-hidden />
        </Link>
      </div>
      {workflowId && (
        <button
          type="button"
          data-testid="new-node-button"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-chip border border-border-strong bg-card pl-[11px] pr-3.5 font-machine text-[10.5px] uppercase tracking-[0.1em] text-fg hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={openNewNode}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> New node
        </button>
      )}
    </header>
  );
}
