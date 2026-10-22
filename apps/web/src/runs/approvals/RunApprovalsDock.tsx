import type { Id } from '@ace/contracts';
import { cn } from '@ace/ui';

import { useApprovals } from '../hooks';
import { ApprovalStack } from './ApprovalStack';

/**
 * PG-3.5: a WAITING node's approval is answerable from every mode. Ideate anchors each card to its
 * node on the Canvas; Domain and Forge have no Canvas, so the run's pending approvals sit here —
 * the same `ApprovalStack`, the same `GET /runs/:id/approvals`, refetched as the approval frames
 * land (BR-01). Nothing renders while nothing waits.
 *
 * `revision` lets a screen whose frames do not reach the run overlay (Domain's own stream) ask
 * again when its conversation moves.
 */
export function RunApprovalsDock({
  runId,
  revision,
  floating = false,
  hideCommands = false,
  className,
}: {
  runId: Id | undefined;
  revision?: number;
  /** Over the page, bottom right (Forge); otherwise in the flow (Domain). */
  floating?: boolean;
  /** Command approvals are pinned elsewhere (Forge's Terminal panel), so they are not repeated. */
  hideCommands?: boolean;
  className?: string;
}) {
  const approvals = useApprovals(runId, revision);
  const requests = (approvals.data ?? []).filter(
    (request) => !(hideCommands && request.command !== undefined),
  );
  if (runId === undefined || requests.length === 0) return null;
  return (
    <section
      aria-label="Waiting on you"
      data-testid="run-approvals-dock"
      className={cn(
        'flex flex-col gap-[8px]',
        floating &&
          'fixed bottom-[36px] right-4 z-40 max-h-[60vh] w-[min(420px,calc(100vw-32px))] overflow-y-auto rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-3 shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]',
        className,
      )}
    >
      <h2 className="m-0 font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]">
        Waiting on you · {requests.length}
      </h2>
      <ApprovalStack requests={requests} keyboard={false} />
    </section>
  );
}
