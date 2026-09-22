import { Badge, Button } from '@ace/ui';
import { Settings } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { useProject } from '../../projects/hooks';
import { WorkflowTabs } from '../../workflows/WorkflowTabs';

/**
 * Top bar (round 1 §5 step 3): project name, workflow tabs, and placeholders where provider
 * status (round 2) and run controls (round 2) will go.
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
      <Badge title="Provider status arrives in Round 2">providers · Round 2</Badge>
      <Badge title="Run controls arrive in Round 2">run controls · Round 2</Badge>
      <Button asChild variant="ghost" size="icon" aria-label="Settings">
        <Link to="/settings">
          <Settings className="h-4 w-4" />
        </Link>
      </Button>
    </header>
  );
}
