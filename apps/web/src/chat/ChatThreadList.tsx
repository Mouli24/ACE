import type { ChatThread } from '@ace/contracts';
import { cn } from '@ace/ui';

import { useDeleteThread } from './useChat';

/** A 24px pill in the theme's tokens; the focus ring is the theme's orange. */
const PILL =
  'flex h-[24px] shrink-0 items-center rounded-full border text-[11px] font-semibold text-[var(--ink)]';
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/**
 * The thread switcher for one node's session (FR-CHAT-004, D285): start a new thread, pick an
 * earlier one, or delete one. The theme has no thread list (D335), so it is a compact row of the
 * theme's pills under the tabs, leaving the conversation the room in the 340 px column.
 */
export function ChatThreadList({
  nodeId,
  threads,
  activeThreadId,
  onSelect,
  onNew,
}: {
  nodeId: string;
  /** Most recently used first. */
  threads: ChatThread[];
  activeThreadId: string | undefined;
  onSelect: (threadId: string) => void;
  onNew: () => void;
}) {
  const del = useDeleteThread(nodeId);

  return (
    <div
      className="flex items-center gap-[6px] border-b border-[var(--line)] px-[14px] py-[8px]"
      data-testid="chat-thread-list"
    >
      <button
        type="button"
        data-testid="chat-new-thread"
        onClick={onNew}
        className={cn(
          PILL,
          FOCUS,
          'cursor-pointer whitespace-nowrap border-[var(--line)] bg-[var(--chip)] px-[9px] hover:bg-[var(--hover)]',
        )}
      >
        New chat
      </button>

      {threads.length > 0 && (
        <ul className="flex min-w-0 flex-1 gap-[6px] overflow-x-auto">
          {threads.map((thread) => {
            const active = thread.id === activeThreadId;
            const title = thread.title || 'New chat';
            return (
              <li
                key={thread.id}
                className={cn(
                  PILL,
                  'gap-[4px] pl-[9px] pr-[6px]',
                  active
                    ? 'border-[var(--ink)] bg-[var(--surface)]'
                    : 'border-[var(--line)] bg-transparent',
                )}
              >
                <button
                  type="button"
                  data-testid={`chat-thread-${thread.id}`}
                  data-active={active ? 'true' : 'false'}
                  aria-current={active}
                  onClick={() => onSelect(thread.id)}
                  className={cn(
                    FOCUS,
                    'max-w-[9rem] cursor-pointer truncate rounded-full text-left',
                    active ? 'text-[var(--ink)]' : 'text-[var(--muted)]',
                  )}
                  title={thread.title}
                >
                  {title}
                </button>
                <button
                  type="button"
                  aria-label={`Delete chat ${title}`}
                  data-testid={`chat-delete-${thread.id}`}
                  // a session showing it falls back to the node's latest thread (useDeleteThread)
                  onClick={() => del.mutate(thread.id)}
                  className={cn(
                    FOCUS,
                    'flex h-[16px] w-[16px] cursor-pointer items-center justify-center rounded-full text-[9px] text-[var(--muted)] hover:text-[#c94c27]',
                  )}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
