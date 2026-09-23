import { Button } from '@ace/ui';

import { useSelectionStore } from '../app/stores/selection';
import { useRun } from './hooks';
import { useRunStore } from './run-store';

/**
 * Pre-flight refused the run (FR-EXE-003, BR-08). The run exists and is recorded; nothing was sent
 * to any provider. Every issue that names a node links to it, because "fix this" needs a where.
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

  return (
    <section
      role="alert"
      data-testid="preflight-issues"
      className="absolute inset-x-3 top-3 z-10 flex flex-col gap-2 rounded-card border border-[var(--color-status-BLOCKED)]/70 bg-panel/95 p-3 shadow-lg"
    >
      <h2 className="font-human text-sm font-semibold">
        Pre-flight blocked this run — nothing was sent to a provider
      </h2>
      <ul className="flex flex-col gap-1">
        {issues.map((issue, index) => (
          <li key={index} className="flex items-center gap-2 text-sm">
            <span className="font-machine text-xs text-fg-muted">{issue.code}</span>
            <span className="flex-1">{issue.message}</span>
            {issue.nodeId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => select([issue.nodeId as string], [])}
                aria-label={`show node for ${issue.code}`}
              >
                show node
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
