import {
  MERGE_METHODS,
  TASK_NOTE_MAX,
  type MergeMethod,
  type Task,
  type TaskCheck,
  type TaskDelivery,
  type TaskReview,
  type TaskWorkspace,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
  toast,
} from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  FileCheck2,
  GitMerge,
  GitPullRequest,
  Mail,
  TriangleAlert,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { ConfirmDialog } from '../knowledge/ConfirmDialog';
import { selectClass } from '../knowledge/fields';
import { useProject } from '../projects/hooks';
import { headChecksFailed } from './checks';
import {
  useAcceptTask,
  useApplyTask,
  useMergePullRequest,
  useOpenPullRequest,
  useRepository,
  useReviewTask,
  useSendTask,
} from './hooks';
import { taskKeys } from './keys';
import { FINISH_LINE_LABEL, MERGE_METHOD_LABEL, PULL_REQUEST_STATE_COLOR, shortSha } from './meta';

/**
 * The Review panel (ACE parity P0 design §8, P1 D275/D276): Approve, Request changes (with a note),
 * and the finish line's own action, each showing exactly where it delivers before it does —
 * Apply (the folder + branch from `GET /projects/:id/repository`), Accept (the document's file in
 * the project folder, or the email's recipients — never sent), Send (only when the engine offers
 * it; this version answers `not_connected`), or GitHub (open the pull request, then merge it into
 * the repository and base GitHub reported, repeated back as `confirm`). Failed checks on the head
 * warn and disable the code deliveries (the engine refuses them too, 409 `checks_failed`).
 */
export function ReviewPanel({
  task,
  workspace,
  checks,
  reviews,
  deliveries = [],
}: {
  task: Task;
  workspace?: TaskWorkspace;
  checks: readonly TaskCheck[];
  reviews: readonly TaskReview[];
  deliveries?: readonly TaskDelivery[];
}) {
  const allowed = new Set(task.allowedActions);
  const review = useReviewTask(task.id);
  const [note, setNote] = useState('');
  const headSha = workspace?.headSha;
  const approvedHead = reviews.some(
    (row) => row.decision === 'approved' && (headSha === undefined || row.headSha === headSha),
  );
  const checksFailed = headSha !== undefined && headChecksFailed(checks, headSha);
  const github =
    task.finishLine === 'github_merge' &&
    (allowed.has('open_pr') || allowed.has('merge_pr') || workspace?.pullRequest !== undefined);

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
        {task.type === 'app'
          ? 'Look at the changes and the checks, then approve them or say what should change.'
          : 'Read the draft on the Overview tab, edit it if you like, then accept it or say what should change.'}
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

      {allowed.has('apply') && <ApplySection task={task} checksFailed={checksFailed} />}
      {allowed.has('accept') && <AcceptSection task={task} />}
      {allowed.has('send') && <SendSection task={task} />}
      {github && (
        <GitHubSection
          task={task}
          {...(workspace === undefined ? {} : { workspace })}
          deliveries={deliveries}
          checksFailed={checksFailed}
        />
      )}
    </section>
  );
}

/** A delivery's refusal, in place: what is not connected, what GitHub said, what moved. */
function DeliveryError({ error, what }: { error: Error | null; what: string }) {
  if (error === null) return null;
  const code = AceApiError.is(error) ? error.code : undefined;
  const lead =
    code === 'not_connected'
      ? 'Not connected'
      : code === 'delivery_failed'
        ? `${what} failed`
        : code === 'destination_changed'
          ? 'The destination changed'
          : code === 'file_exists'
            ? 'The file already exists'
            : code === 'checks_failed'
              ? 'Checks failed'
              : `${what} refused`;
  return (
    <p
      role="alert"
      data-testid="delivery-error"
      data-code={code}
      className="flex items-start gap-2 text-sm text-danger"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        <strong className="font-semibold">{lead}:</strong> {error.message}
      </span>
    </p>
  );
}

