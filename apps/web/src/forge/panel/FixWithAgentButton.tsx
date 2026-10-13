import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { fixWithAgent, type FixableProblem } from './fix-with-agent';

/**
 * "Fix with agent" on a problem (D302, design §6.5), in the theme's chip style (the chat's "Send to
 * Forge →"). Problems rows carry it; the merge gives Run checks' rows the same button.
 */
export function FixWithAgentButton({
  projectId,
  problem,
}: {
  projectId: string;
  problem: FixableProblem;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title={`Fix with agent: ${problem.message}`}
      data-testid="fix-with-agent"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void fixWithAgent({ projectId, problem, queryClient }).finally(() => setBusy(false));
      }}
      className="h-[22px] shrink-0 cursor-pointer whitespace-nowrap rounded-full border border-[var(--line)] bg-[var(--chip)] px-[9px] text-[10px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-default disabled:opacity-60"
    >
      Fix with agent
    </button>
  );
}
