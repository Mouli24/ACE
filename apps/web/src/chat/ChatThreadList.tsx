import type { ChatThread } from '@ace/contracts';
import { Button } from '@ace/ui';
import { Plus, Trash2 } from 'lucide-react';

import { useDeleteThread } from './useChat';

/**
 * The thread switcher for one agent (FR-CHAT-004): start a new thread, pick an existing one, or
 * delete one. Kept to a compact strip so the conversation has the room at 380 px (NFR-USE-03).
 */
export function ChatThreadList({
  nodeId,
  threads,
  activeThreadId,
  onSelect,
  onNew,
  onDeleted,
}: {
  nodeId: string;
  threads: ChatThread[];
  activeThreadId: string | undefined;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onDeleted: (threadId: string) => void;
}) {
  const del = useDeleteThread(nodeId);

  return (
    <div className="flex flex-col gap-1 border-b border-border p-2" data-testid="chat-thread-list">
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
        <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
          {threads.map((thread) => {
            const active = thread.id === activeThreadId;
            return (
              <li key={thread.id} className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid={`chat-thread-${thread.id}`}
                  data-active={active ? 'true' : 'false'}
                  aria-current={active}
                  onClick={() => onSelect(thread.id)}
                  className={`flex-1 truncate rounded-md px-2 py-1 text-left text-xs ${
                    active ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-border/40'
                  }`}
                  title={thread.title}
                >
                  {thread.title || 'New chat'}
                </button>
                <button
                  type="button"
                  aria-label={`Delete chat ${thread.title || 'New chat'}`}
                  data-testid={`chat-delete-${thread.id}`}
                  onClick={() =>
                    del.mutate(thread.id, { onSuccess: () => onDeleted(thread.id) })
                  }
                  className="text-fg-muted hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