function ChecksWarning({ what }: { what: string }) {
  return (
    <p
      role="alert"
      data-testid="apply-checks-failed"
      className="flex items-center gap-2 text-sm text-[var(--color-status-WAITING)]"
    >
      <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />A check failed on these changes. Fix
      it or run the checks again before {what}.
    </p>
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
      {checksFailed && <ChecksWarning what="applying" />}
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

/**
 * Accept (D275): a document is saved at its path in the project folder — never over an existing
 * file — after a confirmation that repeats the path back as `{ path }`; an email draft is accepted
 * for its recipients, and nothing is sent.
 */
function AcceptSection({ task }: { task: Task }) {
  const project = useProject(task.projectId);
  const accept = useAcceptTask(task.id);
  const [confirming, setConfirming] = useState(false);
  const deliverable = task.deliverable;
  if (deliverable === undefined) return null;
  const folder = project.data?.folderPath;

  const done = (updated: Task) => {
    setConfirming(false);
    toast.success(
      deliverable.kind === 'document'
        ? `Accepted: saved as ${deliverable.path}`
        : 'Draft accepted. It was not sent.',
    );
    return updated;
  };

  if (deliverable.kind === 'email') {
    const to = deliverable.to.join(', ');
    return (
      <div className="flex flex-col gap-2 border-t border-border pt-4" data-testid="accept-section">
        <h3 className="font-human text-sm font-semibold">Accept the draft</h3>
        <p data-testid="accept-destination" className="font-human text-sm text-fg-soft">
          {to === ''
            ? 'Accepts the draft (no recipient yet); it is not sent.'
            : `Accepts the draft to ${to}; it is not sent.`}
        </p>
        <DeliveryError error={accept.error} what="Accept" />
        <Button
          className="self-start"
          disabled={accept.isPending}
          onClick={() => accept.mutate({}, { onSuccess: done })}
        >
          <Mail className="h-4 w-4" aria-hidden /> Accept draft
        </Button>
      </div>
    );
  }

  const exists = AceApiError.is(accept.error) && accept.error.code === 'file_exists';
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4" data-testid="accept-section">
      <h3 className="font-human text-sm font-semibold">Accept the document</h3>
      <p data-testid="accept-destination" className="font-human text-sm text-fg-soft">
        Saves <code className="font-machine text-fg">{deliverable.path}</code> in{' '}
        <code className="font-machine text-fg">{folder ?? 'the project folder'}</code>; never
        overwrites an existing file.
      </p>
      <DeliveryError error={accept.error} what="Accept" />
      {exists && (
        <p className="text-xs text-fg-muted">
          Change “Save as” in the Draft on the Overview tab, save it, then accept again.
        </p>
      )}
      <Button
        className="self-start"
        disabled={accept.isPending}
        onClick={() => {
          accept.reset();
          setConfirming(true);
        }}
      >
        <FileCheck2 className="h-4 w-4" aria-hidden /> Accept document
      </Button>
      {confirming && (
        <ConfirmDialog
          title="Accept this document?"
          description="It is written into the project folder. If a file is already there, nothing is written."
          confirmLabel="Accept and save"
          variant="default"
          pending={accept.isPending}
          onClose={() => setConfirming(false)}
          onConfirm={() =>
            accept.mutate(
              { path: deliverable.path },
              { onSuccess: done, onError: () => setConfirming(false) },
            )
          }
        >
          <p
            data-testid="accept-confirm-path"
            className="rounded-field border border-border bg-sunken px-3 py-2 font-machine text-xs"
          >
            {folder === undefined ? deliverable.path : `${folder}/${deliverable.path}`}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Send (D275): offered when the finish line is Send; this version answers `not_connected`. */
function SendSection({ task }: { task: Task }) {
  const send = useSendTask(task.id);
  const to = task.deliverable?.kind === 'email' ? task.deliverable.to.join(', ') : '';
  const notConnected = AceApiError.is(send.error) && send.error.code === 'not_connected';
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4" data-testid="send-section">
      <h3 className="font-human text-sm font-semibold">Send the email</h3>
      <p className="font-human text-sm text-fg-soft">
        {to === '' ? 'Sends the email.' : `Sends the email to ${to}.`} Sending needs an email
        connection.
      </p>
      <DeliveryError error={send.error} what="Send" />
      {notConnected && (
        <p className="text-xs text-fg-muted">
          To finish without sending, accept the draft above and send it from your mail app.
        </p>
      )}
      <Button
        className="self-start"
        variant="secondary"
        disabled={send.isPending}
        onClick={() => send.mutate(undefined)}
      >
        <Mail className="h-4 w-4" aria-hidden /> Send email
      </Button>
    </div>
  );
}

/**
 * GitHub (D276): open the pull request (optional title, description, draft), then — while it is
 * open — merge it with a method, after a confirmation that shows and sends back the repository and
 * base GitHub reported. A merge GitHub did not confirm stays in review as `uncertain`.
 */
function GitHubSection({
  task,
  workspace,
  deliveries,
  checksFailed,
}: {
  task: Task;
  workspace?: TaskWorkspace;
  deliveries: readonly TaskDelivery[];
  checksFailed: boolean;
}) {
  const allowed = new Set(task.allowedActions);
  const open = useOpenPullRequest(task.id);
  const merge = useMergePullRequest(task.id);
  const [opening, setOpening] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [method, setMethod] = useState<MergeMethod>('squash');
  const pr = workspace?.pullRequest;
  const lastMerge = deliveries.filter((row) => row.kind === 'github_merge').at(-1);
  const uncertain = lastMerge?.status === 'uncertain' && pr?.state !== 'merged';

  const confirmMerge = () => {
    if (pr === undefined) return;
    merge.mutate(
      { method, confirm: { repo: pr.repo, base: pr.base } },
      {
        onSuccess: (updated) => {
          setConfirming(false);
          if (updated.stage === 'done') toast.success(`Merged #${pr.number} on GitHub`);
          else if (updated.state === 'failed') {
            toast.error('Merge failed', { description: updated.stateReason });
          } else toast.warning('GitHub has not confirmed the merge');
        },
        onError: () => setConfirming(false),
      },
    );
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4" data-testid="github-section">
      <h3 className="font-human text-sm font-semibold">Merge on GitHub</h3>
      {pr === undefined ? (
        <p className="font-human text-sm text-fg-soft">
          Pushes the task branch
          {workspace === undefined ? '' : ` ${workspace.branch}`} and opens a pull request into{' '}
          {workspace?.baseBranch ?? 'its base branch'}.
        </p>
      ) : (
        <div
          className="flex flex-wrap items-center gap-2 font-human text-sm"
          data-testid="pull-request"
        >
          <GitPullRequest className="h-4 w-4 text-fg-muted" aria-hidden />
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2"
          >
            Pull request #{pr.number} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
          <Badge
            data-testid="pull-request-state"
            style={{
              color: PULL_REQUEST_STATE_COLOR[pr.state],
              borderColor: `color-mix(in oklab, ${PULL_REQUEST_STATE_COLOR[pr.state]} 45%, var(--color-border))`,
            }}
          >
            {pr.state}
          </Badge>
          <span className="text-fg-muted">
            into{' '}
            <code className="font-machine text-fg">
              {pr.repo} @ {pr.base}
            </code>
          </span>
        </div>
      )}
      {uncertain && (
        <p
          role="status"
          data-testid="merge-uncertain"
          className="flex items-start gap-2 text-sm text-[var(--color-status-WAITING)]"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            GitHub has not confirmed the merge{lastMerge?.detail ? ` (${lastMerge.detail})` : ''}.
            The task stays in review: check the pull request on GitHub, then try Merge again.
          </span>
        </p>
      )}
      {checksFailed && <ChecksWarning what="delivering to GitHub" />}
      <DeliveryError error={open.error} what="Opening the pull request" />
      <DeliveryError error={merge.error} what="Merge" />

      {allowed.has('open_pr') && (
        <Button
          className="self-start"
          disabled={checksFailed || open.isPending}
          onClick={() => {
            open.reset();
            setOpening(true);
          }}
        >
          <GitPullRequest className="h-4 w-4" aria-hidden /> Open pull request
        </Button>
      )}

      {allowed.has('merge_pr') && pr !== undefined && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`merge-method-${task.id}`}>Merge method</Label>
            <select
              id={`merge-method-${task.id}`}
              className={selectClass}
              value={method}
              onChange={(event) => setMethod(event.target.value as MergeMethod)}
            >
              {MERGE_METHODS.map((each) => (
                <option key={each} value={each}>
                  {MERGE_METHOD_LABEL[each]}
                </option>
              ))}
            </select>
          </div>
          <Button
            disabled={checksFailed || merge.isPending}
            onClick={() => {
              merge.reset();
              setConfirming(true);
            }}
          >
            <GitMerge className="h-4 w-4" aria-hidden /> Merge on GitHub
          </Button>
        </div>
      )}

      {opening && (
        <OpenPullRequestDialog
          task={task}
          pending={open.isPending}
          onClose={() => setOpening(false)}
          onOpen={(body) =>
            open.mutate(body, {
              onSuccess: (updated) => {
                setOpening(false);
                if (updated.state === 'failed') {
                  toast.error('Pull request not opened', { description: updated.stateReason });
                } else toast.success('Pull request opened');
              },
              onError: () => setOpening(false),
            })
          }
        />
      )}

      {confirming && pr !== undefined && (
        <ConfirmDialog
          title={`Merge pull request #${pr.number}?`}
          description="GitHub merges it into the branch below. The task is Merged only once GitHub confirms it."
          confirmLabel="Merge on GitHub"
          variant="default"
          pending={merge.isPending}
          onConfirm={confirmMerge}
          onClose={() => setConfirming(false)}
        >
          <div className="flex flex-col gap-1">
            <p
              data-testid="merge-destination"
              className="rounded-field border border-border bg-sunken px-3 py-2 font-machine text-xs"
            >
              {pr.repo} @ {pr.base}
            </p>
            <p className="text-xs text-fg-muted">{MERGE_METHOD_LABEL[method]}</p>
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

function OpenPullRequestDialog({
  task,
  pending,
  onOpen,
  onClose,
}: {
  task: Task;
  pending: boolean;
  onOpen: (body: { title?: string; body?: string; draft: boolean }) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onOpen({
      ...(title.trim() === '' ? {} : { title: title.trim() }),
      ...(body.trim() === '' ? {} : { body }),
      draft,
    });
  };
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Open a pull request</DialogTitle>
            <DialogDescription>
              The task branch is pushed and a pull request is opened on GitHub. Leave the fields
              empty to use the task’s title and brief.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`pr-title-${task.id}`}>Title (optional)</Label>
            <Input
              id={`pr-title-${task.id}`}
              value={title}
              maxLength={256}
              placeholder={task.title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`pr-body-${task.id}`}>Description (optional)</Label>
            <Textarea
              id={`pr-body-${task.id}`}
              rows={5}
              value={body}
              maxLength={60_000}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`pr-draft-${task.id}`}
              checked={draft}
              onCheckedChange={(checked) => setDraft(checked === true)}
            />
            <Label htmlFor={`pr-draft-${task.id}`}>Open it as a draft</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Open pull request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
