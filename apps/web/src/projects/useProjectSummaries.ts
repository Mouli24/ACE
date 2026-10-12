import type { Project, RunState } from '@ace/contracts';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';

import { api } from '../app/api';
import { fileKeys } from '../forge/files/keys';
import { agentsOf } from '../theme/agents';
import { queryKeys } from '../workflows/query-keys';

/*
 * What a Home card shows about a project beyond its record (D337): its agents, whether its folder
 * is a git repository, whether a workflow is running, and when anything last happened. Built from
 * the queries the rest of the app already caches — the workflow list, each graph, the repo status
 * — so Home and the workspace share one cache. A field stays `undefined` until it is known: the
 * card then leaves it empty rather than show a placeholder.
 */

/** Home data is a glance, not a live view: a card older than this refetches when Home opens. */
export const SUMMARY_STALE_MS = 30_000;

/** The run states Home counts as live (D337). */
const LIVE_STATES: ReadonlySet<RunState> = new Set(['RUNNING', 'PAUSED', 'PREFLIGHT']);

/**
 * A workflow's newest run, `limit: 1`. Under `queryKeys.runs(id)` so every invalidation of the run
 * history reaches it too, but on a key of its own: the history caches the whole list there.
 */
export const latestRunKey = (workflowId: string) =>
  [...queryKeys.runs(workflowId), 'latest'] as const;

export interface ProjectAgent {
  nodeId: string;
  name: string;
  letter: string;
}

export interface ProjectSummary {
  /** Agent and Model nodes across its workflows, workflow by workflow in graph order. */
  agents: ProjectAgent[] | undefined;
  /** Its folder is a git repository. */
  repo: boolean | undefined;
  /** A workflow's latest run is RUNNING, PAUSED or PREFLIGHT. A failed lookup counts as not live. */
  live: boolean | undefined;
  /** Epoch ms of max(`lastOpenedAt`, `updatedAt`, every workflow's `updatedAt`). */
  lastActivity: number | undefined;
}

const settled = (query: UseQueryResult) => query.isSuccess || query.isError;

/** The newest of some timestamps, as epoch ms; `undefined` when none parses. */
function latest(stamps: ReadonlyArray<string | undefined>): number | undefined {
  const times = stamps
    .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter(Number.isFinite);
  return times.length === 0 ? undefined : Math.max(...times);
}

/** Project id → its summary, for every project given. */
export function useProjectSummaries(
  projects: readonly Project[] | undefined,
): Map<string, ProjectSummary> {
  const list = projects ?? [];

  const workflowLists = useQueries({
    queries: list.map((project) => ({
      queryKey: queryKeys.workflows(project.id),
      queryFn: async () => (await api().listWorkflows(project.id)).items,
      staleTime: SUMMARY_STALE_MS,
    })),
  });
  const repoStatuses = useQueries({
    queries: list.map((project) => ({
      queryKey: fileKeys.status(project.id),
      queryFn: () => api().repoStatus(project.id),
      staleTime: SUMMARY_STALE_MS,
    })),
  });

  const workflowIds = workflowLists.flatMap((query) => (query.data ?? []).map((w) => w.id));
  const graphs = useQueries({
    queries: workflowIds.map((id) => ({
      queryKey: queryKeys.workflow(id),
      queryFn: () => api().getWorkflow(id),
      staleTime: SUMMARY_STALE_MS,
    })),
  });
  const latestRuns = useQueries({
    queries: workflowIds.map((id) => ({
      queryKey: latestRunKey(id),
      queryFn: async () => (await api().listRuns(id, { limit: 1 })).items[0] ?? null,
      staleTime: SUMMARY_STALE_MS,
    })),
  });
  const graphOf = new Map(workflowIds.map((id, i) => [id, graphs[i]]));
  const runOf = new Map(workflowIds.map((id, i) => [id, latestRuns[i]]));

  const summaries = new Map<string, ProjectSummary>();
  list.forEach((project, i) => {
    const workflowsQuery = workflowLists[i];
    const repoQuery = repoStatuses[i];
    const workflows = workflowsQuery?.data;

    let agents: ProjectAgent[] | undefined;
    let live: boolean | undefined;
    if (workflows) {
      const graphQueries = workflows.map((w) => graphOf.get(w.id));
      if (graphQueries.every((q) => q?.isSuccess)) {
        agents = graphQueries.flatMap((q) =>
          agentsOf(q?.data?.nodes ?? []).map(({ nodeId, name, letter }) => ({
            nodeId,
            name,
            letter,
          })),
        );
      }
      const runQueries = workflows.map((w) => runOf.get(w.id));
      if (runQueries.every((q) => q !== undefined && settled(q))) {
        live = runQueries.some((q) => {
          const run = q?.data;
          return run ? LIVE_STATES.has(run.status) : false;
        });
      }
    } else if (workflowsQuery?.isError) {
      live = false;
    }

    summaries.set(project.id, {
      agents,
      repo: repoQuery?.isSuccess ? repoQuery.data.repo : undefined,
      live,
      lastActivity:
        workflowsQuery !== undefined && settled(workflowsQuery)
          ? latest([
              project.lastOpenedAt,
              project.updatedAt,
              ...(workflows ?? []).map((w) => w.updatedAt),
            ])
          : undefined,
    });
  });
  return summaries;
}
