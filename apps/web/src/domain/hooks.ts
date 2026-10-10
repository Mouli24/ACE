import type {
  DomainMessage,
  Id,
  PostRunMessageRequest,
  RouteEnvelopeRequest,
  Run,
} from '@ace/contracts';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../app/api';
import {
  applyFrame,
  fromPage,
  initialConversation,
  type ConversationState,
} from './conversation-state';

/** A run that still takes messages: going, paused, or blocked mid-run (D305, D323). */
export const isLiveRun = (run: Pick<Run, 'status' | 'blockedReason'>): boolean =>
  run.status === 'RUNNING' ||
  run.status === 'PAUSED' ||
  (run.status === 'BLOCKED' && run.blockedReason !== undefined);

/**
 * A run's conversation (D9, D314). A live run is read from its stream — backfill, then live, and a
 * dropped connection carries on from the last id — and an ended one from its pages, once. The
 * server projects; this only folds.
 */
export function useDomainConversation(
  runId: Id | undefined,
  options: { node?: Id; live: boolean },
): ConversationState & { error?: string } {
  const { node, live } = options;
  const [state, setState] = useState<ConversationState>(initialConversation);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setState(initialConversation());
    setError(undefined);
    if (runId === undefined) return undefined;

    if (live) {
      const stream = api().streamChat(runId, {
        ...(node === undefined ? {} : { node }),
        onFrame: (frame) => setState((current) => applyFrame(current, frame)),
      });
      void stream.done.then(() => {
        const refused = stream.error();
        if (refused !== undefined) setError(refused.message);
      });
      return () => stream.close();
    }

    let cancelled = false;
    void (async () => {
      try {
        const messages: DomainMessage[] = [];
        let after: string | undefined;
        for (;;) {
          const page = await api().chatPage(runId, {
            ...(node === undefined ? {} : { node }),
            ...(after === undefined ? {} : { after }),
            limit: 500,
          });
          messages.push(...page.messages);
          if (page.nextCursor === undefined) break;
          after = page.nextCursor;
        }
        const usage = await api().runUsage(runId);
        if (!cancelled) setState({ ...fromPage(messages), usage });
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, node, live]);

  return { ...state, ...(error === undefined ? {} : { error }) };
}

export function usePostRunMessage(runId: Id | undefined) {
  return useMutation({
    mutationFn: (body: PostRunMessageRequest) => api().postRunMessage(runId ?? '', body),
  });
}

export function useRouteEnvelope(runId: Id | undefined) {
  return useMutation({
    mutationFn: ({ envelopeId, body }: { envelopeId: Id; body: RouteEnvelopeRequest }) =>
      api().routeEnvelope(runId ?? '', envelopeId, body),
  });
}

export function useSetRunBudget(runId: Id | undefined) {
  return useMutation({
    mutationFn: (limit: number | null) => api().setRunBudget(runId ?? '', limit),
  });
}
