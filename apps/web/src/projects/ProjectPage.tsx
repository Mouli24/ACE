import { Button } from '@ace/ui';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { BudgetFields } from '../settings/BudgetFields';
import { ago } from '../theme/format';
import { useWorkflowImport } from '../workflows/ImportWorkflowButton';
import { CreateWorkflowDialog } from '../workflows/WorkflowDialogs';
import { useWorkflows } from '../workflows/hooks';
import { useProject, useUpdateProject } from './hooks';

/**
 * `/projects/:projectId` — the project with its workflows; pick one to open the Canvas. An uncovered
 * screen in the Ace UI theme (D328): page title, theme pills for the actions, the workflows as
 * theme cards, the per-run budget in a theme card.
 */
export function ProjectPage() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const workflows = useWorkflows(projectId);
  const updateProject = useUpdateProject();
  const [creating, setCreating] = useState(false);
  const [importError, setImportError] = useState<string>();
  // FR-WF-008: the import flow is the shared hook; its hidden input keeps the name "Import JSON".
  const importer = useWorkflowImport(projectId, {
    onError: setImportError,
    onStart: () => setImportError(undefined),
  });

  if (project.isError) {
    return (
      <main className="h-full overflow-y-auto">
        <p role="alert" className="mx-auto max-w-[960px] px-6 py-8 text-[13px] text-[#c94c27]">
          Project not found. <Link to="/projects">Back to projects</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-6 py-8">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1
              className="break-words text-[20px] font-bold tracking-[-0.01em]"
              data-testid="project-page-name"
            >
              {project.data?.name ?? '…'}
            </h1>
            <p className="mt-1 break-all font-machine text-[10px] text-[var(--muted)]">
              {project.data?.folderPath}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button asChild variant="secondary" size="sm">
                <Link to={`/projects/${projectId}/runs`}>Runs</Link>
              </Button>
              <Button asChild variant="secondary" size="sm">
                <Link to={`/projects/${projectId}/knowledge`}>Knowledge</Link>
              </Button>
              {importer.input}
              <Button
                variant="secondary"
                size="sm"
                onClick={importer.pick}
                disabled={importer.pending}
              >
                Import JSON
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                New workflow
              </Button>
            </div>
            {importError && (
              <p
                role="alert"
                className="max-w-sm text-right text-[11px] leading-[1.45] text-[#c94c27]"
              >
                {importError}
              </p>
            )}
          </div>
        </header>

        <section aria-labelledby="project-workflows-heading" className="flex flex-col gap-3">
          <h2 id="project-workflows-heading" className="text-[14px] font-bold">
            Workflows
          </h2>
          {workflows.data?.length === 0 && (
            <p className="py-10 text-center text-[13px] text-[var(--muted)]">
              No workflows yet. Create one to open an empty Canvas.
            </p>
          )}
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-[10px]">
            {workflows.data?.map((wf) => (
              <li key={wf.id}>
                <Link
                  to={`/projects/${projectId}/workflows/${wf.id}`}
                  data-testid={`workflow-card-${wf.id}`}
                  className="flex h-full flex-col rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-3 text-[var(--ink)] outline-none transition-colors hover:border-[#ef6b3f] hover:text-[var(--ink)] focus-visible:border-[#ef6b3f]"
                >
                  <span className="truncate text-[13.5px] font-bold">{wf.name}</span>
                  <span className="mt-[9px] flex gap-2 border-t border-[var(--line)] pt-[9px] font-machine text-[10px] text-[var(--muted)]">
                    <span>v{wf.version}</span>
                    <span className="flex-1" />
                    <span>{ago(wf.updatedAt)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {/* FR-GRD-008: what one run of this project may spend before it halts `budget_exceeded`. */}
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4">
          <BudgetFields
            fields="run"
            dailyBudgetUsd={undefined}
            maxCostPerRunUsd={project.data?.maxCostPerRunUsd}
            onSaveDailyBudget={() => undefined}
            onSaveMaxCostPerRun={(maxCostPerRunUsd) =>
              updateProject.mutate({ id: projectId, maxCostPerRunUsd })
            }
            disabled={!project.data}
          />
        </div>
      </div>

      {creating && (
        <CreateWorkflowDialog projectId={projectId} onClose={() => setCreating(false)} />
      )}
    </main>
  );
}
