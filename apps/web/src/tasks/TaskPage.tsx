import {
  TASK_NOTE_MAX,
  TASK_STAGES,
  TASK_TITLE_MAX,
  type Task,
  type TaskAction,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import {
  Badge,
  Button,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  cn,
  toast,
} from '@ace/ui';
import { Check, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ConfirmDialog } from '../knowledge/ConfirmDialog';
import { ProjectNav } from '../projects/ProjectNav';
import { useWorkflows } from '../workflows/hooks';
import {
  useCloseTask,
  useDeleteTask,
  usePauseTask,
  usePlanTask,
  useRetryTask,
  useRunTaskChecks,
  useStartTask,
  useStopTask,
  useTask,
  useUpdateTask,
  useWorkTask,
} from './hooks';
import { OUTCOME_LABEL, STAGE_LABEL, TYPE_LABEL } from './meta';
import { ReviewPanel } from './ReviewPanel';
import { TaskActivityFeed } from './TaskActivity';
import { TaskBuild } from './TaskBuild';
import { TaskChanges } from './TaskChanges';
import { TaskChecks } from './TaskChecks';
import { TaskOverview } from './TaskOverview';
import { TaskStateChip } from './TaskStateChip';

/**
 * `/projects/:projectId/tasks/:taskId` — one task (ACE parity P0, design §8): its number and title,
 * where it is on the way to Done, what is happening and why, and only the actions the engine allows
 * right now (`task.allowedActions`). In review, the Review panel; below, Overview · Build · Changes ·
 * Checks · Activity.
 */
export function TaskPage() {
  const { projectId = '', taskId = '' } = useParams();
  const detail = useTask(taskId);
  const workflows = useWorkflows(projectId);
  const boardPath = `/projects/${projectId}/tasks`;

  if (detail.isPending) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-8">
        <p className="text-fg-muted">Loading the task…</p>
      </main>
    );
  }
  if (detail.isError) {
    const gone = AceApiError.is(detail.error) && detail.error.status === 404;
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8">
        <ProjectNav projectId={projectId} />
        <p role="alert" className="text-danger">
          {gone
            ? 'This task does not exist any more.'
            : `Could not load the task: ${detail.error.message}`}{' '}
          <Link to={boardPath} className="underline">
            Back to the board
          </Link>
        </p>
      </main>
    );
  }

  const { task, workspace, executions, checks, reviews } = detail.data;
  return (
    <main
      data-testid="task-page"
      className="mx-auto flex h-full w-full max-w-5xl flex-col gap-5 overflow-y-auto px-4 py-8"
    >
      <ProjectNav projectId={projectId} />
      <Link
        to={boardPath}
        className="self-start font-human text-xs text-fg-muted underline-offset-2 hover:underline"
      >
        ← Tasks
      </Link>
      <TaskHeader task={task} boardPath={boardPath} />

      {task.stage === 'review' && (
        <ReviewPanel
          task={task}
          {...(workspace === undefined ? {} : { workspace })}
          checks={checks}
          reviews={reviews}
        />
      )}

      <Tabs defaultValue="overview" className="flex flex-col gap-4">
        <TabsList aria-label="Task" className="self-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="build">Build</TabsTrigger>
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="checks">Checks</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <TaskOverview task={task} workflows={workflows.data ?? []} />
        </TabsContent>
        <TabsContent value="build">
          <TaskBuild task={task} executions={executions} />
        </TabsContent>
        <TabsContent value="changes">
          <TaskChanges task={task} {...(workspace === undefined ? {} : { workspace })} />
        </TabsContent>
        <TabsContent value="checks">
          <TaskChecks
            checks={checks}
            {...(workspace === undefined ? {} : { workspace })}
            projectId={projectId}
          />
        </TabsContent>
        <TabsContent value="activity">
          <TaskActivityFeed taskId={task.id} />
        </TabsContent>
      </Tabs>
    </main>
  );
}

function TaskHeader({ task, boardPath }: { task: Task; boardPath: string }) {
  return (
    <header className="flex flex-col gap-3" data-testid="task-header">
      <TitleEditor task={task} />
      <StageStepper task={task} />
      <div className="flex flex-wrap items-center gap-2">
        <TaskStateChip
          state={task.state}
          reason={task.stateReason}
          always={task.state !== 'done'}
        />
        {task.outcome !== undefined && (
          <Badge data-testid="task-outcome">{OUTCOME_LABEL[task.outcome]}</Badge>
        )}
        {task.paused && <Badge>paused</Badge>}
        <span className="font-machine text-[10.5px] uppercase tracking-[0.08em] text-fg-muted">
          {TYPE_LABEL[task.type]}
        </span>
      </div>
      {task.stateReason !== undefined && (
        <p data-testid="task-reason" className="font-human text-sm text-fg-soft">
          {task.stateReason}
        </p>
      )}
      <TaskActions task={task} boardPath={boardPath} />
    </header>
  );
}

