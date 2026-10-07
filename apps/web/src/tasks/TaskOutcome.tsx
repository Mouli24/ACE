import type { Task, TaskDelivery, DeliveryKind, TaskWorkspace } from '@ace/contracts';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';

import { OUTCOME_LABEL, formatWhen, shortSha } from './meta';

/** Which delivery certifies each outcome that has one. */
const DELIVERY_OF: Partial<Record<NonNullable<Task['outcome']>, readonly DeliveryKind[]>> = {
  applied: ['apply_local'],
  merged: ['github_merge'],
  accepted: ['document_accept', 'email_accept'],
  sent: ['email_send'],
};

/**
 * How a Done task got there, with its delivery (ACE parity P1): applied to which folder and
 * branch, merged on GitHub (with the pull request), accepted as which file or for whom — or, for a
 * close, that nothing certifies the finish line.
 */
export function TaskOutcome({
  task,
  deliveries,
  workspace,
}: {
  task: Task;
  deliveries: readonly TaskDelivery[];
  workspace?: TaskWorkspace;
}) {
  const outcome = task.outcome;
  if (task.stage !== 'done' || outcome === undefined) return null;
  const kinds = DELIVERY_OF[outcome] ?? [];
  const delivery = deliveries
    .filter((row) => row.status === 'succeeded' && kinds.includes(row.kind))
    .at(-1);
  const pr = workspace?.pullRequest;

  let line: ReactNode;
  switch (outcome) {
    case 'applied':
      line = (
        <>
          Applied to <Code>{delivery?.destination ?? 'the project folder'}</Code>
          {delivery?.sha !== undefined && (
            <>
              {' '}
              as <Code>{shortSha(delivery.sha)}</Code>
            </>
          )}
          .
        </>
      );
      break;
    case 'merged': {
      const url = delivery?.url ?? pr?.url;
      line = (
        <>
          Merged on GitHub
          {pr !== undefined && (
            <>
              {' '}
              into <Code>{`${pr.repo} @ ${pr.base}`}</Code>
            </>
          )}
          {url !== undefined && (
            <>
              {' · '}
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                {pr === undefined ? 'Pull request' : `Pull request #${pr.number}`}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </>
          )}
          .
        </>
      );
      break;
    }
    case 'accepted':
      line =
        task.deliverable?.kind === 'document' ? (
          <>
            Accepted as <Code>{task.deliverable.path}</Code>
            {delivery !== undefined && (
              <>
                {' '}
                (<Code>{delivery.destination}</Code>)
              </>
            )}
            .
          </>
        ) : (
          <>Draft accepted for {delivery?.destination ?? 'its recipients'}. It was not sent.</>
        );
      break;
    case 'reviewed':
      line = 'Approved in review: the finish line is reached.';
      break;
    case 'sent':
      line = `Sent to ${delivery?.destination ?? 'its recipients'}.`;
      break;
    case 'closed_unverified':
      line = 'Closed without verification: nothing certifies that the finish line was reached.';
      break;
    case 'cancelled':
      line = 'Cancelled.';
      break;
  }

  return (
    <section
      data-testid="task-delivered"
      data-outcome={outcome}
      className="flex flex-col gap-1 rounded-card border border-border bg-panel p-4"
    >
      <h2 className="font-human text-base font-semibold">{OUTCOME_LABEL[outcome]}</h2>
      <p className="font-human text-sm text-fg-soft">{line}</p>
      {task.completedAt !== undefined && (
        <p className="font-machine text-[10.5px] text-fg-muted">{formatWhen(task.completedAt)}</p>
      )}
    </section>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="break-all font-machine text-xs text-fg">{children}</code>;
}
