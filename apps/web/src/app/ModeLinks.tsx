import { cn } from '@ace/ui';
import { Link } from 'react-router-dom';

import { workflowPath, type WorkflowMode } from '../forge/mode';

export const MODE_LABEL: Readonly<Record<WorkflowMode, string>> = {
  ideate: 'Ideate',
  forge: 'Forge',
  domain: 'Domain',
};

export const MODES: readonly WorkflowMode[] = ['ideate', 'forge', 'domain'];

/** A workflow mode's path, with the selected run when there is one (`?run=`, PG-3.2). */
export function modeHref(
  projectId: string,
  workflowId: string,
  mode: WorkflowMode,
  runId?: string,
): string {
  const path = workflowPath(projectId, workflowId, mode);
  return runId === undefined ? path : `${path}?run=${encodeURIComponent(runId)}`;
}

/**
 * PG-3.7: every entry point to a workflow offers all three modes — Ideate, Forge and Domain — not
 * only the one it used to open. A row of small theme pills; `runId` carries the run being looked at.
 */
export function ModeLinks({
  projectId,
  workflowId,
  runId,
  className,
  testIdPrefix = 'mode-link',
}: {
  projectId: string;
  workflowId: string;
  runId?: string;
  className?: string;
  testIdPrefix?: string;
}) {
  return (
    <nav aria-label="Open in" className={cn('flex flex-wrap items-center gap-[6px]', className)}>
      {MODES.map((mode) => (
        <Link
          key={mode}
          to={modeHref(projectId, workflowId, mode, runId)}
          data-testid={`${testIdPrefix}-${mode}`}
          className="inline-flex h-[24px] items-center whitespace-nowrap rounded-full border border-[var(--line)] bg-[var(--chip)] px-[10px] text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_var(--focus)]"
        >
          {MODE_LABEL[mode]}
        </Link>
      ))}
    </nav>
  );
}
