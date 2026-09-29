import type { Message, ProviderType } from '@ace/contracts';
import { MessageBubble, type ContentUrl } from '@ace/ui';

/**
 * The timeline's scrollable message list (round 4 §5 item 4, FR-CHAT-001). Each row is a
 * `MessageBubble`, styled by its `MessageType`, so the six kinds read differently on sight; a
 * message that names a node carries the node name and its provider's accent.
 *
 * Virtualization without a dependency (M4 §5 item 4: "5,000 messages smooth"): every row is a CSS
 * containment boundary with `content-visibility: auto`, so the browser skips the layout and paint of
 * any row outside the viewport and reserves its space with `contain-intrinsic-size`. The rows stay
 * in the DOM — so find-in-page, a screen reader and keyboard focus still see the whole
 * conversation — while the render cost tracks what is on screen rather than the length of the list.
 */

export interface TimelineRow {
  message: Message;
  nodeName?: string;
  provider?: ProviderType;
}

export interface TimelineListProps {
  rows: readonly TimelineRow[];
  /** Turns a file/media part's artifact id into a URL the browser can load (the SDK's helper). */
  contentUrl?: ContentUrl;
  /** Shown when the list is empty — either "no messages yet" or "nothing matches this filter". */
  emptyLabel?: string;
  className?: string;
}

export function TimelineList({ rows, contentUrl, emptyLabel, className }: TimelineListProps) {
  if (rows.length === 0) {
    return (
      <p className="p-4 font-human text-sm text-fg-muted" data-testid="timeline-empty">
        {emptyLabel ?? 'No messages yet. Run the workflow or send a message and it appears here.'}
      </p>
    );
  }

  return (
    <ol
      data-testid="timeline-list"
      className={['flex flex-col gap-3 p-3', className].filter(Boolean).join(' ')}
    >
      {rows.map(({ message, nodeName, provider }) => (
        <li
          key={message.id}
          data-testid={`timeline-message-${message.id}`}
          data-type={message.type}
          {...(message.nodeId === undefined ? {} : { 'data-node-id': message.nodeId })}
          {...(message.runId === undefined ? {} : { 'data-run-id': message.runId })}
          // The windowing: reserve ~64px so the scrollbar is stable, then let the browser skip
          // offscreen rows entirely. The reserved size is a hint, not a clamp — a tall image row
          // still expands once it scrolls in.
          style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 64px' }}
        >
          <MessageBubble
            type={message.type}
            content={message.content}
            {...(contentUrl === undefined ? {} : { contentUrl })}
            {...(nodeName === undefined ? {} : { nodeName })}
            {...(provider === undefined ? {} : { provider })}
            meta={new Date(message.at).toLocaleTimeString()}
          />
        </li>
      ))}
    </ol>
  );
}
