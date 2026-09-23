import { Badge, Button } from '@ace/ui';
import { Settings } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { useProject } from '../../projects/hooks';
import { ProviderStatusBar } from '../../providers/ProviderStatusBar';
import { WorkflowTabs } from '../../workflows/WorkflowTabs';

/**
 * Top bar: project name, workflow tabs, live provider status (FR-PRV-004) and the slot where run
 * controls land in Round 3.
 */
export function TopBar() {
  const { projectId, workflowId } = useParams();
  const project = useProject(projectId);

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
      <Badge title="Pause, stop and retry arrive in Round 3">run controls · Round 3</Badge>
      <Button asChild variant="ghost" size="icon" aria-label="Settings">
        <Link to="/settings">
          <Settings className="h-4 w-4" />
        </Link>
      </Button>
    </header>
  );
}
