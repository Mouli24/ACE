import type { Node, Part } from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
  toast,
} from '@ace/ui';
import { useState, type FormEvent, type ReactNode } from 'react';

import { useWorkflowGraph } from '../workflows/hooks';
import { inputNodesNeedingText, useEndRun, useStartRun } from './hooks';
import { useRunStore } from './run-store';

/**
 * Starting a workflow's run from anywhere in the workspace (FR-EXE-001, FR-NODE-011): the run bar
 * on phones, the workspace "…" menu and Forge's "▶ Run pipeline" (D331, D334). An Input node with
 * nothing to send is asked for text first; `dialog` is that question, to render where the caller is.
 */
export function useStartRunFlow(workflowId: string): {
  start: () => void;
  dialog: ReactNode;
  /** A run of this workflow is in flight; starting again would be refused. */
  active: boolean;
  pending: boolean;
  /**
   * PG-3.5 (D323, D360): the run in flight was started from Domain and stays open until it is
   * ended — Start is not merely disabled, it is waiting for the person. `parked` when no node is
   * working: the team is idle and the run waits for a message or an End.
   */
  open: { parked: boolean; end: () => void; ending: boolean } | undefined;
} {
  const graph = useWorkflowGraph(workflowId);
  const startRun = useStartRun(workflowId);
  const endRun = useEndRun();
  const active = useRunStore((store) => store.workflowId === workflowId && store.active);
  const openRunId = useRunStore((store) =>
    store.workflowId === workflowId && store.active && (store.allowedActions ?? []).includes('end')
      ? store.runId
      : undefined,
  );
  const working = useRunStore((store) =>
    store
      .nodeRuns()
      .some((run) => run.status === 'RUNNING' || run.status === 'READY' || run.status === 'WAITING'),
  );
  const [dialogNodes, setDialogNodes] = useState<Array<{ id: string; name: string }>>();

  const launch = (inputs?: Record<string, Part[]>) => {
    startRun.mutate(inputs === undefined ? {} : { inputs });
    setDialogNodes(undefined);
  };

  const start = () => {
    const missing = inputNodesNeedingText((graph.data?.nodes ?? []) as Node[]);
    if (missing.length > 0) setDialogNodes(missing);
    else launch();
  };

  const dialog = dialogNodes ? (
    <InputDialog nodes={dialogNodes} onCancel={() => setDialogNodes(undefined)} onSubmit={launch} />
  ) : null;

  const open =
    openRunId === undefined
      ? undefined
      : {
          parked: !working,
          ending: endRun.isPending,
          end: () =>
            endRun.mutate(openRunId, { onError: (error) => toast.error(error.message) }),
        };

  return { start, dialog, active, pending: startRun.isPending, open };
}

/**
 * PG-3.5 (D323): where Start would sit, a run started from Domain that is still open says so and
 * offers its End — instead of a Start that is silently disabled.
 */
export function OpenRunEnd({
  open,
  className,
}: {
  open: { parked: boolean; end: () => void; ending: boolean };
  className?: string;
}) {
  const label = open.parked ? 'Waiting for you — End run' : 'Team working — End run';
  return (
    <button
      type="button"
      data-testid="open-run-end"
      title="This run was started from Domain and stays open until it is ended."
      disabled={open.ending}
      onClick={open.end}
      className={
        className ??
        'flex h-7 shrink-0 cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-[8px] border border-[var(--line)] bg-transparent px-[10px] text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-not-allowed disabled:opacity-45'
      }
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#e8a23a] [animation:livePulse_2s_ease-in-out_infinite]"
      />
      {label}
    </button>
  );
}

/**
 * Collects one text part per Input node that has none (FR-NODE-011, TC-NODE-010). The text is sent
 * as the run's `inputs`, not written back to the graph: the run records what it was given, and the
 * node keeps whatever it was configured with (BR-04).
 */
export function InputDialog({
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
