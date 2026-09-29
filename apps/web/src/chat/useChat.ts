import type { ChatMessage, ChatThread, ChatThreadDetail, ChatVerdict, Part } from '@ace/contracts';
import { GuardrailBlockedDetailsSchema } from '@ace/contracts';
import { AceApiError, ThreadEventBuffer, type ThreadView } from '@ace/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { api } from '../app/api';
import { getSocket } from '../app/socket';
import { chatKeys } from './keys';

/** The threads of one agent node (FR-CHAT-004). A bare array, the way §2.4 answers it (D78). */
export function useChatThreads(nodeId: string | undefined) {
  return useQuery<ChatThread[]>({
    queryKey: chatKeys.threads(nodeId ?? ''),
    queryFn: () => api().listNodeChatThreads(nodeId ?? ''),
    enabled: Boolean(nodeId),
  });
}

/** One thread's settled turns and metadata (FR-CHAT-006). */
export function useChatThreadDetail(threadId: string | undefined) {
  return useQuery<ChatThreadDetail>({
    queryKey: chatKeys.thread(threadId ?? ''),
    queryFn: () => api().getChatThread(threadId ?? ''),
    enabled: Boolean(threadId),
  });
}

/** An input the agent's guardrail policy refused (422 `guardrail_blocked`, FR-CHAT-008). */
export interface ChatRefusal {
  message: string;
  verdicts: ChatVerdict[];
}

export interface ChatConversation {
  /** Settled turns plus the user turn still echoing and any agent reply not yet re-fetched. */
  messages: ChatMessage[];
  /** The assistant reply streaming in right now (FR-CHAT-006); `''` when nothing streams. */
  streamingText: string;
  streaming: boolean;
  /** Set when the last send was refused on the input; cleared on the next send. */
  refusal: ChatRefusal | undefined;
  send: (content: Part[]) => void;
  sending: boolean;
}

/**
 * The live conversation with one agent (FR-CHAT-004/006/008). It never reads or writes a run or a
 * node run (FR-CHAT-005): its only sources are `POST /nodes/:id/chat`, `GET /chat/threads/:id`, and
 * the thread's own `chat.token`/`chat.message` frames folded by the SDK's `ThreadEventBuffer`.
 *
 * `chat.token` is transient and builds the streaming reply; the agent's `chat.message` settles it,
 * at which point the thread detail is re-fetched so the settled list is the engine's, not ours. A
 * just-sent user turn echoes optimistically until that re-fetch carries it, and an agent reply from
 * the buffer shows in the same gap — both de-duplicated by id, so nothing appears twice.
 */
export function useThreadConversation(
  nodeId: string,
  threadId: string | undefined,
  onThreadOpened: (threadId: string) => void,
): ChatConversation {
  const queryClient = useQueryClient();
  const detail = useChatThreadDetail(threadId);
  const [refusal, setRefusal] = useState<ChatRefusal | undefined>();
  const [pendingUser, setPendingUser] = useState<ChatMessage | undefined>();

  const bufferRef = useRef<ThreadEventBuffer>(new ThreadEventBuffer(threadId));
  const [view, setView] = useState<ThreadView>(() => bufferRef.current.view);

  // A fresh buffer per thread, subscribed to that thread's frames while it is open (§2.5).
  useEffect(() => {
    const buffer = new ThreadEventBuffer(threadId);
    bufferRef.current = buffer;
    setView(buffer.view);
    setRefusal(undefined);

    const socket = getSocket();
    if (threadId === undefined || socket === undefined) return;

    const payload = { scope: 'thread' as const, id: threadId };
    socket.subscribe(payload);

    const offToken = socket.on('chat.token', (_payload, frame) => {
      buffer.apply(frame);
      setView(buffer.view);
    });
    const offMessage = socket.on('chat.message', (_payload, frame) => {
      buffer.apply(frame);
      setView(buffer.view);
      // The reply settled: let the engine's stored list become the source of truth.
      if (frame.payload.message.role === 'agent') {
        void queryClient.invalidateQueries({ queryKey: chatKeys.thread(threadId) });
      }
    });

    return () => {
      offToken();
      offMessage();
      socket.unsubscribe(payload);
    };
  }, [threadId, queryClient]);

  const post = useMutation({
    mutationFn: (content: Part[]) =>
      api().postNodeChat(nodeId, threadId === undefined ? { content } : { threadId, content }),
    onMutate: () => setRefusal(undefined),
    onSuccess: (response, content) => {
      setPendingUser({
        id: response.messageId,
        threadId: response.threadId,
        role: 'user',
        content,
        verdicts: [],
        at: new Date().toISOString(),
      });
      if (response.threadId !== threadId) {
        onThreadOpened(response.threadId);
        void queryClient.invalidateQueries({ queryKey: chatKeys.threads(nodeId) });
      }
    },
    onError: (err) => {
      if (AceApiError.is(err) && err.code === 'guardrail_blocked') {
        const parsed = GuardrailBlockedDetailsSchema.safeParse(err.details);
        setRefusal({ message: err.message, verdicts: parsed.success ? parsed.data.verdicts : [] });
      }
    },
  });

  const loaded = detail.data?.messages ?? [];
  const loadedIds = new Set(loaded.map((message) => message.id));
  const liveAgents = view.messages.filter(
    (message) => message.role === 'agent' && !loadedIds.has(message.id),
  );
  const echo =
    pendingUser !== undefined &&
    pendingUser.threadId === threadId &&
    !loadedIds.has(pendingUser.id)
      ? [pendingUser]
      : [];

  return {
    messages: [...loaded, ...echo, ...liveAgents],
    streamingText: view.streamingText,
    streaming: view.streaming,
    refusal,
    send: (content) => post.mutate(content),
    sending: post.isPending,
  };
}

/** Delete a thread; the owner clears the active selection when its own thread went (FR-CHAT-004). */
export function useDeleteThread(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => api().deleteChatThread(threadId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.threads(nodeId) }),
  });
}
