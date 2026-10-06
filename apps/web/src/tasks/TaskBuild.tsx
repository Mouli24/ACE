import { TASK_NOTE_MAX, type Task, type TaskExecution } from '@ace/contracts';
import { Badge, Button, Label, Markdown, Textarea, toast } from '@ace/ui';
import { GitCommitHorizontal } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { useWorkTask } from './hooks';
import { EXECUTION_STATUS_COLOR, shortSha, timeAgo } from './meta';

/**
 * The Build tab (ACE parity P0, design §8): the runs the task made, newest first — kind, sequence,
 * status, the run itself, the team's summary and the commit it was recorded in — and a follow-up
 * composer that starts another work run with the message, when work may start.
 */
export function TaskBuild({
  task,
  executions,
}: {
  task: Task;
  executions: readonly TaskExecution[];
}) {
  const work = useWorkTask(task.id);
  const [message, setMessage] = useState('');
  const canWork = task.allowedActions.includes('work');
  const ordered = [...executions].sort((a, b) => b.sequence - a.sequence);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (text === '') return;
    work.mutate(
      { message: text },
      {
        onSuccess: () => {
          setMessage('');
          toast.success('Follow-up sent to the team');
        },
        onError: (error) => toast.error('Follow-up not sent', { description: error.message }),
      },
    );
  };

  return (
    <div className="flex flex-col gap-5" data-testid="task-build">
      <form onSubmit={send} className="flex flex-col gap-2 rounded-card border border-border p-3">
        <Label htmlFor={`follow-up-${task.id}`}>Follow-up for the team</Label>
        <Textarea
          id={`follow-up-${task.id}`}
          rows={3}
          value={message}
          maxLength={TASK_NOTE_MAX}
          disabled={!canWork}
          placeholder={
            canWork
              ? 'What should change next? It starts another work run in the same branch.'
              : 'A follow-up can be sent once the task is not running and has a team.'
          }
          onChange={(event) => setMessage(event.target.value)}
        />
        {task.pendingRequest !== undefined && (
          <p className="text-xs text-fg-muted" data-testid="pending-request">
            Waiting to be sent: “{task.pendingRequest}”
          </p>
        )}
        <Button
          type="submit"
          size="sm"
          className="self-end"
          disabled={!canWork || message.trim() === '' || work.isPending}
        >
          Send follow-up
        </Button>
      </form>

      {ordered.length === 0 ? (
        <p className="font-human text-sm text-fg-muted">
          No runs yet. Start planning or work, and each run of the team shows up here.
        </p>
      ) : (
        <ol aria-label="Runs of this task" className="flex flex-col gap-3">
          {ordered.map((execution) => (
            <li
              key={execution.id}
              data-testid={`execution-${execution.sequence}`}
              className="flex flex-col gap-2 rounded-card border border-border bg-panel p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-human text-sm font-semibold">
                  {execution.kind === 'plan' ? 'Plan' : 'Work'} · run {execution.sequence}
                </span>
                <span
                  data-testid="execution-status"
                  className="font-machine text-[10.5px]"
                  style={{ color: EXECUTION_STATUS_COLOR[execution.status] }}
                >
                  {execution.status}
                </span>
                <span className="font-machine text-[10.5px] text-fg-muted">
                  {timeAgo(execution.startedAt)}
                </span>
                <div className="flex-1" />
                {execution.runId !== undefined && (
                  <Link
                    to={`/runs/${execution.runId}`}
                    className="font-machine text-[11px] text-fg-soft underline-offset-2 hover:underline"
                  >
                    Open run
                  </Link>
                )}
              </div>
              {execution.summary !== undefined && (
                <Markdown text={execution.summary} className="font-human text-sm" />
              )}
              {execution.error !== undefined && (
                <p role="alert" className="text-sm text-danger">
                  {execution.error}
                </p>
              )}
              {execution.commitSha !== undefined && (
                <p className="flex items-center gap-2 font-machine text-[11px] text-fg-muted">
                  <GitCommitHorizontal className="h-3.5 w-3.5" aria-hidden />
                  <Badge title={execution.commitSha}>{shortSha(execution.commitSha)}</Badge>
                  {execution.changedFiles !== undefined &&
                    `${execution.changedFiles} ${execution.changedFiles === 1 ? 'file' : 'files'} changed`}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
