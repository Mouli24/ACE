import { rosterFor, slugHandle, type Node, type Part } from '@ace/contracts';
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { forwardRef, useEffect, type ComponentPropsWithoutRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { useLayoutStore } from '../app/stores/layout';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useWorkspaceStatus } from '../app/stores/workspace-status';
import { workflowPath } from '../forge/mode';
import { useSocketStatus } from '../runs/hooks';
import { agentsOf, type AgentLook } from '../theme/agents';
import { Avatar, Dot } from '../theme/primitives';
import { useWorkflowGraph } from '../workflows/hooks';
import { ChatComposer, type MentionTarget } from './ChatComposer';
import { ChatConversation } from './ChatConversation';
import { ChatThreadList } from './ChatThreadList';
import { useChatSessions } from './session-store';
import { sendToNode, useChatSocket, useThreadConversation } from './useChat';

const isChatNode = (node: Node): boolean => node.kind === 'agent' || node.kind === 'model';

/** Tabs drawn before the rest go under "More" (the theme's tabs row). */
const VISIBLE_TABS = 3;

const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/** A theme chat tab: 30px pill, ink border and surface when active (D335). */
const tabClass = (active: boolean) =>
  cn(
    FOCUS,
    'flex h-[30px] max-w-full cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-full border px-[10px] text-[11px] font-semibold text-[var(--ink)]',
    active ? 'border-[var(--ink)] bg-[var(--surface)]' : 'border-[var(--line)] bg-transparent',
  );

/** The tab's 16px avatar: white 8px initial on the colour (font weight from the tab, as drawn). */
function TabAvatar({ letter, color }: { letter: string; color: string }) {
  return <Avatar letter={letter} color={color} size={16} fontSize={8} className="font-semibold" />;
}

/** The tab's mono 9px muted sub-label. */
function TabSub({ children }: { children: string }) {
  return (
    <span className="font-machine text-[9px] font-normal text-[var(--muted)]">{children}</span>
  );
}

