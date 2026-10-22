import type { MemoryOp, NodeRun } from '@ace/contracts';
import { useQuery } from '@tanstack/react-query';

import { api } from '../app/api';

/*
 * PG-4.5: what the engine records about a node run that was hidden — that it was copied from an
 * earlier run rather than executed (FR-EXE-013, D83), and what it remembered or forgot (FR-MEM-002).
 * Shared by the Inspector and Domain, so both say the same thing.
 */

const NOTE_CLASS =
  'flex flex-col gap-1 rounded-[10px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px] text-[12px]';

/**
 * "Reused from run …": Start from node copied this node run's output from an earlier one. Nothing
 * was called, which is why it cost nothing — not a fresh $0 run. The original's run is read from
 * `GET /node-runs/:id`; until it answers, the original node run is named instead.
 */
export function ReusedNote({ nodeRun }: { nodeRun: Pick<NodeRun, 'reusedFromNodeRunId'> }) {
  const originId = nodeRun.reusedFromNodeRunId;
  const origin = useQuery({
    queryKey: ['node-run', originId ?? ''],
    queryFn: () => api().getNodeRun(originId ?? ''),
    enabled: originId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (originId === undefined) return null;
  const runId = origin.data?.runId;
  return (
    <p role="note" data-testid="reused-from" className={`m-0 ${NOTE_CLASS}`}>
      <span>
        Reused from run{' '}
        <span className="font-machine text-[11px]" title={runId ?? originId}>
          {runId === undefined ? `(node run ${originId.slice(-6)})` : runId.slice(-6)}
        </span>{' '}
        — not executed again. Its output was copied, nothing was called and it cost nothing.
      </span>
    </p>
  );
}

/** What the node's `__memory` ops did, in order: saved (with the value) or forgotten. */
export function MemoryOpsList({ ops }: { ops: readonly MemoryOp[] | undefined }) {
  if (ops === undefined || ops.length === 0) return null;
  return (
    <ul data-testid="memory-ops" className="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
      {ops.map((op, index) => (
        <li key={`${op.op}:${op.key}:${index}`} data-op={op.op} className="flex gap-2">
          <span
            className={`shrink-0 font-machine text-[10.5px] ${op.op === 'save' ? 'text-[#2f9e63]' : 'text-danger'}`}
          >
            {op.op === 'save' ? 'remembered' : 'forgot'}
          </span>
          <span className="min-w-0 break-words">
            <b className="font-semibold">{op.key}</b>
            {op.op === 'save' && <span className="text-[var(--muted)]"> = {op.value}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
