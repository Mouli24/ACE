import type { ChatMessage, Node } from '@ace/contracts';
import { MessageBubble } from '@ace/ui';
import { useEffect, useRef, type ReactNode } from 'react';

import { api } from '../app/api';
import { useProviders } from '../providers/hooks';
import { ChatComposer } from './ChatComposer';
import { ChatRefusalCard, ChatVerdicts } from './ChatVerdicts';
import { SendToBuildButton } from './SendToBuild';
import type { ChatConversation as Conversation } from './useChat';

const money = (value: number) => `$${value.toFixed(6)}`;

/** The token/cost line under a settled agent reply (FR-CHAT-006, "usage per reply shown small"). */
function usageMeta(message: ChatMessage) {
  if (message.usage === undefined) return undefined;
  const { tokensIn, tokensOut, costUsd } = message.usage;
  return (
    <span data-testid="chat-usage">
      {tokensIn} in · {tokensOut} out · {money(costUsd)}
    </span>
  );
}

/**
 * One thread's turns, the streaming reply, and the composer (FR-CHAT-004/006/007/008). Every part is
 * rendered by the same `MessageBubble`/`PartRenderer` the timeline and inspector use, so an image or
 * JSON reply looks the same everywhere; media resolves through the SDK's `artifactContentUrl`. Each
 * settled agent reply can be handed over as a task with *Send to Build* (ACE parity P1).
 */
export function ChatConversation({
  node,
  convo,
  aboveComposer,
}: {
  node: Node;
  convo: Conversation;
  /** Extra footer content above the input box (the Chat column's mention chips). */
  aboveComposer?: ReactNode;
}) {
  const providers = useProviders();
  const providerId = 'providerId' in node.config ? node.config.providerId : undefined;
  const provider = providers.data?.find((each) => each.id === providerId)?.type;
  const contentUrl = (artifactId: string) => api().artifactContentUrl(artifactId);
  const scroller = useRef<HTMLDivElement>(null);

  // Follow the tail as turns arrive and the reply streams.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [convo.messages.length, convo.streamingText, convo.refusal]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-conversation">
      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] py-4"
      >
        {convo.messages.length === 0 && !convo.streaming && convo.refusal === undefined && (
          <p className="text-sm text-fg-muted">
            Chat directly with {node.name}. This uses its model and instructions and never touches a
            run.
          </p>
        )}

        {convo.messages.map((message) => (
          <div key={message.id}>
            <MessageBubble
              type={message.role}
              content={message.content}
              contentUrl={contentUrl}
              {...(message.role === 'agent' ? { nodeName: node.name } : {})}
              {...(provider !== undefined ? { provider } : {})}
              meta={message.role === 'agent' ? usageMeta(message) : undefined}
            />
            {message.verdicts.length > 0 && (
              <div className="mt-1 pl-1">
                <ChatVerdicts verdicts={message.verdicts} />
              </div>
            )}
            {message.role === 'agent' && (
              <div className="mt-1 pl-1">
                <SendToBuildButton node={node} message={message} />
              </div>
            )}
          </div>
        ))}

        {convo.streaming && convo.streamingText.length > 0 && (
          <div aria-live="polite" data-testid="chat-streaming">
            <MessageBubble
              type="agent"
              nodeName={node.name}
              {...(provider !== undefined ? { provider } : {})}
              content={[{ type: 'text', text: convo.streamingText }]}
              meta={<span className="animate-pulse">…</span>}
            />
          </div>
        )}

        {convo.refusal !== undefined && (
          <ChatRefusalCard message={convo.refusal.message} verdicts={convo.refusal.verdicts} />
        )}
      </div>

      <ChatComposer
        onSend={convo.send}
        disabled={convo.sending}
        placeholder={`Message @${node.name}`}
        above={aboveComposer}
      />
    </div>
  );
}
