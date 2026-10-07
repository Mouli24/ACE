import type { Task, TaskSchedule } from '@ace/contracts';
import { Badge, Button, toast } from '@ace/ui';
import { CalendarClock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useDeleteSchedule, usePutSchedule, useTasks } from './hooks';
import { formatWhen } from './meta';
import { TimingFields } from './TimingFields';
import {
  describeTrigger,
  draftFromTrigger,
  emptyTiming,
  triggerFromDraft,
  type TimingDraft,
  type TimingKind,
} from './timing';

const SCHEDULE_KINDS: readonly TimingKind[] = ['once', 'recurring', 'after_task'];

/**
 * The Schedule card of an Inbox task (ACE parity P1, D277): the trigger in words, when it next
 * runs, how many occurrences were skipped (missed while ACE was closed, or while the previous one
 * was not Done), and Edit — the same Timing control as the New task dialog — or Remove.
 */
export function ScheduleCard({ task, schedule }: { task: Task; schedule?: TaskSchedule }) {
  const tasks = useTasks(task.projectId);
  const put = usePutSchedule(task);
  const remove = useDeleteSchedule(task);
  const [draft, setDraft] = useState<TimingDraft>();
  const [draftError, setDraftError] = useState<{ field: string; message: string }>();

  const others = useMemo(
    () => (tasks.data ?? []).filter((each) => each.id !== task.id && each.stage !== 'done'),
    [tasks.data, task.id],
  );
  const all = tasks.data ?? [];
  const lastTask =
    schedule?.lastTaskId === undefined
      ? undefined
      : all.find((each) => each.id === schedule.lastTaskId);

  const begin = () => {
    put.reset();
    setDraftError(undefined);
    setDraft(schedule === undefined ? emptyTiming('once') : draftFromTrigger(schedule.trigger));
  };

  const save = () => {
    if (draft === undefined) return;
    const when = triggerFromDraft(draft);
    if (!when.ok || when.trigger === undefined) {
      setDraftError(when.ok ? undefined : { field: when.field, message: when.message });
      return;
    }
    put.mutate(
      { trigger: when.trigger },
      {
        onSuccess: () => {
          setDraft(undefined);
          toast.success(schedule === undefined ? 'Scheduled' : 'Schedule saved');
        },
      },
    );
  };

  const unschedule = () =>
    remove.mutate(undefined, {
      onSuccess: () => toast.success('Schedule removed'),
      onError: (error) => toast.error('Schedule not removed', { description: error.message }),
    });

  return (
    <section
      aria-labelledby={`schedule-${task.id}`}
      data-testid="schedule-card"
      className="flex flex-col gap-3 rounded-card border border-border bg-panel p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock className="h-4 w-4 text-fg-muted" aria-hidden />
        <h2 id={`schedule-${task.id}`} className="font-human text-base font-semibold">
          Schedule
        </h2>
        {schedule !== undefined && !schedule.enabled && <Badge>not active</Badge>}
      </div>

      {schedule === undefined && draft === undefined && (
        <p className="font-human text-sm text-fg-muted">
          Not scheduled: it waits in the Inbox until someone starts it.
        </p>
      )}

      {schedule !== undefined && draft === undefined && (
        <dl className="grid grid-cols-1 gap-2 font-human text-sm sm:grid-cols-3">
          <div className="sm:col-span-3">
            <dt className="sr-only">Trigger</dt>
            <dd data-testid="schedule-trigger" className="text-fg">
              {describeTrigger(schedule.trigger, all)}
            </dd>
          </div>
          <div>
            <dt className="font-machine text-[10px] uppercase tracking-[0.1em] text-fg-muted">
              Next run
            </dt>
            <dd data-testid="schedule-next">
              {schedule.nextRunAt !== undefined && schedule.enabled
                ? formatWhen(schedule.nextRunAt)
                : schedule.trigger.kind === 'after_task' && schedule.enabled
                  ? 'When that task reaches its finish line'
                  : 'None'}
            </dd>
          </div>
          <div>
            <dt className="font-machine text-[10px] uppercase tracking-[0.1em] text-fg-muted">
              Skipped
            </dt>
            <dd data-testid="schedule-skipped">
              {schedule.skipped}{' '}
              <span className="text-xs text-fg-muted">
                (missed while ACE was closed, or while the last one was not Done)
              </span>
            </dd>
          </div>
          {schedule.lastRunAt !== undefined && (
            <div>
              <dt className="font-machine text-[10px] uppercase tracking-[0.1em] text-fg-muted">
                Last run
              </dt>
              <dd>
                {formatWhen(schedule.lastRunAt)}
                {lastTask !== undefined && (
                  <>
                    {' · '}
                    <Link
                      to={`/projects/${task.projectId}/tasks/${lastTask.id}`}
                      className="underline underline-offset-2"
                    >
                      #{lastTask.number}
                    </Link>
                  </>
                )}
              </dd>
            </div>
          )}
        </dl>
      )}

      {draft !== undefined ? (
        <div className="flex flex-col gap-3" data-testid="schedule-editor">
          <TimingFields
            idPrefix={`schedule-${task.id}`}
            value={draft}
            kinds={SCHEDULE_KINDS}
            tasks={others}
            error={draftError}
            onChange={(next) => {
              setDraft(next);
              setDraftError(undefined);
            }}
          />
          {put.error && (
            <p role="alert" className="text-sm text-danger">
              Not scheduled: {put.error.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={put.isPending} onClick={save}>
              Save schedule
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={begin}>
            {schedule === undefined ? 'Schedule…' : 'Edit schedule'}
          </Button>
          {schedule !== undefined && (
            <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={unschedule}>
              Remove schedule
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
