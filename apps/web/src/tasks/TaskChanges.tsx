import type { Task, TaskWorkspace } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { cn } from '@ace/ui';
import { GitBranch } from 'lucide-react';
import { useState } from 'react';

import { DiffView } from './DiffView';
import { useTaskChanges, useTaskFileDiff } from './hooks';
import { CHANGE_LETTER, shortSha } from './meta';

/**
 * The Changes tab (ACE parity P0, design §8): the task branch against the commit it started from —
 * the range, the totals, every changed file with its + and −, and one file's unified diff at a time.
 * While a run is going the worktree may hold changes no commit has yet; the tab says so.
 */
export function TaskChanges({ task, workspace }: { task: Task; workspace?: TaskWorkspace }) {
  const changes = useTaskChanges(task.id, workspace !== undefined);
  const [selected, setSelected] = useState<string>();

  const noWorkspace =
    workspace === undefined ||
    (changes.isError && AceApiError.is(changes.error) && changes.error.code === 'no_workspace');
  if (noWorkspace) {
    return (
      <p data-testid="changes-empty" className="font-human text-sm text-fg-muted">
        No workspace yet. The task gets its own branch when its first plan or work run starts, and
        its changes show up here.
      </p>
    );
  }
  if (changes.isPending) return <p className="text-fg-muted">Loading changes…</p>;
  if (changes.isError) {
    return (
      <p role="alert" className="text-danger">
        Could not load the changes: {changes.error.message}
      </p>
    );
  }

  const data = changes.data;
  return (
    <div className="flex flex-col gap-4" data-testid="task-changes">
      <div className="flex flex-col gap-1">
        <p
          data-testid="changes-range"
          className="flex flex-wrap items-center gap-1.5 font-machine text-[11.5px] text-fg-soft"
        >
          <GitBranch className="h-3.5 w-3.5" aria-hidden />
          {data.baseBranch} @ {shortSha(data.baseSha)} → {shortSha(data.headSha)} ({data.branch})
        </p>
        <p data-testid="changes-totals" className="font-machine text-[11px] text-fg-muted">
          {data.totals.files} {data.totals.files === 1 ? 'file' : 'files'} ·{' '}
          <span className="text-[var(--color-status-COMPLETED)]">+{data.totals.additions}</span>{' '}
          <span className="text-[var(--color-status-FAILED)]">−{data.totals.deletions}</span>
        </p>
        {data.uncommitted && (
          <p
            role="status"
            data-testid="changes-uncommitted"
            className="font-human text-xs text-[var(--color-status-WAITING)]"
          >
            Uncommitted changes — the run is still going, so this is work in progress.
          </p>
        )}
      </div>

      {data.files.length === 0 ? (
        <p className="font-human text-sm text-fg-muted">No files changed yet.</p>
      ) : (
        <ul
          aria-label="Changed files"
          className="flex flex-col divide-y divide-border rounded-field border border-border"
        >
          {data.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                aria-pressed={selected === file.path}
                onClick={() => setSelected(file.path)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left font-machine text-[11.5px] hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection',
                  selected === file.path && 'bg-card',
                )}
              >
                <span
                  title={file.status}
                  aria-label={file.status}
                  className="w-4 shrink-0 text-center text-fg-soft"
                >
                  {CHANGE_LETTER[file.status]}
                </span>
                <span className="min-w-0 flex-1 truncate text-fg">
                  {file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path}
                </span>
                {file.binary ? (
                  <span className="text-fg-muted">binary</span>
                ) : (
                  <span className="shrink-0">
                    <span className="text-[var(--color-status-COMPLETED)]">+{file.additions}</span>{' '}
                    <span className="text-[var(--color-status-FAILED)]">−{file.deletions}</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected === undefined ? (
        data.files.length > 0 && (
          <p className="font-human text-xs text-fg-muted">Pick a file to see its diff.</p>
        )
      ) : (
        <FileDiff taskId={task.id} path={selected} />
      )}
    </div>
  );
}

function FileDiff({ taskId, path }: { taskId: string; path: string }) {
  const diff = useTaskFileDiff(taskId, path);
  if (diff.isPending) return <p className="text-fg-muted">Loading the diff…</p>;
  if (diff.isError) {
    return (
      <p role="alert" className="text-danger">
        Could not load the diff of {path}: {diff.error.message}
      </p>
    );
  }
  return (
    <DiffView
      path={diff.data.path}
      patch={diff.data.patch}
      binary={diff.data.binary}
      truncated={diff.data.truncated}
    />
  );
}
