import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ace/ui';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo } from 'react';

import { usePanelsStore, type BottomTab } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { ErrorsTab, type ErrorsTabNodeRun } from '../errors/ErrorsTab';
import { useProviders } from '../providers/hooks';
import { useNodeRuns, useRetryNodeRun } from '../runs/hooks';
import { useRunStore } from '../runs/run-store';
import { useWorkflowGraph } from '../workflows/hooks';
import { EventsTab } from './EventsTab';
import { TimelineTab } from './TimelineTab';
import { ValidationTab } from './ValidationTab';

/** Bottom pane (Arch §33.1 step 5): Validation, Events, Errors and the round-4 Timeline. */
export function BottomPanel({ workflowId }: { workflowId: string }) {
  const tab = usePanelsStore((s) => s.bottomTab);
  const setTab = usePanelsStore((s) => s.setBottomTab);
  const select = useSelectionStore((s) => s.setSelection);
  const graph = useWorkflowGraph(workflowId);
  const providers = useProviders();

  /*
   * The run this workflow is showing. Events come from the folded frames, because that is the live
   * history; the failures come from the engine's node runs, because a card names a provider and an
   * attempt the overlay does not carry. Both agree — the fold is the same events the records were
   * written from (BR-01).
   */
  const run = useRunStore((store) => (store.workflowId === workflowId ? store : undefined));
  const runId = run?.runId;
  const revision = useRunStore((store) => store.revision);
  const nodeRuns = useNodeRuns(runId);

  const events = useMemo(
    () => (run === undefined ? [] : run.events().map((event) => ({ event }))),
    // `revision` is what changes when a frame lands; the store object itself is stable.
    [run, revision],
  );

  /** A `NodeRun` record keys itself `id`; the tab asks for `nodeRunId`, so the two are joined here. */
  const errorRows = useMemo<ErrorsTabNodeRun[]>(
    () =>
      (nodeRuns.data ?? []).map((nodeRun) => ({
        nodeRunId: nodeRun.id,
        nodeId: nodeRun.nodeId,
        status: nodeRun.status,
        attempt: nodeRun.attempt,
        ...(nodeRun.failureReason === undefined ? {} : { failureReason: nodeRun.failureReason }),
        ...(nodeRun.error === undefined ? {} : { error: nodeRun.error }),
      })),
    [nodeRuns.data],
  );

  const retry = useRetryNodeRun();

  const providerNames = useMemo(
    () =>
      Object.fromEntries((providers.data ?? []).map((provider) => [provider.id, provider.name])),
    [providers.data],
  );

  const nodes = graph.data?.nodes ?? [];
  const edges = graph.data?.edges ?? [];

  const open = usePanelsStore((s) => s.bottomOpen);
  const toggle = usePanelsStore((s) => s.toggleBottom);
  // Only FAILED, the set the Errors tab lists as cards: a stop or a block is not a fault (FR-ERR-007).
  const errorCount = errorRows.filter((row) => row.status === 'FAILED').length;
  const counts: Record<BottomTab, number> = {
    validation: 0,
    events: events.length,
    errors: errorCount,
    timeline: 0,
  };
  const labels: [BottomTab, string][] = [
    ['validation', 'Validation'],
    ['events', 'Events'],
    ['errors', 'Errors'],
    ['timeline', 'Timeline'],
  ];

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as BottomTab)}
      className="flex h-full flex-col bg-panel"
    >
      <div className="flex h-10 shrink-0 items-center gap-0.5 px-2.5">
        <TabsList className="flex h-10 items-center gap-0.5 rounded-none border-0 bg-transparent p-0">
          {labels.map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-7 flex-none gap-[7px] rounded-chip px-3 font-machine text-[10.5px] data-[state=active]:bg-card data-[state=active]:text-fg data-[state=active]:shadow-[inset_0_0_0_1px_var(--color-border)]"
            >
              {label}{' '}
              {counts[value] > 0 && (
                <span
                  data-testid={`bottom-count-${value}`}
                  className={
                    value === 'errors'
                      ? 'rounded-chip bg-danger/20 px-1.5 py-px text-[9px] text-danger'
                      : 'rounded-chip bg-border px-1.5 py-px text-[9px] text-fg-soft'
                  }
                >
                  {counts[value]}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex-1" />
        <button
          type="button"
          aria-label="Toggle panel"
          data-testid="bottom-toggle"
          aria-expanded={open}
          onClick={toggle}
          className="grid h-7 w-7 place-items-center rounded-chip text-fg-muted hover:bg-border hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      </div>

      {open && (
        <>
          <TabsContent value="validation" className="min-h-0 flex-1 overflow-auto px-[18px] pb-3.5">
            <ValidationTab workflowId={workflowId} />
          </TabsContent>

          <TabsContent value="events" className="min-h-0 flex-1 overflow-auto px-[18px] pb-3.5">
            <EventsTab
              entries={events}
              nodes={nodes}
              onShowNode={(nodeId) => select([nodeId], [])}
            />
          </TabsContent>

          <TabsContent value="errors" className="min-h-0 flex-1 overflow-auto px-[18px] pb-3.5">
            <ErrorsTab
              nodes={nodes}
              edges={edges}
              nodeRuns={errorRows}
              {...(run?.haltReason === undefined ? {} : { haltReason: run.haltReason })}
              {...(run?.budgetHalt === undefined ? {} : { budgetHalt: run.budgetHalt })}
              providerNames={providerNames}
              onRetry={(nodeRunId) => retry.mutate({ nodeRunId, withDownstream: false })}
              {...(retry.isPending && retry.variables !== undefined
                ? { retryingNodeRunId: retry.variables.nodeRunId }
                : {})}
              onShowNode={(nodeId) => select([nodeId], [])}
            />
          </TabsContent>

          <TabsContent value="timeline" className="min-h-0 flex-1 overflow-hidden px-[18px] pb-3.5">
            {/* the project comes from the graph, so the "open full timeline" link renders (D-072) */}
            <TimelineTab
              workflowId={workflowId}
              {...(graph.data === undefined ? {} : { projectId: graph.data.workflow.projectId })}
            />
          </TabsContent>
        </>
      )}
    </Tabs>
  );
}
