import type { Node } from '@ace/contracts';
import { TriangleAlert } from 'lucide-react';

import { useRun } from '../runs/hooks';
import { useRunStore } from '../runs/run-store';

/**
 * Pre-flight issues for one node, anchored under its card (FR-MM-005). When a run is BLOCKED at
 * pre-flight, the engine reports each issue with the node it names — this shows the ones that name
 * this node, so `incompatible_model` for a media input reads on the node itself, with the model name
 * the engine put in the message. The global banner still lists every issue; this is the local echo.
 */
export function NodePreflightIssues({ node }: { node: Node }) {
  const runId = useRunStore((store) =>
    store.workflowId === node.workflowId ? store.runId : undefined,
  );
  const status = useRunStore((store) =>
    store.workflowId === node.workflowId ? store.status : undefined,
  );
  const run = useRun(status === 'BLOCKED' ? runId : undefined);

  const issues = (run.data?.preflightIssues ?? []).filter((issue) => issue.nodeId === node.id);
  if (status !== 'BLOCKED' || issues.length === 0) return null;

  return (
    <div
      role="alert"
      data-testid={`node-preflight-${node.id}`}
      className="mt-1 flex max-w-[240px] flex-col gap-1 rounded-card border border-[var(--color-status-BLOCKED)]/70 bg-panel/95 px-2 py-1.5 shadow"
    >
      {issues.map((issue, index) => (
        <p
          key={`${issue.code}-${index}`}
          data-code={issue.code}
          className="flex items-start gap-1 font-human text-[11px] text-fg"
        >
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-status-BLOCKED" aria-hidden />
          <span>{issue.message}</span>
        </p>
      ))}
    </div>
  );
}
