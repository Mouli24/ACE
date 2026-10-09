import type { Node, Part } from '@ace/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useProviders } from '../providers/hooks';
import { useWorkflowGraph } from '../workflows/hooks';
import { ChatComposer, type MentionTarget } from './ChatComposer';
import { ChatConversation } from './ChatConversation';
import { ChatThreadList } from './ChatThreadList';
import { useChatSessions } from './session-store';
import { sendToNode, useChatSocket, useThreadConversation } from './useChat';

const isChatNode = (node: Node): boolean => node.kind === 'agent' || node.kind === 'model';

/** The provider dot: a CSS variable so Night and Paper each use their own colour. */
function Dot({ providerType }: { providerType: string | undefined }) {
  return (
    <span
      aria-hidden
      className="h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ background: `var(--color-provider-${providerType ?? 'mock'})` }}
    />
  );
}

/**
 * The permanent 340 px Chat column (FR-CHAT-004..008, D285) — where every node's conversation and
 * every model response is read. Each Agent or Model node has a session of its own: its direct chat
 * and the goal and result of each run of it. The column shows one node's session at a time; it
 * follows the node selected on the Canvas, an `@mention` chip, or an `@Name …` typed in the
 * composer, and switching back finds the session exactly as it was left. The compact layout keeps
 * `ChatPanel` (FR-MOB-003).
 */
export function ChatAside({ workflowId }: { workflowId: string }) {
  const chatNodeId = usePanelsStore((s) => s.chatNodeId);
  const chatWith = usePanelsStore((s) => s.chatWith);
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const graph = useWorkflowGraph(workflowId);
  const providers = useProviders();
  const queryClient = useQueryClient();

  const nodes = graph.data?.nodes;
  const chatNodes = (nodes ?? []).filter(isChatNode);
  const target = chatNodes.find((each) => each.id === chatNodeId);
  const providerType = (node: Node) => {
    const providerId = 'providerId' in node.config ? node.config.providerId : undefined;
    return providers.data?.find((each) => each.id === providerId)?.type;
  };

  // The chat follows the Canvas: selecting an Agent or Model node opens its session (D285).
  const focusedCanChat = chatNodes.some((each) => each.id === focusedNodeId);
  useEffect(() => {
    if (focusedNodeId === undefined || !focusedCanChat) return;
    if (usePanelsStore.getState().chatNodeId !== focusedNodeId) chatWith(focusedNodeId);
  }, [focusedNodeId, focusedCanChat, chatWith]);

  // The target left the graph (or cannot chat): back to the intro state.
  useEffect(() => {
    if (nodes !== undefined && chatNodeId !== undefined && target === undefined)
      chatWith(undefined);
  }, [nodes, chatNodeId, target, chatWith]);

  // One socket link for every session, so a reply owed to a node off screen still arrives.
  useChatSocket(target?.id);

  const mentionables: MentionTarget[] = chatNodes.map((node) => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    providerType: providerType(node),
  }));

  /**
   * Show one node's session, and select that node on the Canvas too: the chat and the Canvas then
   * agree on which node is in focus, so clicking any other card — even the one that was selected
   * before an `@mention` moved the chat — brings that card's session back.
   */
  const openSession = (nodeId: string) => {
    if (usePanelsStore.getState().chatNodeId !== nodeId) chatWith(nodeId);
    if (useSelectionStore.getState().focusedNodeId !== nodeId) {
      useSelectionStore.getState().setSelection([nodeId], []);
    }
  };

  /** A message goes to the node it `@mentions`, or else to the node on screen. */
  const send = (content: Part[], mentioned: string | undefined) => {
    const nodeId = mentioned ?? target?.id;
    if (nodeId === undefined) return;
    openSession(nodeId);
    if (content.length > 0) void sendToNode(queryClient, nodeId, content);
  };

  const chips = (
    <div className="flex flex-wrap gap-[5px]" data-testid="chat-mentions">
      {chatNodes.map((node) => (
        <button
          key={node.id}
          type="button"
          data-testid={`chat-mention-${node.id}`}
          aria-pressed={node.id === chatNodeId}
          onClick={() => openSession(node.id)}
          className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-[9px] font-machine text-[10.5px] hover:border-border-strong hover:text-fg ${
            node.id === chatNodeId ? 'border-border-strong text-fg' : 'border-border text-fg-soft'
          }`}
        >
          <Dot providerType={providerType(node)} />@{node.name}
        </button>
      ))}
    </div>
  );

  const sending = useChatSessions((state) =>
    target === undefined ? false : state.sessions[target.id]?.sending === true,
  );

  // One composer for the whole column, never remounted: picking a node with `@` keeps the text
  // typed so far and the keyboard focus while the conversation above it changes.
  const composer = (
    <ChatComposer
      onSend={send}
      disabled={sending}
      placeholder={
        target === undefined ? 'Message a node — type @ to pick one' : `Message @${target.name}`
      }
      above={chips}
      mentionables={mentionables}
      onMention={openSession}
      hasTarget={target !== undefined}
    />
  );

  return (
    <aside
      aria-label="Chat"
      data-testid="chat-aside"
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-panel"
    >
      <div className="flex items-baseline justify-between gap-2.5 border-b border-border px-[18px] pb-3 pt-4">
        <h2 className="min-w-0 truncate text-[19px] font-semibold">
          Chat
          {target !== undefined && (
            <span data-testid="chat-target" className="font-normal text-fg-soft">
              {' '}
              · {target.name}
            </span>
          )}
        </h2>
        <span className="shrink-0 font-machine text-[9.5px] tracking-[0.06em] text-fg-faint">
          @ a node to talk to it
        </span>
      </div>

      {target === undefined ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] py-4">
          <div className="max-w-[92%] self-start rounded-[14px_14px_14px_4px] border border-border bg-canvas px-[13px] py-[9px] text-[14.5px] text-fg-soft">
            Select an Agent node on the Canvas, or mention one, to see its conversation and its
            results.
          </div>
        </div>
      ) : (
        // Keyed by node id: each session renders from its own state in the session store.
        <TargetChat key={target.id} node={target} />
      )}
      {composer}
    </aside>
  );
}

function TargetChat({ node }: { node: Node }) {
  const convo = useThreadConversation(node.id);
  return (
    <>
      <ChatThreadList
        nodeId={node.id}
        threads={convo.threads}
        activeThreadId={convo.threadId}
        onSelect={convo.selectThread}
        onNew={convo.newThread}
      />
      <ChatConversation node={node} convo={convo} />
    </>
  );
}
