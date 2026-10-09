import type { ChatMessage, Node } from '@ace/contracts';
import { MessageBubble } from '@ace/ui';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { api } from '../app/api';
import { useProviders } from '../providers/hooks';
import { useNodeOverlay } from '../runs/run-store';
import { ChatRefusalCard, ChatVerdicts } from './ChatVerdicts';
import type { ChatConversation as Conversation } from './useChat';

const money = (value: number) => `$${value.toFixed(6)}`;

/**
 * The line under an agent turn (FR-CHAT-006): the model that actually answered, what it cost, and
 * whether a run of the node wrote it (D285).
 */
function turnMeta(message: ChatMessage): ReactNode {
  const parts: ReactNode[] = [];
  if (message.runId !== undefined) {
    parts.push(
      <span
        key="run"
        data-testid="chat-run-badge"
        className="rounded-chip border border-border px-1.5"
      >
        run
      </span>,
    );
  }
  if (message.modelId !== undefined) {
    parts.push(
      <span key="model" data-testid="chat-model">
        {message.modelId}
      </span>,
    );
  }
  if (message.usage !== undefined && message.error === undefined) {
    const { tokensIn, tokensOut, costUsd } = message.usage;
    parts.push(
      <span key="usage" data-testid="chat-usage">
        {tokensIn} in · {tokensOut} out · {money(costUsd)}
      </span>,
    );
  }
  return parts.length === 0 ? undefined : (
    <span className="inline-flex flex-wrap items-center gap-1.5">{parts}</span>
  );
}

/** Busy states of a node's run that the chat shows as "working" (FR-EXE-009). */
const WORKING = new Set(['RUNNING', 'WAITING']);

/**
 * One node's conversation (FR-CHAT-004/006/007/008, D285): the stored turns — the direct chat and
 * what runs of the node wrote — the reply streaming in, the node's run while it is working, and
 * whatever stopped a message: a guardrail, a failed send, or a model call that failed. Every part
 * is rendered by the same `MessageBubble`/`PartRenderer` the timeline and inspector use.
 */
export function ChatConversation({
  node,
  convo,
  composer,
}: {
  node: Node;
  convo: Conversation;
  /** The input box, when it belongs inside the conversation (the phone tab); the column keeps its own. */
  composer?: ReactNode;
}) {
  const providers = useProviders();
  const providerId = 'providerId' in node.config ? node.config.providerId : undefined;
  const provider = providers.data?.find((each) => each.id === providerId)?.type;
  const contentUrl = (artifactId: string) => api().artifactContentUrl(artifactId);
  const scroller = useRef<HTMLDivElement>(null);
  const run = useNodeOverlay(node.id);
  const running = WORKING.has(run.state);

  // Follow the tail as turns arrive, the reply streams, and the run works.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [
    convo.messages.length,
    convo.streamingText,
    convo.refusal,
    convo.error,
    convo.awaitingReply,
    running,
    run.streamedText,
  ]);

  const empty =
    convo.messages.length === 0 &&
    !convo.awaitingReply &&
    !running &&
    convo.refusal === undefined &&
    convo.error === undefined;
  const agentBubble = (extra: { meta?: ReactNode }) => ({
    nodeName: node.name,
    ...(provider !== undefined ? { provider } : {}),
    ...extra,
  });

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="chat-conversation"
      data-node-id={node.id}
    >
      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] py-4"
      >
        {empty && (
          <p className="text-sm text-fg-muted">
            Chat with {node.name} — it answers with its model and goal. Run the workflow and its
            result lands here too.
          </p>
        )}

        {convo.messages.map((message) => (
          <div key={message.id} data-testid={`chat-turn-${message.role}`}>
            {message.error !== undefined ? (
              <div
                role="alert"
                data-testid="chat-error-turn"
                data-code={message.error.code}
                className="rounded-card border border-danger/60 bg-danger/10 p-3 text-sm text-fg"
              >
                <div className="mb-1 flex items-center gap-1.5 font-machine text-[11px] text-danger">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {node.name} could not answer · {message.error.code}
                  {message.runId !== undefined && (
                    <span
                      data-testid="chat-run-badge"
                      className="rounded-chip border border-danger/50 px-1.5"
                    >
                      run
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap break-words">{message.error.message}</p>
              </div>
            ) : (
              <MessageBubble
                type={message.role}
                content={message.content}
                contentUrl={contentUrl}
                {...(message.role === 'agent'
                  ? agentBubble({ meta: turnMeta(message) })
                  : { meta: message.runId === undefined ? undefined : turnMeta(message) })}
              />
            )}
            {message.verdicts.length > 0 && (
              <div className="mt-1 pl-1">
                <ChatVerdicts verdicts={message.verdicts} />
              </div>
            )}
          </div>
        ))}

        {convo.streamingText.length > 0 ? (
          <div aria-live="polite" data-testid="chat-streaming">
            <MessageBubble
              type="agent"
              content={[{ type: 'text', text: convo.streamingText }]}
              {...agentBubble({ meta: <span className="animate-pulse">…</span> })}
            />
          </div>
        ) : (
          convo.awaitingReply && (
            <div aria-live="polite" data-testid="chat-thinking">
              <MessageBubble
                type="agent"
                content={[{ type: 'text', text: 'Thinking…' }]}
                {...agentBubble({
                  meta: <span className="animate-pulse">waiting for the model</span>,
                })}
              />
            </div>
          )
        )}

        {running && (
          <div aria-live="polite" data-testid="chat-run-live">
            <MessageBubble
              type="agent"
              content={[
                {
                  type: 'text',
                  text:
                    run.state === 'WAITING'
                      ? 'Waiting for your approval…'
                      : run.streamedText.length > 0
                        ? run.streamedText
                        : 'Working on its goal…',
                },
              ]}
              {...agentBubble({ meta: <span className="animate-pulse">running</span> })}
            />
          </div>
        )}

        {convo.refusal !== undefined && (
          <ChatRefusalCard message={convo.refusal.message} verdicts={convo.refusal.verdicts} />
        )}

        {convo.error !== undefined && (
          <div
            role="alert"
            data-testid="chat-send-error"
            className="rounded-card border border-danger/60 bg-danger/10 p-3 text-sm text-fg"
          >
            <div className="mb-1 flex items-center gap-1.5 font-machine text-[11px] text-danger">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              not sent
            </div>
            <p>{convo.error}</p>
          </div>
        )}
      </div>

      {composer}
    </div>
  );
}
