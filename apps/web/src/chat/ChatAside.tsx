import { rosterFor, slugHandle, type Node, type Part } from '@ace/contracts';
import {
  cn,
  Icons,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { forwardRef, useEffect, useState, type ComponentPropsWithoutRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useLayoutStore } from '../app/stores/layout';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useWorkspaceStatus } from '../app/stores/workspace-status';
import { DomainRunView } from '../domain/DomainPage';
import { RunConversationTab } from '../domain/RunConversationTab';
import { useWorkflowMode, workflowPath } from '../forge/mode';
import { useOpenInForge } from '../forge/open-in-forge';
import { useSocketStatus } from '../runs/hooks';
import { useSelectedRun } from '../runs/selected-run';
import { useWorkflowTask } from '../runs/useWorkflowTask';
import { agentMap, agentsOf, type AgentLook } from '../theme/agents';
import { Avatar, Dot } from '../theme/primitives';
import { useWorkflowGraph } from '../workflows/hooks';
import { ChatComposer, type ChatRosterEntry } from './ChatComposer';
import { ChatConversation } from './ChatConversation';
import { ChatThreadList } from './ChatThreadList';
import { useRestoreLastChat } from './last-chat';
import { owedTurns, useChatSessions } from './session-store';
import { sendToNode, stopNode, useThreadConversation } from './useChat';
import { isChatNode, useDropStaleChatTarget } from './workflow-target';

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
 * column shows one node's session at a time; it follows the node selected on the Canvas or a tab,
 * and switching back finds the session exactly as it was left. D302: that node is the
 * conversation's main node; an `@handle` in a message asks another node of the workflow inside the
 * same conversation, and the session does not switch. "Live" shows only while the socket is open.
 * The compact layout keeps `ChatPanel` (FR-MOB-003).
 */
