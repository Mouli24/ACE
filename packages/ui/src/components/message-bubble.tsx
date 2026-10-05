import type { MessageType, Part, ProviderType } from '@ace/contracts';
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
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
  // A CSS variable, so Night and Paper each get their own provider colour.
  const accent = provider ? `var(--color-provider-${provider})` : undefined;

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
          className="ml-auto max-w-[88%] rounded-[14px_14px_4px_14px] border border-border-strong bg-card px-[13px] py-[9px] font-human text-[14.5px] text-fg"
        >
          {body}
          {meta && <div className="mt-1 text-right font-machine text-[10px] text-fg-muted">{meta}</div>}
        </div>
      </div>
    );
  }

  // Agent and output: left-aligned. Output is highlighted; an agent reply is tinted by its provider.
  const isOutput = type === 'output';
  const tint = accent ?? 'var(--color-fg-muted)';
  return (
    <div className={cn('flex w-full flex-col items-start gap-1', className)}>
      {(nodeName !== undefined || isOutput) && (
        <span
          className="flex items-center gap-1.5 font-machine text-[10px] uppercase tracking-wide text-fg-muted"
          style={!isOutput && accent ? { color: accent } : undefined}
        >
          {!isOutput && (
            <span aria-hidden className="h-[7px] w-[7px] rounded-full" style={{ background: tint }} />
          )}
          <span className={cn(isOutput && 'text-accent')}>{isOutput ? 'final output' : nodeName}</span>
        </span>
      )}
      <div
        data-testid="message-bubble"
        data-type={type}
        aria-label={TYPE_LABEL[type]}
        style={
          isOutput
            ? undefined
            : {
                borderColor: `color-mix(in oklab, ${tint} 30%, var(--color-border))`,
                background: `color-mix(in oklab, ${tint} 5%, var(--color-canvas))`,
              }
        }
        className={cn(
          'max-w-[92%] rounded-[14px_14px_14px_4px] border px-[13px] py-[9px] text-[14.5px] text-fg-soft',
          isOutput && 'border-accent/60 bg-accent/10',
        )}
      >
        {body}
        {meta && <div className="mt-1 font-machine text-[10px] text-fg-muted">{meta}</div>}
      </div>
    </div>
  );
}
