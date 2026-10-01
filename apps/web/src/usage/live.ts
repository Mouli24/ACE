import type { ServerFrame } from '@ace/contracts';
import type { ServerFrameType } from '@ace/sdk';
import { useEffect, useRef } from 'react';

import { getSocket } from '../app/socket';

/**
 * Call `handler` for every frame of these types while the component is mounted. The handler is
 * read through a ref, so a new closure each render neither resubscribes nor goes stale.
 */
export function useSocketFrames(
  types: readonly ServerFrameType[],
  handler: (frame: ServerFrame) => void,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  const key = types.join(',');
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const offs = (key.split(',') as ServerFrameType[]).map((type) =>
      socket.on(type, (_payload, frame) => ref.current(frame)),
    );
    return () => offs.forEach((off) => off());
  }, [key]);
}

/** The run a run-scope frame belongs to, whatever its payload's shape. */
export function frameRunId(frame: ServerFrame): string | undefined {
  const payload: unknown = frame.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as { runId?: unknown; run?: { id?: unknown }; message?: { runId?: unknown } };
  if (typeof p.runId === 'string') return p.runId;
  if (typeof p.run?.id === 'string') return p.run.id;
  if (typeof p.message?.runId === 'string') return p.message.runId;
  return undefined;
}
