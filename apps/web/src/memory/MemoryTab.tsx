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
import { Trash2 } from 'lucide-react';
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
 */
export function MemoryTab({ workflowId }: { workflowId: Id }) {
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const graph = useWorkflowGraph(workflowId);
  const node = graph.data?.nodes.find((each) => each.id === focusedNodeId);

  if (node === undefined) {
    return (
      <p className="p-4 text-sm text-fg-muted" data-testid="memory-tab-empty-selection">
        Select an agent to see its memory.
      </p>
    );
  }
  if (node.kind !== 'agent') {
    return (
      <p className="p-4 text-sm text-fg-muted" data-testid="memory-tab-not-agent">
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
      className="flex flex-col gap-3 p-4"
      aria-label={`Memory of ${node.name}`}
      data-testid="memory-tab"
      data-node-id={node.id}
    >
      <header className="flex items-center gap-2">
        <h2 className="font-human text-[21px] font-semibold leading-tight">{node.name} — memory</h2>
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
          className="rounded-field border border-border bg-card px-3 py-2 text-xs text-fg-muted"
          data-testid="memory-disabled"
        >
          Memory is off for this agent, so nothing new is saved or used. Turn on “Remember facts
          between runs” under Configure.
        </p>
      )}

      {memory.isPending && <p className="text-xs text-fg-muted">Loading memory…</p>}
      {memory.isError && (
        <p role="alert" className="text-xs text-danger">
          Could not load memory: {memory.error.message}
        </p>
      )}
      {(remove.isError || clear.isError) && (
        <p role="alert" className="text-xs text-danger">
          Could not delete: {(remove.error ?? clear.error)?.message}
        </p>
      )}

      {memory.data !== undefined && entries.length === 0 && (
        <p className="text-sm text-fg-muted" data-testid="memory-empty">
          {enabled
            ? 'Nothing remembered yet. Facts this agent saves during a run appear here.'
            : 'Nothing remembered.'}
        </p>
      )}

      {entries.length > 0 && (
        <table
          className="w-full table-fixed rounded-field border border-border bg-card text-left text-xs"
          data-testid="memory-table"
        >
          <thead className="font-machine text-[9px] uppercase tracking-[0.2em] text-fg-faint">
            <tr>
              <th className="w-1/5 pb-1 font-normal">Key</th>
              <th className="pb-1 font-normal">Value</th>
              <th className="w-1/5 pb-1 font-normal">Created</th>
              <th className="w-1/5 pb-1 font-normal">Last used</th>
              <th className="w-8 pb-1">
                <span className="sr-only">Delete</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.id}
                className="border-t border-border align-top"
                data-testid={`memory-entry-${entry.key}`}
                data-entry-id={entry.id}
              >
                <td className="truncate py-1.5 pr-2 font-machine" title={entry.key}>
                  {entry.key}
                </td>
                <td className="break-words py-1.5 pr-2" data-testid="memory-value">
                  {entry.value}
                </td>
                <td className="py-1.5 pr-2 text-fg-muted">{when(entry.createdAt)}</td>
                <td className="py-1.5 pr-2 text-fg-muted" data-testid="memory-last-used">
                  {when(entry.lastUsedAt)}
                </td>
                <td className="py-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${entry.key}`}
                    data-testid={`memory-delete-${entry.key}`}
                    onClick={() => setPending({ kind: 'one', entry })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
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
