import type { Id } from '@ace/contracts';
import { Icons } from '@ace/ui';
import { useNavigate } from 'react-router-dom';

import { openChatThread } from '../chat/open-thread';
import { useChatThreads } from '../chat/useChat';
import { workflowPath } from '../forge/mode';
import { ago } from '../theme/format';

/**
 * PG-3.6: a node's two channels, linked. Domain shows a run's conversation; a node's direct chat
 * (Ideate's chat column) is a separate channel that never touches a run (FR-CHAT-005). In a node's
 * lens Domain lists that node's direct chat threads — read-only, each opening the chat column on
 * that thread in Ideate.
 */
export function NodeChatThreads({
  projectId,
  workflowId,
  nodeId,
  nodeName,
}: {
  projectId: string;
  workflowId: string;
  nodeId: Id;
  nodeName: string;
}) {
  const navigate = useNavigate();
  const threads = useChatThreads(nodeId);
  const list = threads.data ?? [];

  const open = (threadId: string) => {
    openChatThread(nodeId, threadId);
    navigate(`${workflowPath(projectId, workflowId, 'ideate')}?node=${encodeURIComponent(nodeId)}`);
  };

  return (
    <section
      aria-label={`Direct chats with ${nodeName}`}
      data-testid="domain-node-chats"
      className="relative flex flex-wrap items-center gap-[6px] border-b border-[var(--line)] px-6 py-[8px] text-[12px]"
    >
      <span className="font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]">
        Direct chats
      </span>
      {threads.isPending ? (
        <span className="text-[var(--muted)]">…</span>
      ) : list.length === 0 ? (
        <span className="text-[var(--muted)]" data-testid="domain-node-chats-empty">
          None with {nodeName} yet — they are in Ideate&apos;s chat column.
        </span>
      ) : (
        list.map((thread) => (
          <button
            key={thread.id}
            type="button"
            data-testid={`domain-node-chat-${thread.id}`}
            title="Open this chat in Ideate"
            onClick={() => open(thread.id)}
            className="flex h-[24px] max-w-[16rem] cursor-pointer items-center gap-[6px] rounded-full border border-[var(--line)] bg-transparent px-[9px] text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
          >
            <span className="min-w-0 truncate">{thread.title || 'New chat'}</span>
            <span className="font-machine text-[9px] font-normal text-[var(--muted)]">
              {ago(thread.updatedAt)}
            </span>
            <Icons.ArrowRight aria-hidden size={11} />
          </button>
        ))
      )}
    </section>
  );
}
