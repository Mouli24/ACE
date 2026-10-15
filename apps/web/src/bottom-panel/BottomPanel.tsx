import { Badge, Icons, Tabs, TabsContent, TabsList, TabsTrigger } from '@ace/ui';
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

/**
 * Bottom pane (Arch §33.1 step 5): Validation, Events, Errors and the round-4 Timeline.
 *
 * Hidden until the workspace menu's "Problems & events" opens it (D332), so the header has no
 * collapse toggle: the tabs are the kit's segmented pill, counts are mono chips, and the theme's
 * 28px ✕ closes the panel (D328).
 */
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
      className="flex h-full flex-col bg-[var(--panel)] text-[var(--ink)]"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 px-[14px]">
        <TabsList>
          {labels.map(([value, label]) => (
            <TabsTrigger key={value} value={value} className="flex-none gap-[6px] px-[14px]">
              {label}{' '}
              {counts[value] > 0 && (
                <Badge
                  data-testid={`bottom-count-${value}`}
                  variant={value === 'errors' ? 'danger' : 'default'}
                >
                  {counts[value]}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex-1" />
        {open && (
          <button
            type="button"
            aria-label="Close problems & events"
            data-testid="bottom-toggle"
            onClick={toggle}
            className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-[7px] border border-[var(--line)] bg-transparent text-[12px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
          >
            <Icons.X aria-hidden size={12} />
          </button>
        )}
      </div>

      {open && (
        <>
          <TabsContent
            value="validation"
            className="min-h-0 flex-1 overflow-auto px-[16px] pb-[14px]"
          >
            <ValidationTab workflowId={workflowId} />
          </TabsContent>

          <TabsContent value="events" className="min-h-0 flex-1 overflow-auto px-[16px] pb-[14px]">
            <EventsTab
              entries={events}
              nodes={nodes}
              onShowNode={(nodeId) => select([nodeId], [])}
            />
          </TabsContent>

          <TabsContent value="errors" className="min-h-0 flex-1 overflow-auto px-[16px] pb-[14px]">
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

          <TabsContent
            value="timeline"
            className="min-h-0 flex-1 overflow-hidden px-[16px] pb-[14px]"
          >
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
