import { cn } from '@ace/ui';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useWorkflowMode, workflowPath } from '../mode';
import { CheckpointFiles, ROW_ACTION } from './CheckpointFiles';
import { useCheckpoint, useCheckpointAction, useCheckpointEvents } from './hooks';
import { COVERAGE_NOTE, STATUS_LABEL, actionFailure, failureNote, pendingFiles } from './present';
import { openReview } from './review-actions';
import { RevertAllDialog } from './RevertAllDialog';

/**
 * The Changes card under a chat turn that wrote files (D300, design §5.3): the files with `+/−`,
 * Review, Keep all and Revert all — which asks first (fix A-M9). Review opens the diff in Forge —
 * switching to it from Ideate or Domain. A checkpoint that could not be taken says the changes
 * cannot be reverted (§10); one that is decided says how. Live from `checkpoint.updated`. Needs a
 * router (the chat column has one).
 */
export function ChangesCard({
  projectId,
  checkpointId,
}: {
  projectId: string;
  checkpointId: string;
}) {
  useCheckpointEvents(projectId);
  const query = useCheckpoint(projectId, checkpointId);
  const action = useCheckpointAction(projectId, checkpointId);
  const navigate = useNavigate();
  const mode = useWorkflowMode();
  const { workflowId } = useParams();
  const checkpoint = query.data;
  const [confirmRevert, setConfirmRevert] = useState(false);

  const review = (path: string): void => {
    openReview(projectId, checkpointId, path);
    if (mode !== 'forge' && workflowId !== undefined) {
      navigate(workflowPath(projectId, workflowId, 'forge'));
    }
  };

  const shell =
    'flex max-w-[520px] flex-col gap-[4px] rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-[10px] py-[8px]';
  if (checkpoint === undefined) {
    if (query.error === null) return null;
    return (
      <div className={shell} data-testid={`changes-card-${checkpointId}`}>
        <p className="m-0 text-[11.5px] text-[var(--muted)]">
          The changes from this turn can’t be shown: {actionFailure(query.error)}
        </p>
      </div>
    );
  }
  const pending = pendingFiles(checkpoint);
  const count = checkpoint.files.length;
  const failure = actionFailure(action.error);

  return (
    <section aria-label="Changes" data-testid={`changes-card-${checkpointId}`} className={shell}>
      <header className="flex items-center gap-[6px]">
        <span className="font-machine text-[10px] tracking-[0.1em] text-[var(--muted)]">
          CHANGES
        </span>
        {count > 0 && (
          <span className="text-[11.5px] text-[var(--muted)]">
            {count} file{count === 1 ? '' : 's'}
          </span>
        )}
        <span className="flex-1" />
        <span className="font-machine text-[9.5px] text-[var(--muted)]">
          {STATUS_LABEL[checkpoint.status]}
        </span>
      </header>
      {checkpoint.status === 'failed' && (
        <p role="alert" className="m-0 text-[11.5px] leading-[1.4] text-[#c94c27]">
          {failureNote(checkpoint)}
        </p>
      )}
      {count > 0 && (
        <CheckpointFiles checkpoint={checkpoint} busy={action.isPending} onReview={review} />
      )}
      {failure !== undefined && (
        <p role="alert" className="m-0 text-[11px] text-[#c94c27]">
          {failure}
        </p>
      )}
      {pending.length > 0 && (
        <footer className="flex items-center gap-[2px] pt-[2px]">
          <button
            type="button"
            onClick={() => review(pending[0]?.path ?? '')}
            className={cn(ROW_ACTION, 'text-[var(--ink)]')}
          >
            Review
          </button>
          <span className="flex-1" />
          <button
            type="button"
            disabled={action.isPending}
            onClick={() => action.mutate({ action: 'keep' })}
            className={ROW_ACTION}
          >
            Keep all
          </button>
          <button
            type="button"
            disabled={action.isPending}
            onClick={() => setConfirmRevert(true)}
            className={cn(ROW_ACTION, 'text-[#c94c27] hover:text-[#c94c27]')}
          >
            Revert all
          </button>
        </footer>
      )}
      {confirmRevert && pending.length > 0 && (
        <RevertAllDialog
          files={pending}
          onConfirm={() => action.mutate({ action: 'revert' })}
          onClose={() => setConfirmRevert(false)}
        />
      )}
      {(checkpoint.skipped.length > 0 || pending.length > 0) && (
        <p
          className="m-0 text-[10.5px] text-[var(--muted)]"
          title={checkpoint.skipped.length > 0 ? checkpoint.skipped.join('\n') : undefined}
        >
          {checkpoint.skipped.length > 0
            ? `${checkpoint.skipped.length} file${checkpoint.skipped.length === 1 ? '' : 's'} over 5 MB not checkpointed. `
            : ''}
          {COVERAGE_NOTE}
        </p>
      )}
    </section>
  );
}
