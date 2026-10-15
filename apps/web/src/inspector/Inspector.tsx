import type { Id, NodeRun } from '@ace/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  StatusRing,
} from '@ace/ui';
import { useEffect, useMemo, useState } from 'react';

import { useSelectionStore } from '../app/stores/selection';
import { IterationSelector } from '../edges/loop/IterationSelector';
import { VerdictList } from '../guardrails/VerdictList';
import { useProviders } from '../providers/hooks';
import { LOCAL_COST_TEXT, UNKNOWN_COST_TITLE, costText, isLocalProvider } from '../runs/CostValue';
import { NodeRunMenu } from '../runs/controls/NodeRunMenu';
import { useRerunNode, useRetryNodeRun, useRun, useStartRun, useNodeRuns } from '../runs/hooks';
import { useSelectedRun } from '../runs/selected-run';
import { useWorkflowGraph } from '../workflows/hooks';
import { EnvelopeView, PartView } from './EnvelopeView';
import { PromptText } from './PromptText';
import { MemoryOpsList, ReusedNote } from './RecordNotes';
import { SourcesSection } from './SourcesSection';
import { TraceTab } from './TraceTab';
import { ToolCallsTab } from './ToolCallsTab';

const money = (value: number) => `$${value.toFixed(6)}`;

/** The theme's empty state: one muted 13px line (D328). */
const EMPTY = 'm-0 py-3 text-center text-[13px] text-[var(--muted)]';
/** The theme's inner box: radius 10, soft fill, hairline. */
const INNER_BOX =
  'flex flex-col gap-1 rounded-[10px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px] text-[12px]';

/**
 * The inspector (FR-EXE-010, FR-PRM-004/005). It reads node runs from the engine rather than from
 * the live overlay: the overlay is what is happening, this is the record of what happened — every
 * field here is one the engine persisted, including the exact prompt text.
 *
 * In the theme (D328): the node name at 18px / 700, the state as a mono chip, the run figures as
 * Domain's token tiles, sections under mono small-caps labels, and inner boxes on `--soft`.
 */
