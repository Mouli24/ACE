import type { Task, TaskPreview as Preview } from '@ace/contracts';
import { Badge, Button, CodeBlock, toast } from '@ace/ui';
import { ExternalLink, Play, Square } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useStartPreview, useStopPreview, useTask } from './hooks';
import { PREVIEW_STATUS_COLOR, timeAgo } from './meta';

/** How often a running preview's status and output are read again: no frame announces them. */
const PREVIEW_POLL_MS = 2_000;

/**
 * The Preview tab (ACE parity P1, D278): the project's preview command, run in the task's worktree
 * on a port the engine picks. Start/Stop, the status, the URL to open (in a new tab — and embedded
 * below while it runs, if the app lets itself be framed), and the tail of its output.
 */
export function TaskPreview({ task, preview }: { task: Task; preview?: Preview }) {
  const start = useStartPreview(task.id);
  const stop = useStopPreview(task.id);
  const running = preview?.status === 'running' || preview?.status === 'starting';
  // follow the process while it runs; the detail is the only place its output is read
  useTask(task.id, { refetchInterval: running ? PREVIEW_POLL_MS : false });
  const canStart = task.allowedActions.includes('preview') && !running;
  const color = preview === undefined ? undefined : PREVIEW_STATUS_COLOR[preview.status];

  return (
    <div className="flex flex-col gap-4" data-testid="task-preview">
      <p className="font-human text-sm text-fg-soft">
        Runs the project’s preview command in this task’s workspace, so you can try the app as the
        team left it.{' '}
        <Link to={`/projects/${task.projectId}/settings`} className="underline underline-offset-2">
          Preview settings
        </Link>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {canStart && (
          <Button
            size="sm"
            disabled={start.isPending}
            onClick={() =>
              start.mutate(undefined, {
                onError: (error) =>
                  toast.error('Preview not started', { description: error.message }),
              })
            }
          >
            <Play className="h-3.5 w-3.5" aria-hidden />{' '}
            {preview === undefined ? 'Start preview' : 'Start again'}
          </Button>
        )}
        {running && (
          <Button
            size="sm"
            variant="secondary"
            disabled={stop.isPending}
            onClick={() =>
              stop.mutate(undefined, {
                onError: (error) =>
                  toast.error('Preview not stopped', { description: error.message }),
              })
            }
          >
            <Square className="h-3.5 w-3.5" aria-hidden /> Stop preview
          </Button>
        )}
        {preview !== undefined && color !== undefined && (
          <Badge
            data-testid="preview-status"
            data-status={preview.status}
            style={{ color, borderColor: `color-mix(in oklab, ${color} 45%, var(--color-border))` }}
          >
            {preview.status}
            {preview.exitCode !== undefined ? ` · exit ${preview.exitCode}` : ''}
          </Badge>
        )}
        {preview?.startedAt !== undefined && (
          <span className="font-machine text-[10.5px] text-fg-muted">
            started {timeAgo(preview.startedAt)}
          </span>
        )}
      </div>

      {start.error && (
        <p role="alert" className="text-sm text-danger">
          Preview not started: {start.error.message}
        </p>
      )}

      {preview === undefined ? (
        <p data-testid="preview-empty" className="font-human text-sm text-fg-muted">
          No preview yet. Start one to run the project’s preview command here.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-2 font-machine text-xs sm:grid-cols-2">
            <div>
              <dt className="text-[10px] uppercase tracking-[0.1em] text-fg-muted">Command</dt>
              <dd className="break-all text-fg">{preview.command}</dd>
            </div>
            {preview.url !== undefined && (
              <div>
                <dt className="text-[10px] uppercase tracking-[0.1em] text-fg-muted">Address</dt>
                <dd>
                  <a
                    href={preview.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-human text-sm underline underline-offset-2"
                  >
                    Open preview <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>{' '}
                  <span className="text-fg-muted">{preview.url}</span>
                </dd>
              </div>
            )}
          </dl>

          {running && preview.url !== undefined && (
            <div className="flex flex-col gap-1.5">
              <iframe
                title={`Preview of task #${task.number}`}
                src={preview.url}
                className="h-[420px] w-full rounded-field border border-border bg-canvas"
              />
              <p className="text-xs text-fg-muted">
                If this stays blank, the app’s own headers may forbid being shown inside another
                page — use Open preview instead.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <h3 className="font-human text-sm font-semibold">Output</h3>
            <CodeBlock language="text" text={preview.output || '(no output yet)'} />
          </div>
        </>
      )}
    </div>
  );
}
