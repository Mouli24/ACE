import { Button } from '@ace/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { CreateWorkflowDialog } from '../workflows/WorkflowDialogs';
import { useWorkflows } from '../workflows/hooks';
import { useProject } from './hooks';

/** `/projects/:projectId` — the project with its workflows; pick one to open the Canvas. */
export function ProjectPage() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const workflows = useWorkflows(projectId);
  const [creating, setCreating] = useState(false);

  if (project.isError) {
    return (
      <p role="alert" className="p-6 text-danger">
        Project not found.{' '}
        <Link to="/projects" className="underline">
          Back to projects
        </Link>
      </p>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-human text-2xl font-semibold">{project.data?.name ?? '…'}</h1>
          <p className="font-machine text-xs text-fg-muted">{project.data?.folderPath}</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New workflow
        </Button>
      </header>
      {workflows.data?.length === 0 && (
        <p className="rounded-card border border-dashed border-border p-8 text-center text-fg-muted">
          No workflows yet. Create one to open an empty Canvas.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {workflows.data?.map((wf) => (
          <li key={wf.id}>
            <Link
              to={`/projects/${projectId}/workflows/${wf.id}`}
              className="block rounded-card border border-border bg-panel px-4 py-3 font-human hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {wf.name} <span className="font-machine text-xs text-fg-muted">v{wf.version}</span>
            </Link>
          </li>
        ))}
      </ul>
      {creating && (
        <CreateWorkflowDialog projectId={projectId} onClose={() => setCreating(false)} />
      )}
    </main>
  );
}
