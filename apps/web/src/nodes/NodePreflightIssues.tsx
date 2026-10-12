import type { Node } from '@ace/contracts';

import { useRun } from '../runs/hooks';
import { useRunStore } from '../runs/run-store';

/**
 * Pre-flight issues for one node, anchored under its card (FR-MM-005). When a run is BLOCKED at
 * pre-flight, the engine reports each issue with the node it names — this shows the ones that name
 * this node, so `incompatible_model` for a media input reads on the node itself, with the model name
 * the engine put in the message. The global banner still lists every issue; this is the local echo.
 * Drawn as the theme's document card, each issue led by the Blocked status dot.
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
      className="flex w-full flex-col gap-[4px] rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-[10px] py-[8px] shadow-[0_10px_30px_-14px_rgba(40,25,15,0.35)]"
    >
      {issues.map((issue, index) => (
        <p
          key={`${issue.code}-${index}`}
          data-code={issue.code}
          className="flex items-start gap-[6px] text-[10px] leading-[1.45] text-[var(--ink)]"
        >
          <span
            aria-hidden
            className="mt-[4px] h-[6px] w-[6px] shrink-0 rounded-full bg-[#c94c27]"
          />
          <span>{issue.message}</span>
        </p>
      ))}
    </div>
  );
}