export function ChatAside({
  workflowId,
  expanded = false,
}: {
  workflowId: string;
  /**
   * D367: the same chat, full screen in Domain. It opens on the tab the column had (`?chat=`), so
   * Expand loses no message; Collapse goes back to the mode it came from.
   */
  expanded?: boolean;
}) {
  const chatNodeId = usePanelsStore((s) => s.chatNodeId);
  const chatWith = usePanelsStore((s) => s.chatWith);
  const toggleChat = useLayoutStore((s) => s.toggleChat);
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const graph = useWorkflowGraph(workflowId);
  const live = useSocketStatus() === 'open';
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const mode = useWorkflowMode();
  // D367: Domain is this chat expanded; it opens on the Run tab unless Expand named the node tab.
  const startView = search.get('chat') === 'node' ? 'node' : 'run';
  const queryClient = useQueryClient();
  // PG-3.6: which channel the column shows — the node's direct chat, or the run's conversation.
  const [view, setView] = useState<'node' | 'run'>(expanded ? startView : 'node');
  // `@workflow <task>`: the whole workflow runs on the task, and the Run tab shows it working.
  const workflowTask = useWorkflowTask(workflowId);

  const nodes = graph.data?.nodes;
  const chatNodes = (nodes ?? []).filter(isChatNode);
  const target = chatNodes.find((each) => each.id === chatNodeId);
  const agents = agentsOf(nodes ?? []);
  const roster = rosterFor(nodes ?? []);
  const handles = new Map(roster.map((entry) => [entry.nodeId, entry.handle]));
  const handleOf = (agent: AgentLook) => handles.get(agent.nodeId) ?? slugHandle(agent.name);
  const projectId = graph.data?.workflow.projectId;
  const showRun = view === 'run' && projectId !== undefined;

  // The chat follows the Canvas: selecting an Agent or Model node opens its session (D285).
  const focusedCanChat = chatNodes.some((each) => each.id === focusedNodeId);
  useEffect(() => {
    if (focusedNodeId === undefined || !focusedCanChat) return;
    if (usePanelsStore.getState().chatNodeId !== focusedNodeId) chatWith(focusedNodeId);
  }, [focusedNodeId, focusedCanChat, chatWith]);

  // The target left the graph (or cannot chat): back to the intro state. The workflow layout runs
  // the same guard with the column closed (fix F-I2); here it keeps the column right on its own.
  useDropStaleChatTarget(workflowId);
  // D372: after a reload, reopen the node this workflow's chat was last with.
  useRestoreLastChat(workflowId, chatNodes);

  // The footer's message count (D330): nothing to count without a target, or once the column goes.
  const hasTarget = target !== undefined;
  useEffect(() => {
    if (!hasTarget) useWorkspaceStatus.getState().setMessageCount(null);
  }, [hasTarget]);
  useEffect(() => () => useWorkspaceStatus.getState().setMessageCount(null), []);

  // The chat socket — one link for every session — is the workflow layout's (D354), so a reply
  // still arrives with this column closed or in Domain.

  const looks = agentMap(nodes ?? []);
  const chatRoster: ChatRosterEntry[] = roster.map((entry) => ({
    ...entry,
    letter: looks.get(entry.nodeId)?.letter ?? entry.name.slice(0, 1).toUpperCase(),
    color: looks.get(entry.nodeId)?.color ?? '#ef6b3f',
  }));

  /**
   * Show one node's session, and select that node on the Canvas too: the chat and the Canvas then
   * agree on which node is in focus, so clicking any other card brings that card's session back.
   */
  const openSession = (nodeId: string) => {
    if (usePanelsStore.getState().chatNodeId !== nodeId) chatWith(nodeId);
    if (useSelectionStore.getState().focusedNodeId !== nodeId) {
      useSelectionStore.getState().setSelection([nodeId], []);
    }
  };

  /**
   * D302: a message goes into the main node's conversation; an `@handle` names the node that
   * answers it there. The session stays where it is.
   */
  const send = (content: Part[], targetNodeId: string | undefined) => {
    if (target === undefined || content.length === 0) return;
    void sendToNode(queryClient, target.id, content, targetNodeId);
  };

  /** A run turn's "See the whole run →": that run selected (`?run=`), on the Run tab. */
  const selectedRun = useSelectedRun(workflowId);
  const openRun = (runId: string) => {
    selectedRun.select(runId);
    setView('run');
  };

  const openInForge = useOpenInForge(projectId, workflowId);

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
  // PG-1.6: a reply on its way in the shown session can be stopped from the composer — D391:
  // until the last turn the session sent is answered, not just the first.
  const replying = useChatSessions((state) =>
    target === undefined ? false : state.sessions[target.id]?.pending !== undefined,
  );
  // D391: the turns sent after the one being answered, still in the engine's queue.
  const queued = useChatSessions((state) =>
    target === undefined ? 0 : Math.max(0, owedTurns(state.sessions[target.id] ?? {}).length - 1),
  );

  // One composer for the whole column, never remounted: switching nodes keeps the text typed so
  // far, its chips and the keyboard focus while the conversation above it changes.
  const composer = (
    <ChatComposer
      onSend={send}
      disabled={sending}
      roster={chatRoster}
      mainNodeId={target?.id}
      replying={replying}
      queued={queued}
      onStop={() => {
        if (target !== undefined) void stopNode(queryClient, target.id);
      }}
      onWorkflow={(task, extra) => {
        workflowTask.start(task, extra).then(
          (run) => {
            // The run is selected (`?run=`); its conversation, then its result, is on the Run tab.
            if (run !== undefined) setView('run');
          },
          (error: unknown) =>
            toast.error(error instanceof Error ? error.message : 'The run could not be started.'),
        );
      }}
      workflowBlocked={workflowTask.blocked}
    />
  );

  return (
    <aside
      aria-label="Chat"
      data-testid="chat-aside"
      className={cn(
        'relative z-[4] flex h-full min-h-0 flex-col bg-[var(--panel)] text-[var(--ink)]',
        expanded ? 'w-full min-w-0 flex-1' : 'w-[340px] shrink-0 border-l border-[var(--line)]',
      )}
    >
      <div className="flex items-center gap-2 px-[14px] pb-[10px] pt-[14px]">
        <h2 className="text-[14px] font-bold tracking-[-0.01em]">Team chat</h2>
        {live && (
          <span
            data-testid="chat-live"
            className="flex items-center gap-1 text-[10px] font-semibold text-[var(--ok-ink)]"
          >
            <Dot color="#2f9e63" size={6} pulse="livePulse 2s ease-in-out infinite" />
            Live
          </span>
        )}
        <div className="flex-1" />
        {projectId !== undefined && (
          // D367: Domain is opened from here, full screen, showing this same chat and tab — the
          // header switch no longer offers it. Expanded, the button collapses back.
          <button
            type="button"
            title={expanded ? 'Collapse' : 'Expand to Domain'}
            aria-label={expanded ? 'Collapse chat' : 'Expand chat to Domain'}
            data-testid={expanded ? 'chat-collapse' : 'chat-expand'}
            onClick={() => {
              if (expanded) {
                const back = search.get('from') === 'forge' ? 'forge' : 'ideate';
                navigate(workflowPath(projectId, workflowId, back, search));
                return;
              }
              const path = workflowPath(projectId, workflowId, 'domain', search);
              const extra = new URLSearchParams({
                chat: view,
                from: mode === 'forge' ? 'forge' : 'ideate',
              });
              navigate(`${path}${path.includes('?') ? '&' : '?'}${extra.toString()}`);
            }}
            className={cn(
              FOCUS,
              'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border border-[var(--line)] bg-transparent text-[var(--ink)]',
            )}
          >
            {expanded ? (
              <Icons.Minimize2 aria-hidden size={13} />
            ) : (
              <Icons.Maximize2 aria-hidden size={13} />
            )}
          </button>
        )}
        {!expanded && (
          <button
            type="button"
            title="Close"
            aria-label="Close chat"
            data-testid="chat-close"
            onClick={toggleChat}
            className={cn(
              FOCUS,
              'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border border-[var(--line)] bg-transparent text-[var(--ink)]',
            )}
          >
            <Icons.X aria-hidden size={13} />
          </button>
        )}
      </div>

      {/* PG-3.6: the node's direct chat, or the selected run's team conversation (read-only). */}
      <div
        role="tablist"
        aria-label="Chat channel"
        className="flex gap-[6px] px-[14px] pb-[10px]"
        data-testid="chat-channel"
      >
        {(['node', 'run'] as const).map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={view === each}
            data-testid={`chat-channel-${each}`}
            onClick={() => setView(each)}
            className={tabClass(view === each)}
          >
            {each === 'node' ? 'Node chat' : 'Run'}
          </button>
        ))}
      </div>

      {/* D367: expanded, the Run tab is Domain itself — the live run conversation and its team. */}
      {showRun &&
        (expanded ? (
          <div className="flex min-h-0 flex-1">
            <DomainRunView />
          </div>
        ) : (
          <RunConversationTab projectId={projectId} workflowId={workflowId} />
        ))}
      {/* Hidden, not unmounted, behind the Run tab: the composer keeps what was typed (D335). */}
      <div className={showRun ? 'hidden' : 'contents'}>
        {tabs}

        {target === undefined ? (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-[14px] py-[16px]">
            <p className="text-center text-[13px] text-[var(--muted)]">
              Select an Agent node on the Canvas, or pick one above, to see its conversation and its
              results.
            </p>
          </div>
        ) : (
          // Keyed by node id: each session renders from its own state in the session store.
          <TargetChat
            key={target.id}
            node={target}
            onOpenInForge={openInForge}
            speakers={looks}
            projectId={projectId}
            onOpenRun={openRun}
          />
        )}
        {composer}
      </div>
      {workflowTask.dialog}
    </aside>
  );
}

function TargetChat({
  node,
  onOpenInForge,
  speakers,
  projectId,
  onOpenRun,
}: {
  node: Node;
  onOpenInForge?: (paths: readonly string[], runId?: string) => void;
  speakers: ReadonlyMap<string, AgentLook>;
  projectId: string | undefined;
  onOpenRun: (runId: string) => void;
}) {
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
      <ChatConversation
        node={node}
        convo={convo}
        {...(onOpenInForge === undefined ? {} : { openInForge: onOpenInForge })}
        speakers={speakers}
        onOpenRun={onOpenRun}
        {...(projectId === undefined ? {} : { projectId })}
      />
    </>
  );
}
