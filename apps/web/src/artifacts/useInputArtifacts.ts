import type { InputConfig, WorkflowGraphResponse } from '@ace/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useGraphSync } from '../workflows/hooks';
import { queryKeys } from '../workflows/query-keys';

export interface UseInputArtifacts {
  artifactIds: string[];
  /** Attach an artifact; a repeat id is a no-op, so dropping the same bytes twice keeps one entry. */
  add: (artifactId: string) => void;
  /** Detach an artifact from this Input node (the artifact itself is not deleted). */
  remove: (artifactId: string) => void;
}

/**
 * Read and patch an Input node's `artifactIds` (M4 §2, FR-MM-007). Every change is one `update_node`
 * op carrying the whole config, read from the cache at call time — the same path config fields use
 * (ConfigPanel `patchConfig`), so it composes with other edits and dodges the engine re-applying Zod
 * defaults to omitted keys (D-001).
 */
export function useInputArtifacts(
  workflowId: string,
  nodeId: string,
  config: InputConfig,
): UseInputArtifacts {
  const sync = useGraphSync(workflowId);
  const queryClient = useQueryClient();

  const setArtifactIds = useCallback(
    (next: (ids: string[]) => string[]) => {
      const latest = queryClient
        .getQueryData<WorkflowGraphResponse>(queryKeys.workflow(workflowId))
        ?.nodes.find((node) => node.id === nodeId);
      const current = latest?.kind === 'input' ? latest.config : config;
      const artifactIds = next(current.artifactIds);
      sync.enqueue([{ op: 'update_node', nodeId, patch: { config: { ...current, artifactIds } } }]);
    },
    [sync, queryClient, workflowId, nodeId, config],
  );

  const add = useCallback(
    (artifactId: string) =>
      setArtifactIds((ids) => (ids.includes(artifactId) ? ids : [...ids, artifactId])),
    [setArtifactIds],
  );

  const remove = useCallback(
    (artifactId: string) => setArtifactIds((ids) => ids.filter((id) => id !== artifactId)),
    [setArtifactIds],
  );

  return { artifactIds: config.artifactIds, add, remove };
}
