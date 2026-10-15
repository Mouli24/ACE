import { rosterFor, type Node } from '@ace/contracts';
import type { ReactNode } from 'react';

import { useSelectionStore } from '../app/stores/selection';
import { agentMap } from '../theme/agents';
import { useWorkflowGraph } from '../workflows/hooks';
import { ChatComposer, type ChatRosterEntry } from './ChatComposer';
import { ChatConversation } from './ChatConversation';
import { ChatThreadList } from './ChatThreadList';
import { useChatSocket, useThreadConversation } from './useChat';

/** The theme's empty state: one muted 13px line, centred (D328). */
function Empty({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Direct chat"
      data-testid="chat-panel"
      className="flex h-full items-center justify-center bg-[var(--panel)] p-4"
    >
      <p className="text-center text-[13px] text-[var(--muted)]">{children}</p>
    </section>
  );
}

/**
 * The "Chat" tab of the phone layout (FR-CHAT-004..008, FR-MOB-003). It shows the session of the
 * one focused Agent or Model node — the same session the desktop Chat column shows (D285): its
 * direct chat and the goal and result of each run of it. The theme does not draw a phone layout,
 * so it wears the aside's rows and composer on the panel colour (D335).
 *
 * It mirrors `Inspector`: given the open workflow it reads the focused node from the selection store,
 * so the tab wires in exactly as the Inspector does.
 */
export function ChatPanel({ workflowId }: { workflowId: string }) {
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const graph = useWorkflowGraph(workflowId);
  const node = graph.data?.nodes.find((each) => each.id === focusedNodeId);
  const canChat = node !== undefined && (node.kind === 'agent' || node.kind === 'model');
  useChatSocket(canChat ? node.id : undefined);

  if (focusedNodeId === undefined || node === undefined) {
    return <Empty>Select an Agent or Model node to chat with it.</Empty>;
  }

  if (!canChat) {
    return <Empty>Direct chat is available on Agent and Model nodes (FR-CHAT-004).</Empty>;
  }

  return <ChatForNode key={node.id} node={node} nodes={graph.data?.nodes ?? []} />;
}

function ChatForNode({ node, nodes }: { node: Node; nodes: readonly Node[] }) {
  const convo = useThreadConversation(node.id);
  // D302: `@handle` asks another node of the workflow here too, in this same session.
  const looks = agentMap(nodes);
  const roster: ChatRosterEntry[] = rosterFor(nodes).map((entry) => ({
    ...entry,
    letter: looks.get(entry.nodeId)?.letter ?? entry.name.slice(0, 1).toUpperCase(),
    color: looks.get(entry.nodeId)?.color ?? '#ef6b3f',
  }));

  return (
    <section
      aria-label="Direct chat"
      data-testid="chat-panel"
      className="flex h-full flex-col bg-[var(--panel)] text-[var(--ink)]"
    >
      <ChatThreadList
        nodeId={node.id}
        threads={convo.threads}
        activeThreadId={convo.threadId}
        onSelect={convo.selectThread}
        onNew={convo.newThread}
      />
      <ChatConversation
        node={node}
        convo={convo}
        speakers={looks}
        composer={
          <ChatComposer
            onSend={(content, targetNodeId) => {
              if (content.length > 0) convo.send(content, targetNodeId);
            }}
            disabled={convo.sending}
            placeholder="Message this agent…"
            roster={roster}
            mainNodeId={node.id}
            replying={convo.awaitingReply}
            onStop={convo.stop}
          />
        }
      />
    </section>
  );
}
