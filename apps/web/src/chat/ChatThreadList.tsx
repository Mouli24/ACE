import type { ChatThread } from '@ace/contracts';
import { Button } from '@ace/ui';
import { Plus, Trash2 } from 'lucide-react';

import { useDeleteThread } from './useChat';

/**
 * The thread switcher for one node's session (FR-CHAT-004, D285): start a new thread, pick an
 * earlier one, or delete one. A row of pills plus "New chat" so the conversation has the room in the 340 px column
 * (NFR-USE-03).
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
      className="flex flex-wrap items-center gap-1.5 border-b border-border px-3.5 py-2"
      data-testid="chat-thread-list"
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="chat-new-thread"
        onClick={onNew}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden /> New chat
      </Button>

      {threads.length > 0 && (
        <ul className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
          {threads.map((thread) => {
            const active = thread.id === activeThreadId;
            return (
              <li
                key={thread.id}
                className={`flex shrink-0 items-center gap-1 rounded-full border pl-2.5 pr-1.5 ${
                  active ? 'border-border-strong text-fg' : 'border-border text-fg-soft'
                }`}
              >
                <button
                  type="button"
                  data-testid={`chat-thread-${thread.id}`}
                  data-active={active ? 'true' : 'false'}
                  aria-current={active}
                  onClick={() => onSelect(thread.id)}
                  className="max-w-[9rem] truncate py-0.5 text-left font-machine text-[10.5px]"
                  title={thread.title}
                >
                  {thread.title || 'New chat'}
                </button>
                <button
                  type="button"
                  aria-label={`Delete chat ${thread.title || 'New chat'}`}
                  data-testid={`chat-delete-${thread.id}`}
                  // a session showing it falls back to the node's latest thread (useDeleteThread)
                  onClick={() => del.mutate(thread.id)}
                  className="text-fg-muted hover:text-danger"
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