/** "More": the overflow tab, a menu trigger, so it forwards Radix's ref and props. */
const MoreTab = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & { active: boolean; count: number }
>(({ active, count, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    data-testid="chat-mention-more"
    className={tabClass(active)}
    {...props}
  >
    <TabAvatar letter="+" color="#7a62d6" />
    More
    <TabSub>{String(count)}</TabSub>
  </button>
));
MoreTab.displayName = 'MoreTab';

/**
 * The permanent 340 px Chat column (FR-CHAT-004..008, D285), in the theme's Team chat aside
 * (D335) — where every node's conversation and every model response is read. Each Agent or Model
 * node has a session of its own: its direct chat and the goal and result of each run of it. The
 * column shows one node's session at a time; it follows the node selected on the Canvas, a tab,
 * or an `@Name …` typed in the composer, and switching back finds the session exactly as it was
 * left. "Live" shows only while the socket is open. The compact layout keeps `ChatPanel`
 * (FR-MOB-003).
 */
export function ChatAside({ workflowId }: { workflowId: string }) {
  const chatNodeId = usePanelsStore((s) => s.chatNodeId);
  const chatWith = usePanelsStore((s) => s.chatWith);
  const toggleChat = useLayoutStore((s) => s.toggleChat);
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const graph = useWorkflowGraph(workflowId);
  const live = useSocketStatus() === 'open';
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const nodes = graph.data?.nodes;
  const chatNodes = (nodes ?? []).filter(isChatNode);
  const target = chatNodes.find((each) => each.id === chatNodeId);
  const agents = agentsOf(nodes ?? []);
  const handles = new Map(rosterFor(nodes ?? []).map((entry) => [entry.nodeId, entry.handle]));
  const handleOf = (agent: AgentLook) => handles.get(agent.nodeId) ?? slugHandle(agent.name);
  const projectId = graph.data?.workflow.projectId;

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

  // The footer's message count (D330): nothing to count without a target, or once the column goes.
  const hasTarget = target !== undefined;
  useEffect(() => {
    if (!hasTarget) useWorkspaceStatus.getState().setMessageCount(null);
  }, [hasTarget]);
  useEffect(() => () => useWorkspaceStatus.getState().setMessageCount(null), []);

  // One socket link for every session, so a reply owed to a node off screen still arrives.
  useChatSocket(target?.id);

  const mentionables: MentionTarget[] = agents.map((agent) => ({
    id: agent.nodeId,
    name: agent.name,
    handle: handleOf(agent),
    letter: agent.letter,
    color: agent.color,
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

  const sendToForge =
    projectId === undefined
      ? undefined
      : () => navigate(workflowPath(projectId, workflowId, 'forge'));

  const shown = agents.slice(0, VISIBLE_TABS);
  const overflow = agents.slice(VISIBLE_TABS);

  const tabs = (
    <div
      className="flex flex-wrap gap-[6px] border-b border-[var(--line)] px-[14px] pb-[12px]"
      data-testid="chat-mentions"
    >
      {shown.map((agent) => (
        <button
          key={agent.nodeId}
          type="button"
          data-testid={`chat-mention-${agent.nodeId}`}
          aria-pressed={agent.nodeId === chatNodeId}
          onClick={() => openSession(agent.nodeId)}
          className={tabClass(agent.nodeId === chatNodeId)}
        >
          <TabAvatar letter={agent.letter} color={agent.color} />
          <span className="min-w-0 truncate">{agent.name}</span>
          <TabSub>{`@${handleOf(agent)}`}</TabSub>
        </button>
      ))}
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <MoreTab
              active={overflow.some((agent) => agent.nodeId === chatNodeId)}
              count={overflow.length}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-testid="chat-mention-more-menu">
            {overflow.map((agent) => (
              <DropdownMenuItem
                key={agent.nodeId}
                data-testid={`chat-mention-${agent.nodeId}`}
                data-active={agent.nodeId === chatNodeId ? 'true' : 'false'}
                onSelect={() => openSession(agent.nodeId)}
                className={cn(agent.nodeId === chatNodeId && 'bg-[var(--hover)] font-semibold')}
              >
                <TabAvatar letter={agent.letter} color={agent.color} />
                <span className="min-w-0 truncate">{agent.name}</span>
                <span className="ml-auto pl-2">
                  <TabSub>{`@${handleOf(agent)}`}</TabSub>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
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
      mentionables={mentionables}
      onMention={openSession}
      hasTarget={hasTarget}
    />
  );

  return (
    <aside
      aria-label="Chat"
      data-testid="chat-aside"
      className="relative z-[4] flex h-full min-h-0 w-[340px] shrink-0 flex-col border-l border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]"
    >
      <div className="flex items-center gap-2 px-[14px] pb-[10px] pt-[14px]">
        <h2 className="text-[14px] font-bold tracking-[-0.01em]">Team chat</h2>
        {live && (
          <span
            data-testid="chat-live"
            className="flex items-center gap-1 text-[10px] font-semibold text-[#2f9e63]"
          >
            <Dot color="#2f9e63" size={6} pulse="livePulse 2s ease-in-out infinite" />
            Live
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          title="Close"
          aria-label="Close chat"
          data-testid="chat-close"
          onClick={toggleChat}
          className={cn(
            FOCUS,
            'h-7 w-7 shrink-0 cursor-pointer rounded-[7px] border border-[var(--line)] bg-transparent text-[12px] text-[var(--ink)]',
          )}
        >
          ✕
        </button>
      </div>

      {tabs}

      {target === undefined ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-[14px] py-[16px]">
          <p className="text-center text-[13px] text-[var(--muted)]">
            Select an Agent node on the Canvas, or mention one, to see its conversation and its
            results.
          </p>
        </div>
      ) : (
        // Keyed by node id: each session renders from its own state in the session store.
        <TargetChat key={target.id} node={target} onSendToForge={sendToForge} />
      )}
      {composer}
    </aside>
  );
}

function TargetChat({ node, onSendToForge }: { node: Node; onSendToForge?: () => void }) {
  const convo = useThreadConversation(node.id);
  const count = convo.messages.length;
  useEffect(() => {
    useWorkspaceStatus.getState().setMessageCount(count);
  }, [count]);
  return (
    <>
      <ChatThreadList
        nodeId={node.id}
        threads={convo.threads}
        activeThreadId={convo.threadId}
        onSelect={convo.selectThread}
        onNew={convo.newThread}
      />
      <ChatConversation node={node} convo={convo} onSendToForge={onSendToForge} />
    </>
  );
}
