import type { Id, UsageGroupBy } from '@ace/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../app/api';
import { allPages } from '../lib/pages';
import { useProviders } from '../providers/hooks';
import { useSocketFrames } from './live';

/** Every usage query, whatever its range — what a finished run invalidates. */
export const usageRootKey = ['usage'] as const;

export interface UsageRange {
  /** Inclusive, UTC ISO. */
  from: string;
  /** Exclusive, UTC ISO. */
  to?: string;
}

export const usageQueryKey = (range: UsageRange | undefined, groupBy: readonly UsageGroupBy[]) =>
  [...usageRootKey, range?.from, range?.to, ...groupBy] as const;

/** `GET /usage` (FR-OBS-004, D234). */
export function useUsage(range: UsageRange | undefined, groupBy: readonly UsageGroupBy[]) {
  return useQuery({
    queryKey: usageQueryKey(range, groupBy),
    queryFn: () =>
      api().getUsage({
        ...(range === undefined ? {} : { from: range.from }),
        ...(range?.to === undefined ? {} : { to: range.to }),
        groupBy: [...groupBy],
      }),
    enabled: range !== undefined && groupBy.length > 0,
  });
}

/**
 * A run that ends has spent what it is going to spend, so every usage read is stale then
 * (FR-OBS-002). `usage.updated` with day totals is the engine's "run finished" for usage (§2.8).
 */
export function useRefreshUsageOnRunEnd(): void {
  const queryClient = useQueryClient();
  useSocketFrames(['run.completed', 'usage.updated'], (frame) => {
    if (frame.type === 'usage.updated' && frame.payload.dayTotals === undefined) return;
    void queryClient.invalidateQueries({ queryKey: usageRootKey });
  });
}

/** Provider id → name, for keys and latencies keyed by id. */
export function useProviderNames(): ReadonlyMap<Id, string> {
  const providers = useProviders();
  return new Map((providers.data ?? []).map((provider) => [provider.id, provider.name]));
}

/** Workflow id → name across every project, for usage grouped by workflow. */
export function useWorkflowNames(enabled: boolean): ReadonlyMap<Id, string> {
  const names = useQuery({
    queryKey: [...usageRootKey, 'workflow-names'],
    queryFn: async () => {
      const projects = await allPages((cursor) =>
        api().listProjects(cursor === undefined ? {} : { cursor }),
      );
      const lists = await Promise.all(
        projects.map((project) =>
          allPages((cursor) =>
            api().listWorkflows(project.id, cursor === undefined ? {} : { cursor }),
          ),
        ),
      );
      return lists.flat().map((workflow) => [workflow.id, workflow.name] as const);
    },
    enabled,
  });
  return new Map(names.data ?? []);
}