function TitleEditor({ task }: { task: Task }) {
  const update = useUpdateTask(task.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const editable = task.stage !== 'done';

  const begin = () => {
    setDraft(task.title);
    setEditing(true);
  };
  const save = () => {
    setEditing(false);
    const title = draft.trim();
    if (title === '' || title === task.title) return;
    update.mutate(
      { title },
      {
        onSuccess: () => toast.success('Title saved'),
        onError: (error) => toast.error('Title not saved', { description: error.message }),
      },
    );
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-machine text-lg text-fg-muted">#{task.number}</span>
        <Input
          aria-label="Task title"
          autoFocus
          value={draft}
          maxLength={TASK_TITLE_MAX}
          className="font-human text-xl"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Save title"
          onMouseDown={(event) => event.preventDefault()}
          onClick={save}
        >
          <Check className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <h1 className="min-w-0 font-human text-2xl font-semibold leading-tight">
        <span className="font-machine text-lg font-normal text-fg-muted">#{task.number}</span>{' '}
        {task.title}
      </h1>
      {editable && (
        <Button size="icon" variant="ghost" aria-label="Edit title" onClick={begin}>
          <Pencil className="h-4 w-4" aria-hidden />
        </Button>
      )}
    </div>
  );
}

/** Inbox → Plan → Work → Review → Done, the current stage marked (`aria-current="step"`). */
function StageStepper({ task }: { task: Task }) {
  const current = TASK_STAGES.indexOf(task.stage);
  return (
    <ol
      aria-label="Stages"
      data-testid="stage-stepper"
      className="flex flex-wrap items-center gap-1"
    >
      {TASK_STAGES.map((stage, index) => {
        const state = index < current ? 'past' : index === current ? 'current' : 'future';
        return (
          <li key={stage} className="flex items-center gap-1">
            <span
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'inline-flex h-[24px] items-center rounded-chip border px-3 font-machine text-[10.5px] tracking-[0.04em]',
                state === 'current' && 'border-fg bg-fg text-canvas',
                state === 'past' && 'border-border text-fg-soft',
                state === 'future' && 'border-dashed border-border text-fg-faint',
              )}
            >
              {STAGE_LABEL[stage]}
            </span>
            {index < TASK_STAGES.length - 1 && (
              <span aria-hidden className="text-fg-faint">
                →
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The header's buttons, in this order, each shown only while the engine allows it. */
const ACTION_ORDER: readonly { action: TaskAction; label: string }[] = [
  { action: 'start', label: 'Start' },
  { action: 'plan', label: 'Start planning' },
  { action: 'work', label: 'Start work' },
  { action: 'stop', label: 'Stop' },
  { action: 'retry', label: 'Retry' },
  { action: 'checks', label: 'Run checks' },
  { action: 'pause', label: 'Pause' },
  { action: 'resume', label: 'Resume' },
  { action: 'close', label: 'Close without verification' },
  { action: 'delete', label: 'Delete' },
];

function TaskActions({ task, boardPath }: { task: Task; boardPath: string }) {
  const navigate = useNavigate();
  const start = useStartTask(task.id);
  const plan = usePlanTask(task.id);
  const work = useWorkTask(task.id);
  const stop = useStopTask(task.id);
  const retry = useRetryTask(task.id);
  const checks = useRunTaskChecks(task.id);
  const pause = usePauseTask(task.id);
  const close = useCloseTask(task.id);
  const remove = useDeleteTask();
  const [confirm, setConfirm] = useState<'close' | 'delete'>();
  const [reason, setReason] = useState('');

  const refused = (what: string) => (error: Error) =>
    toast.error(`Could not ${what}`, { description: error.message });

  const run: Partial<Record<TaskAction, () => void>> = {
    start: () => start.mutate(undefined, { onError: refused('start the task') }),
    plan: () => plan.mutate(undefined, { onError: refused('start planning') }),
    work: () => work.mutate({}, { onError: refused('start work') }),
    stop: () => stop.mutate(undefined, { onError: refused('stop') }),
    retry: () => retry.mutate(undefined, { onError: refused('retry') }),
    checks: () =>
      checks.mutate(undefined, {
        onSuccess: () => toast.success('Checks ran'),
        onError: refused('run the checks'),
      }),
    pause: () => pause.mutate(true, { onError: refused('pause') }),
    resume: () => pause.mutate(false, { onError: refused('resume') }),
    close: () => setConfirm('close'),
    delete: () => setConfirm('delete'),
  };

  const busy =
    start.isPending ||
    plan.isPending ||
    work.isPending ||
    stop.isPending ||
    retry.isPending ||
    checks.isPending ||
    pause.isPending;
  const shown = ACTION_ORDER.filter(({ action }) => task.allowedActions.includes(action));

  return (
    <>
      {shown.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="task-actions">
          {shown.map(({ action, label }) => (
            <Button
              key={action}
              size="sm"
              variant={
                action === 'delete'
                  ? 'destructive'
                  : action === 'close'
                    ? 'outline'
                    : action === shown[0]?.action
                      ? 'default'
                      : 'secondary'
              }
              disabled={busy}
              onClick={run[action]}
            >
              {label}
            </Button>
          ))}
        </div>
      )}

      {confirm === 'close' && (
        <ConfirmDialog
          title="Close without verification?"
          description="The task goes to Done as closed without verification: nothing certifies that its finish line was reached."
          confirmLabel="Close task"
          pending={close.isPending}
          error={close.error}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => {
            const text = reason.trim();
            close.mutate(text === '' ? {} : { reason: text }, {
              onSuccess: () => {
                setConfirm(undefined);
                setReason('');
                toast.success(`Task #${task.number} closed`);
              },
            });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`close-reason-${task.id}`}>Why (optional)</Label>
            <Textarea
              id={`close-reason-${task.id}`}
              rows={2}
              value={reason}
              maxLength={TASK_NOTE_MAX}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </ConfirmDialog>
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title={`Delete task #${task.number}?`}
          description="The task, its activity and its workspace are removed. Its branch is deleted too. This cannot be undone."
          confirmLabel="Delete task"
          pending={remove.isPending}
          error={remove.error}
          onClose={() => setConfirm(undefined)}
          onConfirm={() =>
            remove.mutate(task, {
              onSuccess: () => {
                toast.success(`Task #${task.number} deleted`);
                navigate(boardPath);
              },
            })
          }
        />
      )}
    </>
  );
}
