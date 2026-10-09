import type { Node } from '@ace/contracts';

import { useSelectionStore } from '../app/stores/selection';
import { useWorkflowGraph } from '../workflows/hooks';
import { ChatComposer } from './ChatComposer';
import { ChatConversation } from './ChatConversation';
import { ChatThreadList } from './ChatThreadList';
import { useChatSocket, useThreadConversation } from './useChat';

/**
 * The "Chat" tab of the phone layout (FR-CHAT-004..008, FR-MOB-003). It shows the session of the
 * one focused Agent or Model node — the same session the desktop Chat column shows (D285): its
 * direct chat and the goal and result of each run of it.
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
    return (
      <section aria-label="Direct chat" data-testid="chat-panel" className="p-4">
        <p className="text-sm text-fg-muted">Select an Agent or Model node to chat with it.</p>
      </section>
    );
  }

  if (!canChat) {
    return (
      <section aria-label="Direct chat" data-testid="chat-panel" className="p-4">
        <p className="text-sm text-fg-muted">
          Direct chat is available on Agent and Model nodes (FR-CHAT-004).
        </p>
      </section>
    );
  }

  return <ChatForNode key={node.id} node={node} />;
}

function ChatForNode({ node }: { node: Node }) {
  const convo = useThreadConversation(node.id);

  return (
    <section aria-label="Direct chat" data-testid="chat-panel" className="flex h-full flex-col">
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
        composer={
          <ChatComposer
            onSend={(content) => {
              if (content.length > 0) convo.send(content);
            }}
            disabled={convo.sending}
          />
        }
      />
    </section>
  );
}
