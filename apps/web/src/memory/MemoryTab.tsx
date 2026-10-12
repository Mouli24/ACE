import type { Id, MemoryEntry, Node } from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ace/ui';
import { useState } from 'react';

import { useSelectionStore } from '../app/stores/selection';
import { useWorkflowGraph } from '../workflows/hooks';
import {
  useClearMemory,
  useDeleteMemoryEntry,
  useMemorySubscription,
  useNodeMemory,
} from './hooks';

const when = (at: string | undefined) => (at === undefined ? '—' : new Date(at).toLocaleString());

/** What the confirmation dialog is about to do. */
type Pending = { kind: 'one'; entry: MemoryEntry } | { kind: 'all' };

/**
 * The sheet's Memory tab (round 5 §5 item 4, FR-MEM-004, TC-MEM-002): the focused agent's
 * long-term memory as a table — key, value, created, last used — with delete-one and clear-all, each
 * behind a confirmation, and live updates from `memory.updated`. Memory belongs to Agent nodes; any
 * other selection, or an agent with memory off, says why there is nothing to show.
 *
 * In the theme (D328): the agent's name at 18px / 700, the theme's empty-state line, and the facts
 * as a table card — mono small-caps heads, 12.5px rows with a hairline, a 28px ✕ to delete.
 */

/** The theme's empty state: one muted 13px centred line. */
const EMPTY = 'm-0 py-3 text-center text-[13px] text-[var(--muted)]';
export function MemoryTab({ workflowId }: { workflowId: Id }) {
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const graph = useWorkflowGraph(workflowId);
  const node = graph.data?.nodes.find((each) => each.id === focusedNodeId);

  if (node === undefined) {
    return (
      <p className={EMPTY} data-testid="memory-tab-empty-selection">
        Select an agent to see its memory.
      </p>
    );
  }
  if (node.kind !== 'agent') {
    return (
      <p className={EMPTY} data-testid="memory-tab-not-agent">
        Memory is kept by Agent nodes. {node.name} is a {node.kind} node.
      </p>
    );
  }
  return <AgentMemory key={node.id} node={node} />;
}

function AgentMemory({ node }: { node: Extract<Node, { kind: 'agent' }> }) {
  const memory = useNodeMemory(node.id);
  useMemorySubscription(node.id);
  const remove = useDeleteMemoryEntry(node.id);
  const clear = useClearMemory(node.id);
  const [pending, setPending] = useState<Pending>();
  const entries = memory.data ?? [];
  const enabled = node.config.memory.enabled;

  const confirm = () => {
    if (pending === undefined) return;
    if (pending.kind === 'one') remove.mutate(pending.entry.id);
    else clear.mutate();
    setPending(undefined);
  };

  return (
    <section
      className="flex flex-col gap-3 text-[var(--ink)]"
      aria-label={`Memory of ${node.name}`}
      data-testid="memory-tab"
      data-node-id={node.id}
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 min-w-0 truncate text-[18px] font-bold tracking-[-0.01em]">
          {node.name} — memory
        </h2>
        {entries.length > 0 && (
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto"
            data-testid="memory-clear-all"
            onClick={() => setPending({ kind: 'all' })}
          >
            Clear all
          </Button>
        )}
      </header>

      {!enabled && (
        <p
          role="status"
          className="m-0 rounded-[10px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px] text-[11px] leading-[1.45] text-[var(--muted)]"
          data-testid="memory-disabled"
        >
          Memory is off for this agent, so nothing new is saved or used. Turn on “Remember facts
          between runs” in the node’s settings.
        </p>
      )}

      {memory.isPending && <p className={EMPTY}>Loading memory…</p>}
      {memory.isError && (
        <p role="alert" className="m-0 text-[12px] text-[#c94c27]">
          Could not load memory: {memory.error.message}
        </p>
      )}
      {(remove.isError || clear.isError) && (
        <p role="alert" className="m-0 text-[12px] text-[#c94c27]">
          Could not delete: {(remove.error ?? clear.error)?.message}
        </p>
      )}

      {memory.data !== undefined && entries.length === 0 && (
        <p className={EMPTY} data-testid="memory-empty">
          {enabled
            ? 'Nothing remembered yet. Facts this agent saves during a run appear here.'
            : 'Nothing remembered.'}
        </p>
      )}

      {entries.length > 0 && (
        <table
          className="w-full table-fixed border-separate border-spacing-0 overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface)] text-left text-[12.5px]"
          data-testid="memory-table"
        >
          <thead className="font-machine text-[9.5px] uppercase tracking-[0.1em] text-[var(--muted)]">
            <tr className="h-[32px]">
              <th className="w-1/5 pl-[14px] pr-2 font-medium">Key</th>
              <th className="pr-2 font-medium">Value</th>
              <th className="w-1/5 pr-2 font-medium">Created</th>
              <th className="w-1/5 pr-2 font-medium">Last used</th>
              <th className="w-11">
                <span className="sr-only">Delete</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.id}
                className="h-[36px] align-middle"
                data-testid={`memory-entry-${entry.key}`}
                data-entry-id={entry.id}
              >
                <td
                  className="truncate border-t border-[var(--line)] py-[7px] pl-[14px] pr-2 font-machine text-[11.5px]"
                  title={entry.key}
                >
                  {entry.key}
                </td>
                <td
                  className="break-words border-t border-[var(--line)] py-[7px] pr-2"
                  data-testid="memory-value"
                >
                  {entry.value}
                </td>
                <td className="border-t border-[var(--line)] py-[7px] pr-2 text-[11.5px] text-[var(--muted)]">
                  {when(entry.createdAt)}
                </td>
                <td
                  className="border-t border-[var(--line)] py-[7px] pr-2 text-[11.5px] text-[var(--muted)]"
                  data-testid="memory-last-used"
                >
                  {when(entry.lastUsedAt)}
                </td>
                <td className="border-t border-[var(--line)] py-1 pr-2">
                  <button
                    type="button"
                    aria-label={`Delete ${entry.key}`}
                    data-testid={`memory-delete-${entry.key}`}
                    onClick={() => setPending({ kind: 'one', entry })}
                    className="grid h-7 w-7 cursor-pointer place-items-center rounded-[7px] border border-[var(--line)] bg-transparent text-[12px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] hover:text-[#c94c27] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
                  >
                    <span aria-hidden>✕</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog open={pending !== undefined} onOpenChange={(open) => !open && setPending(undefined)}>
        <DialogContent data-testid="memory-confirm">
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === 'all'
                ? 'Clear all memory?'
                : `Delete “${pending?.kind === 'one' ? pending.entry.key : ''}”?`}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === 'all'
                ? `${node.name} forgets all ${entries.length} remembered facts. Its next run starts with no memory.`
                : `${node.name} forgets this fact. Its next run will not see it.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setPending(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="memory-confirm-delete"
              onClick={confirm}
            >
              {pending?.kind === 'all' ? 'Clear all' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
