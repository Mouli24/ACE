import type { Edge, Node } from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icons,
} from '@ace/ui';

import { NODE_KIND_LABEL, type CanvasNodeKind } from '../nodes/factory';
import { runAfterCheck, runsAfter } from './run-order';

const ROW =
  'flex w-full cursor-pointer items-center justify-between gap-3 rounded-[9px] border border-[var(--line)] bg-transparent px-3 py-2 text-left text-[13px] text-[var(--ink)] outline-none hover:border-[#ef6b3f] hover:bg-[var(--hover)] focus-visible:border-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent';

/**
 * D373: the card's More → "Run after…". Pick the node this one waits for; the link carries no
 * data. A node it already runs after is marked, and one that would make a cycle is greyed with why.
 */
export function RunAfterDialog({
  nodes,
  edges,
  nodeId,
  onPick,
  onClose,
}: {
  nodes: readonly Node[];
  edges: readonly Edge[];
  nodeId: string;
  onPick: (afterId: string) => void;
  onClose: () => void;
}) {
  const node = nodes.find((each) => each.id === nodeId);
  const already = new Set(runsAfter(edges, nodeId).map((edge) => edge.from.nodeId));
  const others = nodes.filter((each) => each.id !== nodeId);
  const name = node?.name || 'this node';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="run-after-dialog" className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Run {name} after…</DialogTitle>
          <DialogDescription>
            Pick the node it waits for. Nothing is passed along — it only starts once that node has
            finished.
          </DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-none flex-col gap-[6px] p-0" aria-label="Nodes">
          {others.length === 0 && (
            <li className="text-[13px] text-[var(--muted)]">There is no other node yet.</li>
          )}
          {others.map((other) => {
            const runs = already.has(other.id);
            const check = runs ? undefined : runAfterCheck(nodes, edges, nodeId, other.id);
            const reason = check !== undefined && !check.ok ? check.reason : undefined;
            const otherName = other.name || 'Untitled';
            return (
              <li key={other.id}>
                <button
                  type="button"
                  className={ROW}
                  data-testid={`run-after-${other.id}`}
                  disabled={runs || reason !== undefined}
                  title={reason}
                  aria-label={
                    runs
                      ? `${otherName}, already runs before it`
                      : reason !== undefined
                        ? `${otherName}, not possible: ${reason}`
                        : `Run after ${otherName}`
                  }
                  onClick={() => {
                    onPick(other.id);
                    onClose();
                  }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">{otherName}</span>
                    {reason !== undefined && (
                      <span className="whitespace-normal text-[11px] text-[var(--muted)]">
                        {reason}
                      </span>
                    )}
                  </span>
                  {runs ? (
                    <Icons.Check aria-hidden size={14} className="shrink-0 text-[#ef6b3f]" />
                  ) : (
                    <span className="shrink-0 font-machine text-[11px] text-[var(--muted)]">
                      {NODE_KIND_LABEL[other.kind as CanvasNodeKind] ?? other.kind}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
