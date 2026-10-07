import { useQuery } from '@tanstack/react-query';

import { api } from '../../app/api';
import { queryKeys } from '../../workflows/query-keys';

/**
 * The approvals inbox query (ACE parity P1, D270): `GET /approvals`, every pending approval across
 * runs. Keyed under `approvals`, so a decision taken anywhere — which invalidates
 * `queryKeys.approvalsRoot()` — refreshes it too; refetched every 10 s and on every `task.updated`
 * frame (`app/socket`), because a task waiting on a card is how most of them start.
 */
export const approvalsInboxKey = () => [...queryKeys.approvalsRoot(), 'inbox'] as const;

export const APPROVALS_INBOX_REFETCH_MS = 10_000;

export function usePendingApprovals() {
  return useQuery({
    queryKey: approvalsInboxKey(),
    queryFn: async () => (await api().listPendingApprovals()).items,
    refetchInterval: APPROVALS_INBOX_REFETCH_MS,
  });
}
