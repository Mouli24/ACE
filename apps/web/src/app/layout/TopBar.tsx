import { Button } from '@ace/ui';
import { BarChart3, CircleHelp, Settings, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { useProject } from '../../projects/hooks';
import { ProviderStatusBar } from '../../providers/ProviderStatusBar';
import { CompactMenu } from '../../responsive/CompactMenu';
import { useIsCompact } from '../../responsive/useIsCompact';
import { RunBar } from '../../runs/RunBar';
import { ApprovalsBadge } from '../../runs/approvals/ApprovalsBadge';
import { useRunStore } from '../../runs/run-store';
import { DayTotalsChip } from '../../usage/DayTotalsChip';
import { WorkflowTabs } from '../../workflows/WorkflowTabs';

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

  if (compact) {
    return (
      <header
        className="flex shrink-0 flex-col border-b border-border bg-panel"
        data-testid="topbar-compact"
      >
        <div className="flex h-12 min-w-0 items-center gap-2 px-3">
          <Link to="/projects" className="shrink-0 font-human text-base font-semibold tracking-tight">
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
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
      <Link to="/projects" className="font-human text-base font-semibold tracking-tight">
        ACE
      </Link>
      {project.data && (
        <>
          <span className="text-fg-muted">/</span>
          <Link
            to={`/projects/${project.data.id}`}
            className="truncate font-human text-sm"
            data-testid="project-name"
          >
            {project.data.name}
          </Link>
        </>
      )}
      {projectId && (
        <div className="min-w-0 flex-1">
          <WorkflowTabs projectId={projectId} activeWorkflowId={workflowId} />
        </div>
      )}
      {!projectId && <div className="flex-1" />}
      <ProviderStatusBar />
      {workflowId && <RunBar workflowId={workflowId} />}
      <ApprovalsBadge runId={runId} />
      <DayTotalsChip />
      <Button asChild variant="ghost" size="icon" aria-label="Usage">
        <Link to="/usage">
          <BarChart3 className="h-4 w-4" />
        </Link>
      </Button>
      <Button asChild variant="ghost" size="icon" aria-label="Guardrail policies">
        <Link to="/guardrails">
          <ShieldCheck className="h-4 w-4" />
        </Link>
      </Button>
      <Button asChild variant="ghost" size="icon" aria-label="Settings">
        <Link to="/settings">
          <Settings className="h-4 w-4" />
        </Link>
      </Button>
      <Button asChild variant="ghost" size="icon" aria-label="Help">
        <Link to="/help/getting-started">
          <CircleHelp className="h-4 w-4" />
        </Link>
      </Button>
    </header>
  );
}
