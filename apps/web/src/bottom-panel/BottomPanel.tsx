import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ace/ui';
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

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as BottomTab)}
      className="flex h-full flex-col bg-panel"
    >
      <TabsList className="px-2">
        <TabsTrigger value="validation">Validation</TabsTrigger>
        <TabsTrigger value="events">Events</TabsTrigger>
        <TabsTrigger value="errors">Errors</TabsTrigger>
        <TabsTrigger value="timeline">Timeline</TabsTrigger>
      </TabsList>

      <TabsContent value="validation" className="min-h-0 flex-1 overflow-auto">
        <ValidationTab workflowId={workflowId} />
      </TabsContent>

      <TabsContent value="events" className="min-h-0 flex-1 overflow-auto">
        <EventsTab entries={events} nodes={nodes} onShowNode={(nodeId) => select([nodeId], [])} />
      </TabsContent>

      <TabsContent value="errors" className="min-h-0 flex-1 overflow-auto">
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

      <TabsContent value="timeline" className="min-h-0 flex-1 overflow-hidden">
        {/* the project comes from the graph, so the "open full timeline" link renders (D-072) */}
        <TimelineTab
          workflowId={workflowId}
          {...(graph.data === undefined ? {} : { projectId: graph.data.workflow.projectId })}
        />
      </TabsContent>
    </Tabs>
  );
}
