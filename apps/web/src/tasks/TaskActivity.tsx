import type { TaskActivityKind } from '@ace/contracts';
import { Link } from 'react-router-dom';

import { useTaskActivity } from './hooks';
import { timeAgo } from './meta';

/** A short word per activity kind, for the feed's margin. */
const KIND_LABEL: Readonly<Record<TaskActivityKind, string>> = {
  created: 'created',
  edited: 'edited',
  stage_changed: 'stage',
  queued: 'queued',
  workspace_ready: 'workspace',
  workspace_failed: 'workspace',
  run_started: 'run',
  run_completed: 'run',
  run_failed: 'run',
  run_stopped: 'run',
  waiting: 'waiting',
  resumed: 'resumed',
  committed: 'commit',
  checks_started: 'checks',
  checks_passed: 'checks',
  checks_failed: 'checks',
  approved: 'review',
  changes_requested: 'review',
  delivered: 'delivery',
  delivery_failed: 'delivery',
  closed: 'closed',
  paused: 'paused',
  unpaused: 'resumed',
  retried: 'retry',
  error: 'error',
};

const ATTENTION = new Set<TaskActivityKind>([
  'run_failed',
  'checks_failed',
  'delivery_failed',
  'workspace_failed',
  'error',
]);

/** The Activity tab: what happened to the task, newest first (ACE parity P0, design §8). */
export function TaskActivityFeed({ taskId }: { taskId: string }) {
  const activity = useTaskActivity(taskId);
  if (activity.isPending) return <p className="text-fg-muted">Loading activity…</p>;
  if (activity.isError) {
    return (
      <p role="alert" className="text-danger">
        Could not load the activity: {activity.error.message}
      </p>
    );
  }
  const rows = [...activity.data.items].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <ol aria-label="Activity" className="flex flex-col" data-testid="task-activity">
      {rows.map((row) => (
        <li
          key={row.id}
          data-kind={row.kind}
          className="grid grid-cols-[5.5rem_1fr_auto] items-baseline gap-3 border-b border-border py-2 last:border-b-0"
        >
          <span
            className={
              ATTENTION.has(row.kind)
                ? 'font-machine text-[10.5px] uppercase tracking-[0.08em] text-danger'
                : 'font-machine text-[10.5px] uppercase tracking-[0.08em] text-fg-muted'
            }
          >
            {KIND_LABEL[row.kind]}
          </span>
          <span className="font-human text-sm">
            {row.message}
            {row.runId !== undefined && (
              <>
                {' '}
                <Link to={`/runs/${row.runId}`} className="font-machine text-[11px] underline">
                  run
                </Link>
              </>
            )}
          </span>
          <time dateTime={row.at} className="font-machine text-[10.5px] text-fg-muted">
            {timeAgo(row.at)}
          </time>
        </li>
      ))}
    </ol>
  );
}
