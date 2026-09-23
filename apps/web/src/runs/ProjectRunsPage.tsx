import { useParams } from 'react-router-dom';

import { useWorkflows } from '../workflows/hooks';
import { RunsList } from './RunsList';

/**
 * `/projects/:projectId/runs` (round 2 §5 step 9). The engine lists runs per workflow, so this page
 * is one section per workflow rather than a merged list it would have to invent an order for.
 */
export function ProjectRunsPage() {
  const { projectId = '' } = useParams();
  const workflows = useWorkflows(projectId);

  return (
    <main className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto px-4 py-8">
      <h1 className="font-human text-2xl font-semibold">Runs</h1>

      {workflows.isPending && <p className="text-fg-muted">Loading workflows…</p>}
      {workflows.isError && (
        <p role="alert" className="text-danger">
          Could not load workflows: {workflows.error.message}
        </p>
      )}
      {workflows.data?.length === 0 && (
        <p className="rounded-card border border-dashed border-border p-8 text-center text-fg-muted">
          This project has no workflows yet.
        </p>
      )}

      {workflows.data?.map((workflow) => (
        <section key={workflow.id} className="flex flex-col gap-2">
          <h2 className="font-human text-sm font-semibold">{workflow.name}</h2>
          <div className="rounded-card border border-border bg-panel">
            <RunsList workflowId={workflow.id} />
          </div>
        </section>
      ))}
    </main>
  );
}
