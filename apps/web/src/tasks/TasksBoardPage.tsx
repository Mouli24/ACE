import {
  TASK_PRIORITIES,
  TASK_STAGES,
  type Id,
  type Task,
  type TaskStage,
  type Workflow,
} from '@ace/contracts';
import { Badge, Button, Input, cn, toast } from '@ace/ui';
import { CirclePause, ListTodo, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { selectClass } from '../knowledge/fields';
import { useProject, useUpdateProject } from '../projects/hooks';
import { ProjectNav } from '../projects/ProjectNav';
import { useWorkflows } from '../workflows/hooks';
import { useTasks } from './hooks';
import { OUTCOME_LABEL, PRIORITY_LABEL, STAGE_LABEL, TYPE_LABEL } from './meta';
import { NewTaskDialog } from './NewTaskDialog';
import { TaskStateChip } from './TaskStateChip';

/** How long the search box waits after the last key before asking the engine. */
const SEARCH_DEBOUNCE_MS = 250;

const ALL_LABELS = '';

/** Urgent first, then the most recently changed. */
function byPriorityThenRecent(a: Task, b: Task): number {
  const rank = TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority);
  return rank !== 0 ? rank : b.updatedAt.localeCompare(a.updatedAt);
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * `/projects/:projectId/tasks` — the board (ACE parity P0, design §8): Inbox → Plan → Work →
 * Review → Done, one column each with its count. Search, a label filter and *Needs attention* are
 * the engine's filters (`TaskListQuery`); a paused project says so, with Resume.
 */
export function TasksBoardPage() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const workflows = useWorkflows(projectId);
  const updateProject = useUpdateProject();

  const [search, setSearch] = useState('');
  const [label, setLabel] = useState(ALL_LABELS);
  const [attention, setAttention] = useState(false);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search, SEARCH_DEBOUNCE_MS);

  const filter = { q, label, attention };
  const filtered = q.trim() !== '' || label !== ALL_LABELS || attention;
  const tasks = useTasks(projectId, filter);
  // The unfiltered board: the label choices, and whether the project has any task at all.
  const all = useTasks(projectId);

  const labels = useMemo(
    () => [...new Set((all.data ?? []).flatMap((task) => task.labels))].sort(),
    [all.data],
  );
  const teams = useMemo(
    () => new Map((workflows.data ?? []).map((workflow: Workflow) => [workflow.id, workflow.name])),
    [workflows.data],
  );
  const columns = useMemo(() => {
    const byStage = new Map<TaskStage, Task[]>(TASK_STAGES.map((stage) => [stage, []]));
    for (const task of tasks.data ?? []) byStage.get(task.stage)?.push(task);
    for (const list of byStage.values()) list.sort(byPriorityThenRecent);
    return byStage;
  }, [tasks.data]);

  const resume = () =>
    updateProject.mutate(
      { id: projectId, paused: false },
      {
        onSuccess: () => toast.success('Project resumed'),
        onError: (error) => toast.error('Could not resume', { description: error.message }),
      },
    );

  const clearFilters = () => {
    setSearch('');
    setLabel(ALL_LABELS);
    setAttention(false);
  };

  const noTasksAtAll = all.data?.length === 0 && !filtered;

  return (
    <main
      data-testid="tasks-board"
      className="mx-auto flex h-full w-full max-w-[1400px] flex-col gap-5 overflow-y-auto px-4 py-8"
    >
      <ProjectNav projectId={projectId} />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-human text-2xl font-semibold">Tasks</h1>
          <p className="mt-1 font-human text-sm text-fg-muted">
            Each task moves from Inbox to Done; its team works in its own branch and you review the
            changes before they reach {project.data?.name ?? 'the project'}.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} className="self-start">
          <Plus className="h-4 w-4" aria-hidden /> New task
        </Button>
      </header>

      {project.data?.paused === true && (
        <div
          role="status"
          data-testid="project-paused"
          className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-[var(--color-status-PAUSED)]/50 bg-[color-mix(in_oklab,var(--color-status-PAUSED)_8%,transparent)] px-4 py-3"
        >
          <span className="flex items-center gap-2 font-human text-sm">
            <CirclePause className="h-4 w-4 text-[var(--color-status-PAUSED)]" aria-hidden />
            This project is paused: its tasks take no automatic step until it is resumed.
          </span>
          <Button size="sm" variant="secondary" onClick={resume} disabled={updateProject.isPending}>
            Resume
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="board-filters">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search tasks"
            placeholder="Search title, brief or #number"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-8"
          />
        </div>
        <select
          aria-label="Label"
          className={cn(selectClass, 'sm:w-48')}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        >
          <option value={ALL_LABELS}>All labels</option>
          {labels.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <Button
          variant={attention ? 'default' : 'secondary'}
          aria-pressed={attention}
          onClick={() => setAttention((on) => !on)}
        >
          Needs attention
        </Button>
        {filtered && (
          <Button variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      {tasks.isPending && <p className="text-fg-muted">Loading tasks…</p>}
      {tasks.isError && (
        <p role="alert" className="text-danger">
          Could not load tasks: {tasks.error.message}
        </p>
      )}

      {noTasksAtAll ? (
        <div
          data-testid="tasks-empty"
          className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border p-10 text-center"
        >
          <ListTodo className="h-6 w-6 text-fg-muted" aria-hidden />
          <p className="max-w-md font-human text-fg-muted">
            No tasks yet. A task is one piece of work: say what should change and how you will check
            it, pick the team that does it, and review the result before it lands.
          </p>
          <Button variant="secondary" onClick={() => setCreating(true)}>
            Create your first task
          </Button>
        </div>
      ) : (
        tasks.data && (
          <>
            {filtered && tasks.data.length === 0 && (
              <p data-testid="tasks-no-match" className="font-human text-sm text-fg-muted">
                No tasks match these filters.
              </p>
            )}
            <div className="grid min-h-0 flex-1 auto-cols-[minmax(232px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
              {TASK_STAGES.map((stage) => (
                <BoardColumn
                  key={stage}
                  stage={stage}
                  tasks={columns.get(stage) ?? []}
                  projectId={projectId}
                  teams={teams}
                />
              ))}
            </div>
          </>
        )
      )}

      {creating && (
        <NewTaskDialog
          projectId={projectId}
          workflows={workflows.data ?? []}
          onClose={() => setCreating(false)}
        />
      )}
    </main>
  );
}

function BoardColumn({
  stage,
  tasks,
  projectId,
  teams,
}: {
  stage: TaskStage;
  tasks: Task[];
  projectId: Id;
  teams: Map<Id, string>;
}) {
  const headingId = `column-${stage}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`column-${stage}`}
      className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-panel/60 p-2"
    >
      <h2
        id={headingId}
        className="flex items-center justify-between px-1.5 pt-1 font-machine text-[10.5px] uppercase tracking-[0.1em] text-fg-soft"
      >
        <span>{STAGE_LABEL[stage]}</span>
        <span
          data-testid={`column-count-${stage}`}
          aria-label={`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}
          className="rounded-chip border border-border px-1.5 text-fg-muted"
        >
          {tasks.length}
        </span>
      </h2>
      {tasks.length === 0 ? (
        <p className="px-1.5 py-3 font-human text-xs text-fg-faint">Nothing here.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tasks.map((task) => (
            <li key={task.id}>
              <TaskCard task={task} projectId={projectId} team={teams.get(task.workflowId ?? '')} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskCard({
  task,
  projectId,
  team,
}: {
  task: Task;
  projectId: Id;
  team: string | undefined;
}) {
  return (
    <Link
      to={`/projects/${projectId}/tasks/${task.id}`}
      data-testid={`task-card-${task.number}`}
      className="flex flex-col gap-2 rounded-card border border-border bg-card p-3 transition-colors hover:border-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
    >
      <span className="flex items-center justify-between gap-2 font-machine text-[10.5px] text-fg-muted">
        <span>#{task.number}</span>
        <span className="uppercase tracking-[0.08em]">{TYPE_LABEL[task.type]}</span>
      </span>
      <span className="font-human text-[15px] leading-snug text-fg">{task.title}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <TaskStateChip state={task.state} reason={task.stateReason} />
        {task.outcome !== undefined && (
          <Badge data-testid="task-outcome">{OUTCOME_LABEL[task.outcome]}</Badge>
        )}
        {task.priority !== 'normal' && (
          <Badge
            data-testid="task-priority"
            className={cn(
              task.priority === 'urgent' && 'border-danger/60 text-danger',
              task.priority === 'high' && 'border-[var(--color-status-WAITING)]/60',
            )}
          >
            {PRIORITY_LABEL[task.priority]}
          </Badge>
        )}
        {task.paused && <Badge>paused</Badge>}
      </span>
      {(team !== undefined || task.labels.length > 0) && (
        <span className="flex flex-wrap items-center gap-1.5">
          {team !== undefined && (
            <span data-testid="task-team" className="font-machine text-[10.5px] text-fg-soft">
              {team}
            </span>
          )}
          {task.labels.map((name) => (
            <Badge key={name} variant="outline" className="text-[10px]">
              {name}
            </Badge>
          ))}
        </span>
      )}
    </Link>
  );
}
