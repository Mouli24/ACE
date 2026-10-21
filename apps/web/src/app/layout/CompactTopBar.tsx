import { Link, useParams } from 'react-router-dom';

import { useProject } from '../../projects/hooks';
import { ProviderStatusBar } from '../../providers/ProviderStatusBar';
import { CompactMenu } from '../../responsive/CompactMenu';
import { RunBar } from '../../runs/RunBar';
import { ApprovalsBadge } from '../../runs/approvals/ApprovalsBadge';
import { useRunStore } from '../../runs/run-store';
import { LogoMark } from '../../theme/primitives';
import { DayTotalsChip } from '../../usage/DayTotalsChip';
import { useWorkflowGraph } from '../../workflows/hooks';
import { ModeSwitch } from './ModeSwitch';

/**
 * The phone header (FR-MOB-001, D330): the theme has none, so it wears the theme's tokens. ACE and
 * the project, the approvals waiting (FR-MOB-002) and the menu — provider status and the day's
 * totals open at its top — and inside a workflow the mode switch and the run bar on a row of
 * their own.
 */
export function CompactTopBar() {
  const { projectId, workflowId } = useParams();
  const project = useProject(projectId);
  const runId = useRunStore((store) => store.runId);
  // audit U-17: no mode switch or run bar for a workflow that cannot be loaded
  const missing = useWorkflowGraph(workflowId).isError;

  return (
    <header
      className="flex shrink-0 flex-col border-b border-[var(--line)] bg-[var(--hdr)] text-[var(--ink)]"
      data-testid="topbar-compact"
    >
      <div className="flex h-12 min-w-0 items-center gap-2 px-3">
        <Link
          to="/projects"
          className="flex shrink-0 items-center gap-2 text-[var(--ink)] no-underline hover:text-[var(--ink)]"
        >
          <LogoMark size={13} />
          <span className="text-[15px] font-bold tracking-[0.02em]">ACE</span>
        </Link>
        {project.data && (
          <>
            <span aria-hidden className="text-[var(--muted)]">
              /
            </span>
            <Link
              to={`/projects/${project.data.id}`}
              className="min-w-0 truncate text-[13px] text-[var(--muted)] no-underline hover:text-[var(--ink)]"
              data-testid="project-name"
            >
              {project.data.name}
            </Link>
          </>
        )}
        <div className="flex-1" />
        <ApprovalsBadge runId={runId} />
        <CompactMenu
          {...(projectId === undefined ? {} : { projectId })}
          status={
            <>
              <ProviderStatusBar />
              <DayTotalsChip />
            </>
          }
        />
      </div>
      {projectId && workflowId && !missing && (
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto px-3 pb-2">
          <ModeSwitch projectId={projectId} workflowId={workflowId} />
          <RunBar workflowId={workflowId} />
        </div>
      )}
    </header>
  );
}
