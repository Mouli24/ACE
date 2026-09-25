import type { Envelope, Id, NodeRun, Part } from '@ace/contracts';
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
import { useEffect, useState } from 'react';

import { useSelectionStore } from '../app/stores/selection';
import { IterationSelector } from '../edges/loop/IterationSelector';
import { VerdictList } from '../guardrails/VerdictList';
import { NodeRunMenu } from '../runs/controls/NodeRunMenu';
import { useRerunNode, useRetryNodeRun, useStartRun, useNodeRuns } from '../runs/hooks';
import { useRunStore } from '../runs/run-store';
import { useWorkflowGraph } from '../workflows/hooks';

const money = (value: number) => `$${value.toFixed(6)}`;

/**
 * The inspector (FR-EXE-010, FR-PRM-004/005). It reads node runs from the engine rather than from
 * the live overlay: the overlay is what is happening, this is the record of what happened — every
 * field here is one the engine persisted, including the exact prompt text.
 */
export function Inspector({ workflowId }: { workflowId: string }) {
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const runId = useRunStore((store) => (store.workflowId === workflowId ? store.runId : undefined));
  const nodeRuns = useNodeRuns(runId);
  const graph = useWorkflowGraph(workflowId);
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
  const nodeName =
    graph.data?.nodes.find((node) => node.id === focusedNodeId)?.name ?? 'this node';

  return (
    <section
      aria-label="Node run inspector"
      className="flex h-full flex-col gap-3 overflow-y-auto p-4"
      data-testid="inspector"
    >
      {runId === undefined && <p className="text-sm text-fg-muted">Start a run to inspect it.</p>}
      {runId !== undefined && focusedNodeId === undefined && (
        <p className="text-sm text-fg-muted">Select a node to see what its run did.</p>
      )}
      {runId !== undefined && focusedNodeId !== undefined && forNode.length === 0 && (
        <p className="text-sm text-fg-muted">This node has not run yet.</p>
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

          <header className="flex items-center gap-2">
            <StatusRing state={nodeRun.status} showLabel />
            {nodeRun.failureReason && (
              <Badge data-testid="inspector-failure-reason" className="border-danger text-danger">
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
            <span className="font-machine text-[10px] text-fg-muted" title={nodeRun.id}>
              {nodeRun.id.slice(-6)}
            </span>
          </header>

          <Facts nodeRun={nodeRun} />

          {nodeRun.error && (
            <div
              role="alert"
              data-testid="inspector-error"
              className="flex flex-col gap-1 rounded-card border border-danger/50 bg-card p-3 text-xs"
            >
              <p className="font-machine">
                {nodeRun.error.kind} · {nodeRun.error.code}
              </p>
              <p className="text-fg-muted">{nodeRun.error.message}</p>
              {nodeRun.error.providerId && (
                <p className="font-machine text-fg-muted">provider {nodeRun.error.providerId}</p>
              )}
            </div>
          )}

          <Section title="Inputs">
            {nodeRun.inputEnvelopes.length === 0 ? (
              <p className="text-xs text-fg-muted">No envelope — this node started the run.</p>
            ) : (
              nodeRun.inputEnvelopes.map((envelope) => (
                <EnvelopeView key={envelope.id} envelope={envelope} />
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
              <p className="font-machine text-[10px] text-fg-muted" data-testid="inspector-policy">
                policy {nodeRun.guardrailPolicy.id.slice(-6)} · version{' '}
                {nodeRun.guardrailPolicy.version}
              </p>
            )}
            <VerdictList verdicts={nodeRun.verdicts} />
          </Section>

          {nodeRun.approvals !== undefined && nodeRun.approvals.length > 0 && (
            <Section title="Approvals">
              <ul className="flex flex-col gap-1" data-testid="inspector-approvals">
                {nodeRun.approvals.map((decision) => (
                  <li
                    key={decision.requestId}
                    data-testid={`approval-decision-${decision.requestId}`}
                    data-decision={decision.decision}
                    className="flex flex-col gap-0.5 rounded-card border border-border bg-card p-2 text-xs"
                  >
                    <span className="font-machine">
                      {decision.decision === 'approve' ? 'approved' : 'rejected'} ·{' '}
                      {new Date(decision.decidedAt).toLocaleTimeString()}
                    </span>
                    {decision.note !== undefined && (
                      <span className="text-fg-muted">{decision.note}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Output">
            {nodeRun.output === undefined ? (
              <p className="text-xs text-fg-muted">Nothing recorded.</p>
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
              <p className="font-machine text-xs" data-testid="prompt-version">
                version {nodeRun.prompt.version}
              </p>
              <Button variant="secondary" size="sm" onClick={() => setPromptOpen(true)}>
                View prompt
              </Button>
            </Section>
          )}

          {nodeRun.prompt && promptOpen && (
            <Dialog open onOpenChange={setPromptOpen}>
              <DialogContent className="max-w-3xl">
                <DialogHeader>
                  <DialogTitle>Prompt as sent</DialogTitle>
                  <DialogDescription>
                    Exactly what went to the provider, with secrets redacted (FR-PRM-005).
                  </DialogDescription>
                </DialogHeader>
                <pre
                  data-testid="prompt-text"
                  className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-card border border-border bg-canvas p-3 font-machine text-xs"
                >
                  {nodeRun.prompt.text}
                </pre>
              </DialogContent>
            </Dialog>
          )}
        </>
      )}
    </section>
  );
}

function Facts({ nodeRun }: { nodeRun: NodeRun }) {
  const rows: Array<[string, string]> = [
    ['model', nodeRun.modelUsed ? nodeRun.modelUsed.modelId : '—'],
    ['via fallback', nodeRun.modelUsed ? (nodeRun.modelUsed.viaFallback ? 'yes' : 'no') : '—'],
    ['tokens in', String(nodeRun.usage.tokensIn)],
    ['tokens out', String(nodeRun.usage.tokensOut)],
    ['cost', money(nodeRun.usage.costUsd)],
    ['price table', nodeRun.usage.priceTableVersion ?? '—'],
    ['duration', nodeRun.durationMs === undefined ? '—' : `${nodeRun.durationMs} ms`],
    ['attempt', String(nodeRun.attempt)],
    ['iteration', String(nodeRun.iteration)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs" data-testid="inspector-facts">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-2">
          <dt className="text-fg-muted">{label}</dt>
          <dd className="truncate font-machine" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** BR-02/BR-13: what the node was handed, how much of a budget it had, and how trusted it was. */
function EnvelopeView({ envelope }: { envelope: Envelope }) {
  return (
    <div
      className="flex flex-col gap-1 rounded-card border border-border bg-card p-2 text-xs"
      data-testid={`envelope-${envelope.id}`}
    >
      <p className="font-machine text-[10px] text-fg-muted">
        from {envelope.fromNodeId.slice(-6)} · iteration {envelope.iteration} ·{' '}
        <span data-testid="envelope-trust">{envelope.context.trust}</span> · budget{' '}
        {envelope.context.budgetTokens} tokens
      </p>
      {envelope.context.summary && (
        <p className="text-fg-muted" data-testid="envelope-summary">
          {envelope.context.summary}
        </p>
      )}
      {envelope.reads.map((part, index) => (
        <PartView key={index} part={part} />
      ))}
    </div>
  );
}

/** Text, JSON tree or code — the three shapes round 2 can produce (FR-MM-006 arrives in round 4). */
function PartView({ part }: { part: Part }) {
  if (part.type === 'text') {
    return <p className="whitespace-pre-wrap font-human text-xs">{part.text}</p>;
  }
  if (part.type === 'json') {
    return (
      <pre className="overflow-auto rounded border border-border bg-canvas p-2 font-machine text-[11px]">
        {JSON.stringify(part.value, null, 2)}
      </pre>
    );
  }
  if (part.type === 'code') {
    return (
      <pre
        data-language={part.language}
        className="overflow-auto rounded border border-border bg-canvas p-2 font-machine text-[11px]"
      >
        {part.text}
      </pre>
    );
  }
  return <p className="font-machine text-xs text-fg-muted">[{part.type}]</p>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-human text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}
