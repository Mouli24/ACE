import type { Node, Part, RunState } from '@ace/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from '@ace/ui';
import { Play } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useWorkflowGraph } from '../workflows/hooks';
import { inputNodesNeedingText, useSocketStatus, useStartRun } from './hooks';
import { useRunStore } from './run-store';

/** Run state → how the badge reads. The enum name stays the contract (BR-03: COMPLETE ≠ HALTED). */
const RUN_STATE_LABEL: Readonly<Record<RunState, string>> = {
  PREFLIGHT: 'pre-flight',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETE: 'complete',
  BLOCKED: 'blocked',
  HALTED: 'halted',
};

const money = (value: number) => `$${value.toFixed(4)}`;

/**
 * Start, run status and totals in the top bar (FR-EXE-001, FR-OBS-002). One active run per workflow:
 * while a run is in flight the button is disabled rather than queuing a second one.
 *
 * Pause, stop and retry are Round 3 — the slot beside this stays a disabled "Round 3" badge.
 */
export function RunBar({ workflowId }: { workflowId: string }) {
  const graph = useWorkflowGraph(workflowId);
  const start = useStartRun(workflowId);
  const socketStatus = useSocketStatus();
  const [dialogNodes, setDialogNodes] = useState<Array<{ id: string; name: string }>>();

  // A fresh object per call would re-render forever; the shallow compare is what makes it stable.
  const run = useRunStore(
    useShallow((store) => ({
      status: store.workflowId === workflowId ? store.status : undefined,
      haltReason: store.workflowId === workflowId ? store.haltReason : undefined,
      totals: store.workflowId === workflowId ? store.totals : undefined,
      active: store.workflowId === workflowId && store.active,
    })),
  );

  const nodes = graph.data?.nodes ?? [];

  const launch = (inputs?: Record<string, Part[]>) => {
    start.mutate(inputs === undefined ? {} : { inputs });
    setDialogNodes(undefined);
  };

  /** FR-NODE-011: an Input node with nothing to send is asked for text before the run starts. */
  const onStart = () => {
    const missing = inputNodesNeedingText(nodes as Node[]);
    if (missing.length > 0) setDialogNodes(missing);
    else launch();
  };

  return (
    <div className="flex items-center gap-2" data-testid="run-bar">
      {socketStatus === 'reconnecting' && (
        <span
          role="status"
          data-testid="socket-reconnecting"
          className="font-machine text-xs text-fg-muted"
        >
          reconnecting…
        </span>
      )}

      {run.status && (
        <span
          data-testid="run-status"
          data-status={run.status}
          className="rounded-chip border border-border bg-card px-2 py-0.5 font-machine text-xs"
        >
          run {RUN_STATE_LABEL[run.status]}
          {run.haltReason ? ` · ${run.haltReason}` : ''}
        </span>
      )}

      {run.totals && (
        <span data-testid="run-totals" className="font-machine text-xs text-fg-muted">
          {run.totals.tokensIn}↓ {run.totals.tokensOut}↑ {money(run.totals.costUsd)}
        </span>
      )}

      <Button size="sm" onClick={onStart} disabled={run.active || start.isPending}>
        <Play className="h-4 w-4" /> Start
      </Button>

      <Badge title="Pause, stop and retry arrive in Round 3">run controls · Round 3</Badge>

      {dialogNodes && (
        <InputDialog
          nodes={dialogNodes}
          onCancel={() => setDialogNodes(undefined)}
          onSubmit={launch}
        />
      )}
    </div>
  );
}

/**
 * Collects one text part per Input node that has none (FR-NODE-011, TC-NODE-010). The text is sent
 * as the run's `inputs`, not written back to the graph: the run records what it was given, and the
 * node keeps whatever it was configured with (BR-04).
 */
function InputDialog({
  nodes,
  onCancel,
  onSubmit,
}: {
  nodes: Array<{ id: string; name: string }>;
  onCancel: () => void;
  onSubmit: (inputs: Record<string, Part[]>) => void;
}) {
  const [texts, setTexts] = useState<Record<string, string>>({});
  const ready = nodes.every((node) => texts[node.id]?.trim());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const inputs: Record<string, Part[]> = {};
    for (const node of nodes) {
      inputs[node.id] = [{ type: 'text', text: texts[node.id]?.trim() ?? '' }];
    }
    onSubmit(inputs);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" data-testid="run-input-dialog">
          <DialogHeader>
            <DialogTitle>What should this run start with?</DialogTitle>
            <DialogDescription>
              {nodes.length === 1
                ? 'This Input node has nothing to send yet.'
                : `${nodes.length} Input nodes have nothing to send yet.`}
            </DialogDescription>
          </DialogHeader>

          {nodes.map((node) => (
            <div key={node.id} className="flex flex-col gap-1.5">
              <Label htmlFor={`run-input-${node.id}`}>{node.name}</Label>
              <Textarea
                id={`run-input-${node.id}`}
                rows={4}
                value={texts[node.id] ?? ''}
                onChange={(event) =>
                  setTexts((current) => ({ ...current, [node.id]: event.target.value }))
                }
                autoFocus={node === nodes[0]}
              />
            </div>
          ))}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              Start run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
