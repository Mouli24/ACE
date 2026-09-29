import type { MessageType, Part, ProviderType } from '@ace/contracts';
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { PROVIDER_ACCENT } from '../tokens.js';
import { PartRenderer, type ContentUrl } from './part-renderer.js';

/**
 * One timeline row, styled by its `MessageType` (FR-CHAT-001, round 4 §5 item 4). The six types
 * read differently on sight: the user's message sits on the right in the serif face; an agent's
 * sits on the left under its node name with the provider's accent down its edge; an Output node's
 * final result is highlighted; a lifecycle event is a muted line; a node error is a red card; an
 * engine notice is grey and italic. Body content goes through the same `PartRenderer` the inspector
 * and chat use, so a JSON or image message renders identically wherever it appears.
 */

export interface MessageBubbleProps {
  type: MessageType;
  content: Part[];
  /** Passed to `PartRenderer` so media/file parts resolve; text/json/code do not need it. */
  contentUrl?: ContentUrl;
  /** Agent messages: the node that produced them, shown as the header. */
  nodeName?: string;
  /** Agent messages: the provider whose accent colours the edge and the name. */
  provider?: ProviderType;
  /** A small trailing meta line — a timestamp, token usage, a link to the error. */
  meta?: ReactNode;
  className?: string;
}

const TYPE_LABEL: Readonly<Record<MessageType, string>> = {
  user: 'you',
  agent: 'agent',
  output: 'output',
  event: 'event',
  error: 'error',
  system: 'system',
};

/** The event/system rows are single muted lines, not cards, so the timeline reads as a stream. */
function isLine(type: MessageType): boolean {
  return type === 'event' || type === 'system';
}

export function MessageBubble({
  type,
  content,
  contentUrl,
  nodeName,
  provider,
  meta,
  className,
}: MessageBubbleProps) {
  const accent = provider ? PROVIDER_ACCENT[provider] : undefined;

  const body = (
    <div className="flex flex-col gap-2" data-testid="message-body">
      {content.map((part, index) => (
        <PartRenderer key={index} part={part} contentUrl={contentUrl} />
      ))}
    </div>
  );

  // Event and system: a muted (or italic) single line, full width, no bubble.
  if (isLine(type)) {
    return (
      <div
        data-testid="message-bubble"
        data-type={type}
        aria-label={TYPE_LABEL[type]}
        className={cn(
          'w-full px-1 py-1 font-machine text-[11px] text-fg-muted',
          type === 'system' && 'italic',
          className,
        )}
      >
        {body}
        {meta && <div className="mt-0.5 text-[10px] text-fg-muted">{meta}</div>}
      </div>
    );
  }

  // Error: a red card.
  if (type === 'error') {
    return (
      <div
        data-testid="message-bubble"
        data-type="error"
        role="alert"
        aria-label={TYPE_LABEL.error}
        className={cn(
          'w-full rounded-card border border-danger/60 bg-danger/10 p-3 text-fg',
          className,
        )}
      >
        <div className="mb-1 flex items-center gap-1.5 font-machine text-[11px] text-danger">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          error
        </div>
        {body}
        {meta && <div className="mt-1 font-machine text-[10px] text-fg-muted">{meta}</div>}
      </div>
    );
  }

  // User: right-aligned serif bubble.
  if (type === 'user') {
    return (
      <div className={cn('flex w-full justify-end', className)}>
        <div
          data-testid="message-bubble"
          data-type="user"
          aria-label={TYPE_LABEL.user}
          className="max-w-[85%] rounded-card border border-border bg-card px-3 py-2 font-human text-sm text-fg"
        >
          {body}
          {meta && <div className="mt-1 text-right font-machine text-[10px] text-fg-muted">{meta}</div>}
        </div>
      </div>
    );
  }

  // Agent and output: left-aligned cards. Output is highlighted; agent carries the provider accent.
  const isOutput = type === 'output';
  return (
    <div className={cn('flex w-full justify-start', className)}>
      <div
        data-testid="message-bubble"
        data-type={type}
        aria-label={TYPE_LABEL[type]}
        style={!isOutput && accent ? { borderLeftColor: accent } : undefined}
        className={cn(
          'max-w-[85%] rounded-card border p-3',
          isOutput
            ? 'border-accent/60 bg-accent/10'
            : 'border-l-2 border-border bg-panel',
        )}
      >
        {(nodeName !== undefined || isOutput) && (
          <div
            className="mb-1 font-machine text-[10px] uppercase tracking-wide"
            style={!isOutput && accent ? { color: accent } : undefined}
          >
            <span className={cn(isOutput && 'text-accent')}>{isOutput ? 'final output' : nodeName}</span>
          </div>
        )}
        {body}
        {meta && <div className="mt-1 font-machine text-[10px] text-fg-muted">{meta}</div>}
      </div>
    </div>
  );
}
