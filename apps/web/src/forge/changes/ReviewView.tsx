import { AceApiError } from '@ace/sdk';
import { cn } from '@ace/ui';
import { Suspense, lazy } from 'react';

import { fileIconColor } from '../../theme/constants';
import { nameOf } from '../files/paths';
import { useCheckpointConflicts } from './changes-store';
import { ChangeCounts, ROW_ACTION } from './CheckpointFiles';
import {
  useCheckpoint,
  useCheckpointAction,
  useCheckpointEvents,
  useCheckpointFileDiff,
} from './hooks';
import { actionFailure, fileNote, fileStateLabel } from './present';

const ReviewDiffEditor = lazy(() =>
  import('./ReviewDiffEditor').then((module) => ({ default: module.ReviewDiffEditor })),
);

/** One muted line in the code area, as the editor's own quiet states. */
function Quiet({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center px-[16px] text-center text-[13px] text-[var(--muted)]">
      {children}
    </div>
  );
}

const CHANGE_WORD = { added: 'created', modified: 'changed', deleted: 'deleted' } as const;

/**
 * A "<file> (agent change)" tab's body (D300 §5.3): a bar with the file, what the agent did, its
 * `+/−` and — while it waits — Keep and Revert; then the read-only diff, before on the left and
 * after on the right. A binary file has no text diff and says so.
 */
export function ReviewView({
  projectId,
  checkpointId,
  path,
}: {
  projectId: string;
  checkpointId: string;
  path: string;
}) {
  useCheckpointEvents(projectId);
  const checkpoint = useCheckpoint(projectId, checkpointId);
  const diff = useCheckpointFileDiff(projectId, checkpointId, path);
  const action = useCheckpointAction(projectId, checkpointId);
  const conflict = useCheckpointConflicts(checkpointId)[path];
  const file = checkpoint.data?.files.find((candidate) => candidate.path === path);
  const failure = actionFailure(action.error);
  const note = file === undefined ? undefined : fileNote(file);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="review-view"
      aria-label={`${nameOf(path)} (agent change)`}
      role="region"
    >
      <div className="flex min-h-[32px] shrink-0 flex-wrap items-center gap-[8px] border-b border-[var(--line)] bg-[var(--panel)] px-[14px] py-[4px] text-[12px]">
        <span
          aria-hidden
          className="h-[7px] w-[7px] shrink-0 rounded-full"
          style={{ background: fileIconColor(path) }}
        />
        <span className="min-w-0 truncate font-medium text-[var(--ink)]" title={path}>
          {path}
        </span>
        {file !== undefined && (
          <>
            <span className="font-machine text-[9.5px] text-[var(--muted)]">
              agent {CHANGE_WORD[file.change]}
            </span>
            <ChangeCounts file={file} />
          </>
        )}
        <span className="flex-1" />
        {file?.state === 'pending' ? (
          <>
            <button
              type="button"
              disabled={action.isPending}
              onClick={() => action.mutate({ action: 'keep', paths: [path] })}
              className={ROW_ACTION}
            >
              Keep
            </button>
            <button
              type="button"
              disabled={action.isPending}
              onClick={() => action.mutate({ action: 'revert', paths: [path] })}
              className={cn(ROW_ACTION, 'text-[#c94c27] hover:text-[#c94c27]')}
            >
              Revert
            </button>
          </>
        ) : (
          file !== undefined && (
            <span className="font-machine text-[9.5px] text-[var(--muted)]">
              {fileStateLabel(file)}
            </span>
          )
        )}
      </div>
      {note !== undefined && (
        <p className="m-0 shrink-0 border-b border-[var(--line)] px-[14px] py-[6px] text-[12px] text-[var(--muted)]">
          {note}
        </p>
      )}
      {(conflict !== undefined || failure !== undefined) && (
        <p
          role="alert"
          className="m-0 shrink-0 border-b border-[var(--line)] px-[14px] py-[6px] text-[12px] text-[#c94c27]"
        >
          {conflict ?? failure}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {diff.isPending ? (
          <Quiet>{`Opening ${nameOf(path)}…`}</Quiet>
        ) : diff.error ? (
          <Quiet>
            {AceApiError.is(diff.error) || diff.error instanceof Error
              ? diff.error.message
              : 'The change could not be read.'}
          </Quiet>
        ) : diff.data.binary ? (
          <Quiet>This file is binary, or over 2 MB: there is no text diff to show.</Quiet>
        ) : (
          <Suspense fallback={<Quiet>Loading the editor…</Quiet>}>
            <ReviewDiffEditor
              path={path}
              before={diff.data.before ?? ''}
              after={diff.data.after ?? ''}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
