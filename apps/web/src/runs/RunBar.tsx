import type { HaltReason, Id, Node, Part, RunAction, RunState } from '@ace/contracts';
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
  cn,
} from '@ace/ui';
import { Play } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';

import { useWorkflowGraph } from '../workflows/hooks';
import { RunControls } from './controls/RunControls';
import {
  inputNodesNeedingText,
  usePauseRun,
  useRestartRun,
  useResumeRun,
  useSocketStatus,
  useStartRun,
  useStopRun,
  useEndRun,
} from './hooks';
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

/** The run state as a design status colour (V2 chip). A stopped halt reads STOPPED, any other FAILED. */
function runStateColor(status: RunState, haltReason: HaltReason | undefined): string {
  const name = {
    PREFLIGHT: 'READY',
    RUNNING: 'RUNNING',
    PAUSED: 'PAUSED',
    COMPLETE: 'COMPLETED',
    BLOCKED: 'BLOCKED',
    HALTED: haltReason === 'stopped' ? 'STOPPED' : 'FAILED',
  }[status];
  return `var(--color-status-${name})`;
}

const money = (value: number) => `$${value.toFixed(4)}`;

/**
 * Start, run status and totals in the top bar (FR-EXE-001, FR-OBS-002). One active run per workflow:
 * while a run is in flight the button is disabled rather than queuing a second one.
 *
 * Round 3 puts Pause · Resume · Stop · Restart beside it (FR-CTL-001..004). Which of the four is
 * live is not decided here: `RunControls` enables a button only because `Run.allowedActions` names
 * it, and that list comes from the engine through the overlay (FR-CTL-006, BR-01).
 */
export function RunBar({
  workflowId,
  haltInline = true,
}: {
  workflowId: string;
  /** False on the desktop top bar, where the Canvas shows the halt note instead. */
  haltInline?: boolean;
}) {
  const graph = useWorkflowGraph(workflowId);
  const navigate = useNavigate();
  const start = useStartRun(workflowId);
  const socketStatus = useSocketStatus();
  const [dialogNodes, setDialogNodes] = useState<Array<{ id: string; name: string }>>();

  // A fresh object per call would re-render forever; the shallow compare is what makes it stable.
  const run = useRunStore(
    useShallow((store) => {
      const mine = store.workflowId === workflowId;
      return {
        runId: mine ? store.runId : undefined,
        status: mine ? store.status : undefined,
        haltReason: mine ? store.haltReason : undefined,
        budgetHalt: mine ? store.budgetHalt : undefined,
        allowedActions: mine ? store.allowedActions : undefined,
        totals: mine ? store.totals : undefined,
        active: mine && store.active,
      };
    }),
  );

  const nodes = graph.data?.nodes ?? [];

  /*
   * One mutation per control rather than one that switches: each has its own `isPending`, and a
   * restart writes a *new* run into the overlay, which the others must not do (FR-CTL-004).
   */
  const pause = usePauseRun();
  const resume = useResumeRun();
  const stop = useStopRun();
  const restart = useRestartRun();
  const end = useEndRun();
  const busy =
    pause.isPending || resume.isPending || stop.isPending || restart.isPending || end.isPending;

  const onAction = async (action: RunAction) => {
    if (run.runId === undefined) return;
    const mutation = { pause, resume, stop, restart, end }[action];
    return mutation.mutateAsync(run.runId);
  };

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
    // On the desktop bar (above 641 px) the run bar holds its width and the workflow tabs give way.
    <div className="flex items-center gap-2 min-[641px]:shrink-0" data-testid="run-bar">
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
          className="inline-flex h-[26px] shrink-0 items-center gap-[7px] whitespace-nowrap rounded-chip border px-[11px] font-machine text-[10.5px] uppercase tracking-[0.06em]"
          style={{
            color: runStateColor(run.status, run.haltReason),
            borderColor: `color-mix(in oklab, ${runStateColor(run.status, run.haltReason)} 40%, transparent)`,
          }}
        >
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full bg-current',
              run.status === 'RUNNING' && 'ace-pulse',
            )}
          />
          {/* One flex item beside the dot. The desktop bar's narrow band (641 px to lg) shows just
              the state (the Canvas's halt note says why); the rest is visually hidden, not removed,
              so assistive tech and the phone header keep the whole label. */}
          <span>
            <span className="min-[641px]:max-lg:sr-only">run </span>
            {RUN_STATE_LABEL[run.status]}
            {run.haltReason && (
              <span className="min-[641px]:max-lg:sr-only">{` · ${run.haltReason}`}</span>
            )}
          </span>
        </span>
      )}

      {run.totals && (
        <span
          data-testid="run-totals"
          className="shrink-0 whitespace-nowrap font-machine text-[10.5px] text-fg-muted"
        >
          {run.totals.tokensIn}↓ {run.totals.tokensOut}↑ {money(run.totals.costUsd)}
        </span>
      )}

      {!run.active && (
        <Button
          size="sm"
          className="h-[30px] uppercase tracking-[0.08em]"
          aria-label="Start run"
          onClick={onStart}
          disabled={start.isPending}
        >
          <Play className="h-3.5 w-3.5 fill-current" aria-hidden /> Run
        </Button>
      )}

      <RunControls
        {...(run.runId === undefined ? {} : { runId: run.runId })}
        {...(run.status === undefined ? {} : { status: run.status })}
        {...(run.allowedActions === undefined ? {} : { allowedActions: run.allowedActions })}
        {...(run.haltReason === undefined ? {} : { haltReason: run.haltReason })}
        {...(run.budgetHalt === undefined ? {} : { budgetHalt: run.budgetHalt })}
        onAction={onAction}
        onOpenRun={(runId: Id) => navigate(`/runs/${runId}`)}
        busy={busy}
        showHalt={haltInline}
      />

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
