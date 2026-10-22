import { useParams } from 'react-router-dom';

import { useWorkflows } from '../workflows/hooks';
import { RunsList } from './RunsList';

/**
 * `/projects/:projectId/runs` (round 2 §5 step 9). The engine lists runs per workflow, so this page
 * is one section per workflow rather than a merged list it would have to invent an order for.
 *
 * An uncovered screen in the theme's vocabulary (D328): a 960px column, a 20px title, and per
 * workflow a 13.5px heading over a surface card holding its run rows.
 */
export function ProjectRunsPage() {
  const { projectId = '' } = useParams();
  const workflows = useWorkflows(projectId);

  return (
    <main className="mx-auto flex h-full w-full max-w-[960px] flex-col gap-6 overflow-y-auto px-6 py-8 text-[var(--ink)]">
      <h1 className="m-0 text-[20px] font-bold tracking-[-0.01em]">Runs</h1>

      {workflows.isPending && (
        <p className="text-center text-[13px] text-[var(--muted)]">Loading workflows…</p>
      )}
      {workflows.isError && (
        <p role="alert" className="text-center text-[13px] text-danger">
          Could not load workflows: {workflows.error.message}
        </p>
      )}
      {workflows.data?.length === 0 && (
        <p className="py-8 text-center text-[13px] text-[var(--muted)]">
          This project has no workflows yet.
        </p>
      )}

      {workflows.data?.map((workflow) => (
        <section key={workflow.id} className="flex flex-col gap-[10px]">
          <h2 className="m-0 text-[13.5px] font-bold">{workflow.name}</h2>
          <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-[14px] py-1">
            <RunsList workflowId={workflow.id} />
          </div>
        </section>
      ))}
    </main>
  );
}
