import {
  TASK_NOTE_MAX,
  type Task,
  type TaskCheck,
  type TaskReview,
  type TaskWorkspace,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { Button, Label, Textarea, toast } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { GitMerge, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { ConfirmDialog } from '../knowledge/ConfirmDialog';
import { headChecksFailed } from './checks';
import { useApplyTask, useRepository, useReviewTask } from './hooks';
import { taskKeys } from './keys';
import { FINISH_LINE_LABEL, shortSha } from './meta';

/**
 * The Review panel (ACE parity P0, design §8): Approve, Request changes (with a note), and — when
 * the finish line is Apply — the destination the engine will merge into, read from
 * `GET /projects/:id/repository` and sent back exactly as shown, after a confirmation. Failed checks
 * on the head disable Apply (the engine refuses it too, 409 `checks_failed`).
 */
export function ReviewPanel({
  task,
  workspace,
  checks,
  reviews,
}: {
  task: Task;
  workspace?: TaskWorkspace;
  checks: readonly TaskCheck[];
  reviews: readonly TaskReview[];
}) {
  const allowed = new Set(task.allowedActions);
  const review = useReviewTask(task.id);
  const [note, setNote] = useState('');
  const headSha = workspace?.headSha;
  const approvedHead = reviews.some(
    (row) => row.decision === 'approved' && (headSha === undefined || row.headSha === headSha),
  );

  const decide = (decision: 'approved' | 'changes_requested') =>
    review.mutate(
      {
        decision,
        ...(decision === 'changes_requested' ? { note: note.trim() } : {}),
        ...(headSha === undefined ? {} : { headSha }),
      },
      {
        onSuccess: (updated) => {
          if (decision === 'changes_requested') setNote('');
          toast.success(
            decision === 'approved'
              ? updated.stage === 'done'
                ? 'Approved: the task is done'
                : 'Approved'
              : 'Changes requested',
          );
        },
        onError: (error) => toast.error('Review not recorded', { description: error.message }),
      },
    );

  return (
    <section
      aria-labelledby={`review-${task.id}`}
      data-testid="review-panel"
      className="flex flex-col gap-4 rounded-card border border-border-strong bg-panel p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`review-${task.id}`} className="font-human text-lg font-semibold">
          Review
        </h2>
        <span className="font-machine text-[11px] text-fg-muted">
          Finish line: {FINISH_LINE_LABEL[task.finishLine]}
        </span>
      </div>
      <p className="font-human text-sm text-fg-soft">
        Look at the changes and the checks, then approve them or say what should change.
        {headSha !== undefined && (
          <>
            {' '}
            You are reviewing <code className="font-machine">{shortSha(headSha)}</code>.
          </>
        )}
      </p>
      {approvedHead && task.stage === 'review' && (
        <p role="status" className="font-human text-sm text-[var(--color-status-COMPLETED)]">
          Approved{headSha === undefined ? '' : ` at ${shortSha(headSha)}`}.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {allowed.has('approve') && (
          <Button onClick={() => decide('approved')} disabled={review.isPending}>
            Approve
          </Button>
        )}
      </div>

      {allowed.has('request_changes') && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`review-note-${task.id}`}>What should change</Label>
          <Textarea
            id={`review-note-${task.id}`}
            rows={3}
            value={note}
            maxLength={TASK_NOTE_MAX}
            placeholder="The team gets this as the request of its next work run."
            onChange={(event) => setNote(event.target.value)}
          />
          <Button
            variant="secondary"
            className="self-start"
            disabled={note.trim() === '' || review.isPending}
            onClick={() => decide('changes_requested')}
          >
            Request changes
          </Button>
        </div>
      )}

      {allowed.has('apply') && (
        <ApplySection
          task={task}
          checksFailed={headSha !== undefined && headChecksFailed(checks, headSha)}
        />
      )}
    </section>
  );
}

function ApplySection({ task, checksFailed }: { task: Task; checksFailed: boolean }) {
  const queryClient = useQueryClient();
  const repository = useRepository(task.projectId);
  const apply = useApplyTask(task.id);
  const [confirming, setConfirming] = useState(false);

  const info = repository.data;
  const destination =
    info?.isRepo === true && typeof info.branch === 'string'
      ? { folderPath: info.folderPath, branch: info.branch }
      : undefined;

  const confirm = () => {
    if (destination === undefined) return;
    apply.mutate(
      { destination },
      {
        onSuccess: (updated) => {
          setConfirming(false);
          if (updated.state === 'failed') {
            toast.error('Apply failed', { description: updated.stateReason });
          } else {
            toast.success(`Applied to ${destination.folderPath} @ ${destination.branch}`);
          }
        },
        onError: (error) => {
          setConfirming(false);
          // the repository moved under us: show where it is now before anyone confirms again
          if (AceApiError.is(error) && error.code === 'destination_changed') {
            void queryClient.invalidateQueries({ queryKey: taskKeys.repository(task.projectId) });
          }
          toast.error('Not applied', { description: error.message });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4" data-testid="apply-section">
      <h3 className="font-human text-sm font-semibold">Apply changes locally</h3>
      {repository.isPending && <p className="text-sm text-fg-muted">Reading the repository…</p>}
      {repository.isError && (
        <p role="alert" className="text-sm text-danger">
          Could not read the repository: {repository.error.message}
        </p>
      )}
      {info !== undefined && destination === undefined && (
        <p role="alert" className="text-sm text-danger">
          The project folder is not a Git repository on a branch, so there is nowhere to apply to.
        </p>
      )}
      {destination !== undefined && (
        <p className="font-human text-sm text-fg-soft">
          Merges the task branch into{' '}
          <code data-testid="apply-destination" className="font-machine text-fg">
            {destination.folderPath} @ {destination.branch}
          </code>
          .
        </p>
      )}
      {checksFailed && (
        <p
          role="alert"
          data-testid="apply-checks-failed"
          className="flex items-center gap-2 text-sm text-[var(--color-status-WAITING)]"
        >
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />A check failed on these changes.
          Fix it or run the checks again before applying.
        </p>
      )}
      <Button
        className="self-start"
        disabled={destination === undefined || checksFailed || apply.isPending}
        onClick={() => setConfirming(true)}
      >
        <GitMerge className="h-4 w-4" aria-hidden /> Apply
      </Button>

      {confirming && destination !== undefined && (
        <ConfirmDialog
          title="Apply these changes?"
          description="The task branch is merged into the project folder's current branch. Check that this is where you want it."
          confirmLabel="Apply"
          variant="default"
          pending={apply.isPending}
          onConfirm={confirm}
          onClose={() => setConfirming(false)}
        >
          <p className="rounded-field border border-border bg-sunken px-3 py-2 font-machine text-xs">
            {destination.folderPath} @ {destination.branch}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
