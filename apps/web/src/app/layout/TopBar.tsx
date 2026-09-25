import { Button } from '@ace/ui';
import { Settings, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { useProject } from '../../projects/hooks';
import { ProviderStatusBar } from '../../providers/ProviderStatusBar';
import { RunBar } from '../../runs/RunBar';
import { ApprovalsBadge } from '../../runs/approvals/ApprovalsBadge';
import { useRunStore } from '../../runs/run-store';
import { WorkflowTabs } from '../../workflows/WorkflowTabs';

/**
 * Top bar: project name, workflow tabs, live provider status (FR-PRV-004), and — on a Canvas — the
 * run controls with the run's status and totals (FR-EXE-001, FR-OBS-002, FR-CTL-001..004), plus a
 * count of the approvals waiting on a person (FR-GRD-013).
 */
export function TopBar() {
  const { projectId, workflowId } = useParams();
  const project = useProject(projectId);
  const runId = useRunStore((store) => store.runId);

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
    </header>
  );
}
