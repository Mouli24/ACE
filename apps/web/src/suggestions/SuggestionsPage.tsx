import {
  SUGGESTION_STATUSES,
  type Responsibility,
  type Suggestion,
  type SuggestionStatus,
} from '@ace/contracts';
import { Button, cn, toast } from '@ace/ui';
import { Inbox, Lightbulb, Plus, Radar } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ConfirmDialog } from '../knowledge/ConfirmDialog';
import { selectClass } from '../knowledge/fields';
import { useProject } from '../projects/hooks';
import { ProjectNav } from '../projects/ProjectNav';
import { useWorkflows } from '../workflows/hooks';
import {
  useDeleteResponsibility,
  useRefreshWhenScansEnd,
  useResponsibilities,
  useSuggestions,
} from './hooks';
import { STATUS_LABEL } from './meta';
import { ResponsibilityCard } from './ResponsibilityCard';
import { ResponsibilityDialog } from './ResponsibilityDialog';
import { SuggestionCard } from './SuggestionCard';

const ALL = 'all';
type Filter = SuggestionStatus | typeof ALL;

type Editing = { kind: 'new' } | { kind: 'edit'; responsibility: Responsibility } | null;

/**
 * `/projects/:projectId/suggestions` (ACE parity P2, D280): the project's responsibilities — what
 * ACE should watch, why, and what useful work looks like — and the suggestions their scans found.
 * A scan runs on *Scan now* or, with *Watch automatically* on, on a timer while the engine runs;
 * the page follows a running scan (polling, and `project.changed` from the engine). A suggestion is
 * added to the Inbox, kept for later or dismissed; adding one creates a task and starts nothing.
 */
export function SuggestionsPage() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const workflows = useWorkflows(projectId);
  const responsibilities = useResponsibilities(projectId);
  const remove = useDeleteResponsibility(projectId);
  useRefreshWhenScansEnd(projectId, responsibilities.data);

  const [filter, setFilter] = useState<Filter>('new');
  const suggestions = useSuggestions(projectId, filter === ALL ? undefined : filter);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Responsibility | null>(null);
  const [accepted, setAccepted] = useState<Suggestion | null>(null);

  const titles = useMemo(
    () => new Map((responsibilities.data ?? []).map((row) => [row.id, row.title])),
    [responsibilities.data],
  );

  const confirmDelete = () => {
    if (deleting === null) return;
    remove.mutate(deleting.id, {
      onSuccess: () => {
        toast.success(`"${deleting.title}" deleted`);
        setDeleting(null);
      },
    });
  };

  return (
    <main
      data-testid="suggestions-page"
      className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto px-4 py-8"
    >
      <ProjectNav projectId={projectId} />
      <header>
        <h1 className="font-human text-2xl font-semibold">Suggestions</h1>
        <p className="mt-1 font-human text-sm text-fg-muted">
          Tell ACE what to watch in {project.data?.name ?? 'this project'} and why. A scan runs only
          when you press Scan now or turn on Watch automatically; what it finds waits here until you
          add it to the Inbox, keep it for later or dismiss it. Adding one creates a task — it never
          starts work.
        </p>
      </header>

      <section aria-labelledby="responsibilities-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="responsibilities-heading" className="font-human text-lg font-semibold">
            Responsibilities
          </h2>
          <Button className="self-start" onClick={() => setEditing({ kind: 'new' })}>
            <Plus className="h-4 w-4" aria-hidden /> New responsibility
          </Button>
        </div>

        {responsibilities.isPending && <p className="text-fg-muted">Loading responsibilities…</p>}
        {responsibilities.isError && (
          <p role="alert" className="text-danger">
            Could not load responsibilities: {responsibilities.error.message}
          </p>
        )}
        {responsibilities.data?.length === 0 && (
          <div
            data-testid="responsibilities-empty"
            className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border p-8 text-center"
          >
            <Radar className="h-6 w-6 text-fg-muted" aria-hidden />
            <p className="max-w-md font-human text-fg-muted">
              No responsibilities yet. Write one — for example “Keep the checks green” — and ACE
              looks for work worth doing when you ask it to.
            </p>
            <Button variant="secondary" onClick={() => setEditing({ kind: 'new' })}>
              Write the first responsibility
            </Button>
          </div>
        )}
        {responsibilities.data !== undefined && responsibilities.data.length > 0 && (
          <ul aria-label="Responsibilities" className="flex flex-col gap-3">
            {responsibilities.data.map((row) => (
              <li key={row.id}>
                <ResponsibilityCard
                  responsibility={row}
                  onEdit={() => setEditing({ kind: 'edit', responsibility: row })}
                  onDelete={() => setDeleting(row)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="suggestions-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="suggestions-heading" className="font-human text-lg font-semibold">
            Found work
          </h2>
          <label className="flex items-center gap-2 font-human text-sm">
            <span className="text-fg-muted">Show</span>
            <select
              aria-label="Show suggestions"
              className={cn(selectClass, 'w-44')}
              value={filter}
              onChange={(event) => setFilter(event.target.value as Filter)}
            >
              {SUGGESTION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
              <option value={ALL}>All</option>
            </select>
          </label>
        </div>

        {accepted !== null && accepted.taskId !== undefined && (
          <p
            role="status"
            data-testid="suggestion-accepted"
            className="flex flex-wrap items-center gap-1.5 rounded-card border border-border bg-panel px-4 py-3 font-human text-sm"
          >
            <Inbox className="h-4 w-4 text-fg-muted" aria-hidden />“{accepted.title}” is in the
            Inbox; it starts when you start it.
            <Link
              to={`/projects/${projectId}/tasks/${accepted.taskId}`}
              className="font-medium underline"
            >
              Open the task
            </Link>
          </p>
        )}

        {suggestions.isPending && <p className="text-fg-muted">Loading suggestions…</p>}
        {suggestions.isError && (
          <p role="alert" className="text-danger">
            Could not load suggestions: {suggestions.error.message}
          </p>
        )}
        {suggestions.data?.length === 0 && (
          <div
            data-testid="suggestions-empty"
            className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border p-8 text-center"
          >
            <Lightbulb className="h-6 w-6 text-fg-muted" aria-hidden />
            <p className="max-w-md font-human text-fg-muted">
              {filter === 'new' || filter === ALL
                ? 'Nothing found yet. Scan a responsibility to look for work worth doing.'
                : `No suggestions marked “${STATUS_LABEL[filter]}”.`}
            </p>
          </div>
        )}
        {suggestions.data !== undefined && suggestions.data.length > 0 && (
          <ul aria-label="Suggestions" className="flex flex-col gap-3">
            {suggestions.data.map((suggestion) => (
              <li key={suggestion.id}>
                <SuggestionCard
                  suggestion={suggestion}
                  projectId={projectId}
                  workflows={workflows.data ?? []}
                  responsibilityTitle={titles.get(suggestion.responsibilityId)}
                  onAccepted={setAccepted}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing !== null && (
        <ResponsibilityDialog
          key={editing.kind === 'new' ? 'new' : editing.responsibility.id}
          projectId={projectId}
          {...(editing.kind === 'edit' ? { responsibility: editing.responsibility } : {})}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={`Delete "${deleting.title}"?`}
          description="Its suggestions are deleted with it, and a scan still running is cancelled. Tasks already added to the Inbox stay."
          confirmLabel="Delete responsibility"
          pending={remove.isPending}
          error={remove.error}
          onConfirm={confirmDelete}
          onClose={() => {
            remove.reset();
            setDeleting(null);
          }}
        />
      )}
    </main>
  );
}
