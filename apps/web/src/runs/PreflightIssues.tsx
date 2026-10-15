import { useSelectionStore } from '../app/stores/selection';
import { useRun } from './hooks';
import { useRunStore } from './run-store';
import { CHIP_CLASS } from './RunStateChip';
import { RunUndoChoice, undoIssueOf } from './UndoChoice';

/**
 * Pre-flight refused the run (FR-EXE-003, BR-08). The run exists and is recorded; nothing was sent
 * to any provider. Every issue that names a node links to it, because "fix this" needs a where.
 *
 * A canvas overlay in the theme (D328): a surface card, radius 12, with the menu shadow; a red dot
 * heads it, each issue is a 12.5px row with its code as a red mono chip and a "show node" link.
 */
export function PreflightIssues({ workflowId }: { workflowId: string }) {
  const runId = useRunStore((store) => (store.workflowId === workflowId ? store.runId : undefined));
  const status = useRunStore((store) =>
    store.workflowId === workflowId ? store.status : undefined,
  );
  const run = useRun(status === 'BLOCKED' ? runId : undefined);
  const select = useSelectionStore((s) => s.setSelection);

  const issues = run.data?.preflightIssues ?? [];
  if (status !== 'BLOCKED' || issues.length === 0) return null;

  // PG-2.4 (D361): a writing run stopped because undo could not be recorded asks what to do.
  if (run.data !== undefined && undoIssueOf(run.data) !== undefined) {
    return (
      <div className="absolute inset-x-3 top-[58px] z-10">
        <RunUndoChoice workflowId={workflowId} run={run.data} />
      </div>
    );
  }

  return (
    <section
      role="alert"
      data-testid="preflight-issues"
      className="absolute inset-x-3 top-[58px] z-10 flex flex-col gap-[10px] rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-[14px] text-[var(--ink)] shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]"
    >
      <h2 className="m-0 flex items-center gap-2 text-[13px] font-bold">
        <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#c94c27]" />
        Pre-flight blocked this run — nothing was sent to a provider
      </h2>
      <ul className="m-0 flex list-none flex-col p-0">
        {issues.map((issue, index) => (
          <li
            key={index}
            className="flex min-h-[36px] items-center gap-[10px] border-t border-[var(--line)] py-[6px] text-[12.5px] first:border-t-0"
          >
            <span className={`${CHIP_CLASS} shrink-0 bg-[#c94c271f] text-[#c94c27]`}>
              {issue.code}
            </span>
            <span className="min-w-0 flex-1">{issue.message}</span>
            {issue.nodeId && (
              <button
                type="button"
                onClick={() => select([issue.nodeId as string], [])}
                aria-label={`show node for ${issue.code}`}
                className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-[11.5px] font-semibold text-[#e8623a] outline-none hover:text-[#c94c27] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
              >
                show node
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
