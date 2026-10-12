import type { MessageType, Part, ProviderType } from '@ace/contracts';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { PartRenderer, type ContentUrl } from './part-renderer.js';

/**
 * One timeline row, styled by its `MessageType` (FR-CHAT-001, round 4 §5 item 4), in the Ace UI
 * theme's vocabulary (D328). The six types read differently on sight:
 *
 * - `user`: the person's message, a surface card on the right;
 * - `agent`: on the left under its node name, with the agent's (or provider's) dot, in a soft card;
 * - `output`: an Output node's final result, the theme's green output card;
 * - `event`: a muted mono line, no card;
 * - `system`: an engine notice, the same muted line in italic;
 * - `error`: a node error, a red card.
 *
 * Body content goes through the same `PartRenderer` the inspector and chat use, so a JSON or image
 * message renders identically wherever it appears.
 */

export interface MessageBubbleProps {
  type: MessageType;
  content: Part[];
  /** Passed to `PartRenderer` so media/file parts resolve; text/json/code do not need it. */
  contentUrl?: ContentUrl;
  /** Agent messages: the node that produced them, shown as the header. */
  nodeName?: string;
  /** Agent messages: the provider, whose colour the dot takes when no `color` is given. */
  provider?: ProviderType;
  /** Agent messages: the agent's own colour (the theme assigns one per agent, by graph order). */
  color?: string;
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

/** The theme's card body: 13px / 1.5, ink. */
const CARD_BODY = 'px-[14px] py-[10px] text-[13px] leading-[1.5] text-[var(--ink)]';
const META = 'mt-[6px] text-[10px] text-[var(--muted)]';

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
  color,
  meta,
  className,
}: MessageBubbleProps) {
  const body = (
    <div className="flex min-w-0 flex-col gap-2" data-testid="message-body">
      {content.map((part, index) => (
        <PartRenderer key={index} part={part} contentUrl={contentUrl} />
      ))}
    </div>
  );

  // Event and system: a muted mono line, full width, no card; a system notice is italic.
  if (isLine(type)) {
    return (
      <div
        data-testid="message-bubble"
        data-type={type}
        aria-label={TYPE_LABEL[type]}
        className={cn(
          'w-full px-1 py-[3px] font-machine text-[11px] leading-[1.45] text-[var(--muted)]',
          type === 'system' && 'italic',
          className,
        )}
      >
        {body}
        {meta && <div className="mt-[2px] text-[10px] text-[var(--muted)]">{meta}</div>}
      </div>
    );
  }

  // Error: a red card — the output card's shape in #c94c27.
  if (type === 'error') {
    return (
      <div
        data-testid="message-bubble"
        data-type="error"
        role="alert"
        aria-label={TYPE_LABEL.error}
        className={cn(
          'w-full max-w-[92%] overflow-hidden rounded-[12px] border border-[rgba(201,76,39,0.35)] bg-[var(--surface)]',
          className,
        )}
      >
        <div className="flex items-center gap-2 border-b border-[rgba(201,76,39,0.25)] bg-[rgba(201,76,39,0.10)] px-[14px] py-[8px] text-[12px] font-bold text-[#c94c27]">
          <span aria-hidden>✕</span>
          Error
        </div>
        <div className={CARD_BODY}>
          {body}
          {meta && <div className={META}>{meta}</div>}
        </div>
      </div>
    );
  }

  // User: a surface card on the right.
  if (type === 'user') {
    return (
      <div className={cn('flex w-full justify-end', className)}>
        <div
          data-testid="message-bubble"
          data-type="user"
          aria-label={TYPE_LABEL.user}
          className={cn(
            'ml-auto max-w-[88%] rounded-[12px] border border-[var(--line)] bg-[var(--surface)]',
            CARD_BODY,
          )}
        >
          {body}
          {meta && <div className={cn(META, 'text-right')}>{meta}</div>}
        </div>
      </div>
    );
  }

  // Output: the theme's green output card, headed "Final output".
  if (type === 'output') {
    return (
      <div className={cn('flex w-full flex-col items-start', className)}>
        <div
          data-testid="message-bubble"
          data-type="output"
          aria-label={TYPE_LABEL.output}
          className="w-full max-w-[92%] overflow-hidden rounded-[12px] border border-[rgba(47,158,99,0.35)] bg-[var(--surface)]"
        >
          <div className="flex items-center gap-2 border-b border-[rgba(47,158,99,0.25)] bg-[rgba(47,158,99,0.10)] px-[14px] py-[8px] text-[12px] font-bold text-[var(--ink)]">
            <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#2f9e63]" />
            Final output
            {nodeName !== undefined && (
              <span className="min-w-0 truncate font-machine text-[10.5px] font-normal text-[var(--muted)]">
                {nodeName}
              </span>
            )}
          </div>
          <div className={CARD_BODY}>
            {body}
            {meta && <div className={META}>{meta}</div>}
          </div>
        </div>
      </div>
    );
  }

  // Agent: on the left, under its node name and its dot, in a soft card.
  const dot = color ?? (provider ? `var(--color-provider-${provider})` : 'var(--muted)');
  return (
    <div className={cn('flex w-full flex-col items-start gap-[6px]', className)}>
      {nodeName !== undefined && (
        <span className="flex min-w-0 items-center gap-[7px] text-[12.5px] font-bold text-[var(--ink)]">
          <span
            aria-hidden
            data-testid="message-agent-dot"
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: dot }}
          />
          <span className="truncate">{nodeName}</span>
        </span>
      )}
      <div
        data-testid="message-bubble"
        data-type={type}
        aria-label={TYPE_LABEL[type]}
        className={cn(
          'max-w-[92%] rounded-[12px] border border-[var(--line)] bg-[var(--soft)]',
          CARD_BODY,
        )}
      >
        {body}
        {meta && <div className={META}>{meta}</div>}
      </div>
    </div>
  );
}
