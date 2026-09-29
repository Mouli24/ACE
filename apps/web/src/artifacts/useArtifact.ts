import type { Artifact, Id } from '@ace/contracts';
import { useQuery } from '@tanstack/react-query';

import { api } from '../app/api';

/** Query key for one artifact row (`GET /artifacts/:id`), so a list and a card share the cache. */
export const artifactQueryKey = (id: string) => ['artifact', id] as const;

/** Fetch one artifact's metadata (name, size, mime, hash). Media bytes stay in the blob store. */
export function useArtifact(id: Id | undefined) {
  return useQuery<Artifact>({
    queryKey: artifactQueryKey(id ?? ''),
    queryFn: () => api().getArtifact(id ?? ''),
    enabled: Boolean(id),
    staleTime: Infinity,
  });
}
