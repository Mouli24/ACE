import type { Node } from '@ace/contracts';
import { useState } from 'react';

import { useSelectionStore } from '../app/stores/selection';
import { useWorkflowGraph } from '../workflows/hooks';
import { ChatConversation } from './ChatConversation';
import { ChatThreadList } from './ChatThreadList';
import { useChatThreads, useThreadConversation } from './useChat';

/**
 * The "Chat" tab of the phone layout (FR-CHAT-004..008, round 4 §5 item 5). It talks to the one
 * focused Agent or Model node using its model, instructions, context policy and tools, in threads
 * of its own that never read or write `runs`/`node_runs` (FR-CHAT-005) — this component fetches only
 * the graph (for the node's kind and name) and the chat endpoints, nothing from a run.
 *
 * It mirrors `Inspector`: given the open workflow it reads the focused node from the selection store,
 * so the tab wires in exactly as the Inspector does (see the report for the one-line wiring).
 */
export function ChatPanel({ workflowId }: { workflowId: string }) {
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const graph = useWorkflowGraph(workflowId);
  const node = graph.data?.nodes.find((each) => each.id === focusedNodeId);

  if (focusedNodeId === undefined || node === undefined) {
    return (
      <section aria-label="Direct chat" data-testid="chat-panel" className="p-4">
        <p className="text-sm text-fg-muted">Select an Agent or Model node to chat with it.</p>
      </section>
    );
  }

  if (node.kind !== 'agent' && node.kind !== 'model') {
    return (
      <section aria-label="Direct chat" data-testid="chat-panel" className="p-4">
        <p className="text-sm text-fg-muted">
          Direct chat is available on Agent and Model nodes (FR-CHAT-004).
        </p>
      </section>
    );
  }

  // Keyed by node id so switching nodes starts each agent's chat clean.
  return <ChatForNode key={node.id} node={node} />;
}

function ChatForNode({ node }: { node: Node }) {
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>();
  const threads = useChatThreads(node.id);
  const convo = useThreadConversation(node.id, activeThreadId, setActiveThreadId);

  return (
    <section aria-label="Direct chat" data-testid="chat-panel" className="flex h-full flex-col">
      <ChatThreadList
        nodeId={node.id}
        threads={threads.data ?? []}
        activeThreadId={activeThreadId}
        onSelect={setActiveThreadId}
        onNew={() => setActiveThreadId(undefined)}
        onDeleted={(threadId) => {
          if (threadId === activeThreadId) setActiveThreadId(undefined);
        }}
      />
      <ChatConversation node={node} convo={convo} />
    </section>
  );
}
