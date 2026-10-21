import { CheckCommandSchema, type TerminalTrust } from '@ace/contracts';
import { Button } from '@ace/ui';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ModeLinks } from '../app/ModeLinks';
import { QueryError } from '../app/QueryError';
import { isNotFound } from '../app/query-client';
import { BudgetFields } from '../settings/BudgetFields';
import { SelectField, SettingInput, type DraftRead } from '../settings/SettingFields';
import { ago } from '../theme/format';
import { useWorkflowImport } from '../workflows/ImportWorkflowButton';
import { CreateWorkflowDialog } from '../workflows/WorkflowDialogs';
import { useWorkflows } from '../workflows/hooks';
import { useProject, useUpdateProject } from './hooks';

/** D301: how far this project trusts Forge's terminal. */
const TERMINAL_OPTIONS: ReadonlyArray<{ value: TerminalTrust; label: string }> = [
  { value: 'on', label: 'On — any command' },
  { value: 'scripts', label: 'Scripts only' },
  { value: 'off', label: 'Off' },
];

/** Forge's format-on-save (D299 Phase 4): absent reads as Off. */
const FORMAT_ON_SAVE_OPTIONS: ReadonlyArray<{ value: 'on' | 'off'; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
];

/**
 * The check command as typed: trimmed, 1..1000 characters (the contract's bound). Blank removes a
 * saved command (`null`) and is nothing to save when there is none.
 */
function readCheckCommand(raw: string, current: string | undefined): DraftRead<string | null> {
  const trimmed = raw.trim();
  if (trimmed === '') return current === undefined ? { skip: true } : { value: null };
  return CheckCommandSchema.safeParse(trimmed).success
    ? { value: trimmed }
    : { error: 'A check command is at most 1000 characters.' };
}

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

  // Audit U-2 (D-009): "not found" is the engine's 404 only; any other failure says what it was.
  if (project.isError) {
    return (
      <main className="h-full overflow-y-auto">
        {isNotFound(project.error) ? (
          <p role="alert" className="mx-auto max-w-[960px] px-6 py-8 text-[13px] text-[#c94c27]">
            Project not found. <Link to="/projects">Back to projects</Link>
          </p>
        ) : (
          <QueryError
            what="this project"
            error={project.error}
            onRetry={() => void project.refetch()}
            className="mx-auto max-w-[960px] items-start px-6 py-8"
          />
        )}
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
              <li
                key={wf.id}
                className="flex h-full flex-col rounded-[12px] border border-[var(--line)] bg-[var(--surface)] transition-colors focus-within:border-[#ef6b3f] hover:border-[#ef6b3f]"
              >
                <Link
                  to={`/projects/${projectId}/workflows/${wf.id}`}
                  data-testid={`workflow-card-${wf.id}`}
                  className="flex flex-1 flex-col rounded-[12px] p-3 pb-2 text-[var(--ink)] outline-none hover:text-[var(--ink)]"
                >
                  <span className="truncate text-[13.5px] font-bold">{wf.name}</span>
                  <span className="mt-[9px] flex gap-2 border-t border-[var(--line)] pt-[9px] font-machine text-[10px] text-[var(--muted)]">
                    <span>v{wf.version}</span>
                    <span className="flex-1" />
                    <span>{ago(wf.updatedAt)}</span>
                  </span>
                </Link>
                {/* PG-3.7: the card opens Ideate; each mode is one click away too. */}
                <ModeLinks
                  projectId={projectId}
                  workflowId={wf.id}
                  testIdPrefix={`workflow-card-${wf.id}-mode`}
                  className="px-3 pb-3"
                />
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

        {/* D301: Forge's terminal, in its own theme card. Off disables it now: what runs is stopped. */}
        <div
          data-testid="project-terminal-card"
          className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4"
        >
          <SelectField<TerminalTrust>
            id="project-terminal"
            label="Terminal"
            hint="On runs any command typed in Forge's terminal. Scripts only runs this project's package.json scripts. Off turns the terminal off and stops what runs."
            testId="project-terminal"
            value={project.data?.terminal ?? 'on'}
            options={TERMINAL_OPTIONS}
            onChange={(terminal) => updateProject.mutate({ id: projectId, terminal })}
            disabled={!project.data}
          />
        </div>

        {/* D299 Phase 4: what Forge's Run checks runs, and whether a save formats first. */}
        <div
          data-testid="project-checks-card"
          className="grid gap-4 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4 sm:grid-cols-2"
        >
          <SettingInput<string | null>
            label="Check command"
            hint="Run checks in Forge's Problems runs it at the project folder, and lists the errors it prints. Under Scripts only, name a package.json script."
            testId="project-check-command"
            value={project.data?.checkCommand ?? undefined}
            read={(raw) => readCheckCommand(raw, project.data?.checkCommand ?? undefined)}
            onSave={(checkCommand) =>
              updateProject.mutateAsync({ id: projectId, checkCommand }).then(
                () => true,
                () => false,
              )
            }
            disabled={!project.data}
            placeholder="pnpm tsc --noEmit"
          />
          <SelectField<'on' | 'off'>
            id="project-format-on-save"
            label="Format on save"
            hint="Forge formats the file in the editor before saving it, where a formatter knows its language."
            testId="project-format-on-save"
            value={project.data?.formatOnSave === true ? 'on' : 'off'}
            options={FORMAT_ON_SAVE_OPTIONS}
            onChange={(value) =>
              updateProject.mutate({ id: projectId, formatOnSave: value === 'on' })
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