export function Inspector({ workflowId }: { workflowId: string }) {
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  // PG-3.2: the workflow's one selected run, finished or live (D-091's newest run by default).
  const { runId, loading: runsLoading } = useSelectedRun(workflowId);
  const nodeRuns = useNodeRuns(runId);
  const graph = useWorkflowGraph(workflowId);
  const run = useRun(runId);
  /**
   * PG-4.1: every node of the run's snapshot by name — what the run executed (BR-04) — with the live
   * graph's names behind it until the run is read.
   */
  const names = useMemo(
    () =>
      new Map<Id, string>([
        ...(graph.data?.nodes ?? []).map((node): [Id, string] => [node.id, node.name]),
        ...(run.data?.snapshot.nodes ?? []).map((node): [Id, string] => [node.id, node.name]),
      ]),
    [graph.data, run.data],
  );
  const [promptOpen, setPromptOpen] = useState(false);
  /** Which node run of this node is on show; the newest until one is picked. */
  const [pickedNodeRunId, setPickedNodeRunId] = useState<Id>();
  // Another node's third iteration is not this node's; the selector would otherwise render blank.
  useEffect(() => setPickedNodeRunId(undefined), [focusedNodeId, runId]);

  const forNode = (nodeRuns.data ?? []).filter((run) => run.nodeId === focusedNodeId);
  const nodeRun = forNode.find((run) => run.id === pickedNodeRunId) ?? forNode[forNode.length - 1];

  const retry = useRetryNodeRun();
  const rerun = useRerunNode();
  const start = useStartRun(workflowId);
  const busy = retry.isPending || rerun.isPending || start.isPending;
  /*
   * PG-4.4: the node as the run knew it — its snapshot name first, so a node deleted or renamed
   * since the run started is still called what it ran as; never a stand-in like "this node".
   */
  const nodeName =
    focusedNodeId === undefined
      ? ''
      : (names.get(focusedNodeId) ?? (run.isLoading ? 'Loading…' : `Node ${focusedNodeId}`));

  return (
    <section
      aria-label="Node run inspector"
      className="flex h-full flex-col gap-4 overflow-y-auto text-[var(--ink)]"
      data-testid="inspector"
    >
      {runId === undefined && runsLoading && <p className={EMPTY}>Loading runs…</p>}
      {runId === undefined && !runsLoading && <p className={EMPTY}>Start a run to inspect it.</p>}
      {runId !== undefined && focusedNodeId === undefined && (
        <p className={EMPTY}>Select a node to see what its run did.</p>
      )}
      {runId !== undefined && focusedNodeId !== undefined && forNode.length === 0 && (
        <p className={EMPTY}>This node has not run yet.</p>
      )}

      {nodeRun && focusedNodeId !== undefined && (
        <>
          {/* Every iteration of this node, with what each produced (FR-PAR-005, TC-PAR-006). */}
          {forNode.length > 1 && (
            <IterationSelector
              runs={forNode}
              selectedNodeRunId={nodeRun.id}
              onSelect={setPickedNodeRunId}
            />
          )}

          <header className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 mr-auto min-w-0 truncate text-[18px] font-bold tracking-[-0.01em]">
              {nodeName}
            </h2>
            <StatusRing state={nodeRun.status} showLabel />
            {nodeRun.failureReason && (
              <Badge variant="danger" data-testid="inspector-failure-reason">
                {nodeRun.failureReason}
              </Badge>
            )}
            <NodeRunMenu
              nodeId={focusedNodeId}
              nodeName={nodeName}
              state={nodeRun.status}
              nodeRunId={nodeRun.id}
              busy={busy}
              onRetry={() => retry.mutate({ nodeRunId: nodeRun.id, withDownstream: false })}
              onRetryWithDownstream={() =>
                retry.mutate({ nodeRunId: nodeRun.id, withDownstream: true })
              }
              onRerunNode={() => {
                if (runId !== undefined) rerun.mutate({ runId, nodeId: focusedNodeId });
              }}
              // FR-EXE-013: a new run that reuses everything upstream rather than calling it again.
              onStartFromNode={() => start.mutate({ startFromNodeId: focusedNodeId })}
            />
            <span className="font-machine text-[10px] text-[var(--muted)]" title={nodeRun.id}>
              {nodeRun.id.slice(-6)}
            </span>
          </header>

          <Facts nodeRun={nodeRun} />

          {/* PG-4.5: copied by Start from node, not executed — never a fresh $0 run. */}
          <ReusedNote nodeRun={nodeRun} />

          {nodeRun.error && (
            <div
              role="alert"
              data-testid="inspector-error"
              className="flex flex-col gap-1 rounded-[10px] border border-[rgba(201,76,39,0.35)] bg-[var(--surface)] px-3 py-[10px] text-[12px]"
            >
              <p className="m-0 font-machine text-[11px] text-[#c94c27]">
                {nodeRun.error.kind} · {nodeRun.error.code}
              </p>
              <p className="m-0 text-[var(--ink)]">{nodeRun.error.message}</p>
              {nodeRun.error.providerId && (
                <p className="m-0 font-machine text-[10.5px] text-[var(--muted)]">
                  provider {nodeRun.error.providerId}
                </p>
              )}
            </div>
          )}

          <Section title="Inputs">
            {nodeRun.inputEnvelopes.length === 0 ? (
              <p className="m-0 text-[12px] text-[var(--muted)]">
                No envelope — this node started the run.
              </p>
            ) : (
              nodeRun.inputEnvelopes.map((envelope) => (
                <EnvelopeView key={envelope.id} envelope={envelope} names={names} />
              ))
            )}
          </Section>

          {/*
           * Every guardrail verdict on this node run, and for a redaction the types removed and
           * never the value (FR-GRD-014/015, TC-GRD-018/019). The policy it was checked against is
           * named with its version, so a verdict can be traced to the rules that produced it
           * (FR-GRD-002).
           */}
          <Section title="Verdicts">
            {nodeRun.guardrailPolicy && (
              <p
                className="m-0 font-machine text-[10.5px] text-[var(--muted)]"
                data-testid="inspector-policy"
              >
                policy {nodeRun.guardrailPolicy.id.slice(-6)} · version{' '}
                {nodeRun.guardrailPolicy.version}
              </p>
            )}
            <VerdictList verdicts={nodeRun.verdicts} />
          </Section>

          {nodeRun.toolCalls.length > 0 && (
            <ToolCallsTab toolCalls={nodeRun.toolCalls} approvals={nodeRun.approvals} />
          )}

          {nodeRun.approvals !== undefined && nodeRun.approvals.length > 0 && (
            <Section title="Approvals">
              <ul
                className="m-0 flex list-none flex-col gap-[6px] p-0"
                data-testid="inspector-approvals"
              >
                {nodeRun.approvals.map((decision) => (
                  <li
                    key={decision.requestId}
                    data-testid={`approval-decision-${decision.requestId}`}
                    data-decision={decision.decision}
                    className={INNER_BOX}
                  >
                    <span
                      className={`font-machine text-[11px] ${decision.decision === 'approve' ? 'text-[#2f9e63]' : 'text-[#c94c27]'}`}
                    >
                      {decision.decision === 'approve' ? 'approved' : 'rejected'} ·{' '}
                      {new Date(decision.decidedAt).toLocaleTimeString()}
                    </span>
                    {decision.note !== undefined && (
                      <span className="text-[var(--muted)]">{decision.note}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <SourcesSection nodeRun={nodeRun} />

          {/* PG-4.5: what this node run remembered or forgot (FR-MEM-002). */}
          {nodeRun.memoryOps !== undefined && nodeRun.memoryOps.length > 0 && (
            <Section title="Memory">
              <MemoryOpsList ops={nodeRun.memoryOps} />
            </Section>
          )}

          <Section title="Output">
            {nodeRun.output === undefined ? (
              <p className="m-0 text-[12px] text-[var(--muted)]">Nothing recorded.</p>
            ) : (
              <div data-testid="inspector-output" className="flex flex-col gap-2">
                {nodeRun.output.map((part, index) => (
                  <PartView key={index} part={part} />
                ))}
              </div>
            )}
          </Section>

          {nodeRun.prompt && (
            <Section title="Prompt">
              <p
                className="m-0 font-machine text-[11px] text-[var(--muted)]"
                data-testid="prompt-version"
              >
                version {nodeRun.prompt.version}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => setPromptOpen(true)}
              >
                View prompt
              </Button>
            </Section>
          )}

          <TraceTab runId={nodeRun.runId} nodeId={focusedNodeId} />

          {nodeRun.prompt && promptOpen && (
            <Dialog open onOpenChange={setPromptOpen}>
              <DialogContent className="max-w-[760px]">
                <DialogHeader>
                  <DialogTitle>Prompt as sent</DialogTitle>
                  <DialogDescription>
                    Exactly what went to the provider, with secrets redacted (FR-PRM-005).
                  </DialogDescription>
                </DialogHeader>
                <PromptText text={nodeRun.prompt.text} />
              </DialogContent>
            </Dialog>
          )}
        </>
      )}
    </section>
  );
}

function Facts({ nodeRun }: { nodeRun: NodeRun }) {
  const providers = useProviders();
  // PG-1.4 (D359): a local model is free by rule; an unpriced one's cost is unknown, never $0.
  const local = isLocalProvider(
    providers.data?.find((provider) => provider.id === nodeRun.modelUsed?.providerId),
  );
  const unknownCost = nodeRun.usage.costKnown === false;
  const stats: Array<[string, string]> = [
    ['attempt', String(nodeRun.attempt)],
    ['tokens', `${nodeRun.usage.tokensIn + nodeRun.usage.tokensOut}`],
    [
      'cost',
      local && !unknownCost && nodeRun.usage.costUsd === 0
        ? LOCAL_COST_TEXT
        : costText(nodeRun.usage, money),
    ],
  ];
  const rows: Array<[string, string]> = [
    ['model', nodeRun.modelUsed ? nodeRun.modelUsed.modelId : '—'],
    // PG-4.1: the model the provider reports actually answered (an alias such as `opus` resolved).
    [
      'model used',
      nodeRun.modelUsed ? (nodeRun.modelUsed.resolvedModelId ?? nodeRun.modelUsed.modelId) : '—',
    ],
    ['via fallback', nodeRun.modelUsed ? (nodeRun.modelUsed.viaFallback ? 'yes' : 'no') : '—'],
    ['tokens in', String(nodeRun.usage.tokensIn)],
    ['tokens out', String(nodeRun.usage.tokensOut)],
    ['price table', nodeRun.usage.priceTableVersion ?? '—'],
    ['duration', nodeRun.durationMs === undefined ? '—' : `${nodeRun.durationMs} ms`],
    ['iteration', String(nodeRun.iteration)],
  ];
  return (
    <div className="flex flex-col gap-2.5" data-testid="inspector-facts">
      <div className="grid grid-cols-3 gap-2">
        {stats.map(([label, value]) => (
          <div
            key={label}
            className="flex min-w-0 flex-col rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-[10px] py-[9px]"
          >
            <span className="text-[10.5px] text-[var(--muted)]">{label}</span>
            <span
              className="mt-[3px] truncate font-machine text-[13px] font-medium text-[var(--ink)]"
              title={label === 'cost' && unknownCost ? UNKNOWN_COST_TITLE : value}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-[var(--muted)]">{label}</dt>
            <dd className="m-0 truncate font-machine text-[11.5px]" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-[7px]">
      <h3 className="m-0 font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]">
        {title}
      </h3>
      {children}
    </section>
  );
}
