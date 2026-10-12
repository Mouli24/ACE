import type { AceSocket } from '@ace/sdk';
import { useEffect } from 'react';

import { getSocket } from '../app/socket';

/** Per socket, so a restarted socket (tests) starts from zero. */
const holders = new WeakMap<AceSocket, Map<string, number>>();

/**
 * Holds the socket's `project` subscription while anyone needs it (D299, D301). The Explorer's
 * `files.changed` and the terminal's process frames share one subscription, so one consumer
 * leaving never cuts the other's feed: the first holder subscribes, the last to let go
 * unsubscribes. Answers the release, which counts once however often it is called.
 */
export function retainProjectScope(socket: AceSocket, projectId: string): () => void {
  const counts = holders.get(socket) ?? new Map<string, number>();
  holders.set(socket, counts);
  const payload = { scope: 'project' as const, id: projectId };
  const count = counts.get(projectId) ?? 0;
  counts.set(projectId, count + 1);
  if (count === 0) socket.subscribe(payload);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (counts.get(projectId) ?? 1) - 1;
    if (left > 0) {
      counts.set(projectId, left);
      return;
    }
    counts.delete(projectId);
    socket.unsubscribe(payload);
  };
}

/** While mounted, this component holds the project's scope. */
export function useProjectScope(projectId: string | undefined): void {
  useEffect(() => {
    const socket = getSocket();
    if (projectId === undefined || projectId === '' || socket === undefined) return;
    return retainProjectScope(socket, projectId);
  }, [projectId]);
}
