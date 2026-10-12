import type { Node } from '@ace/contracts';
import { cn } from '@ace/ui';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';

import type { WorkflowMode } from '../../forge/mode';
import { agentsOf } from '../../theme/agents';
import { Avatar, LogoMark, ThemeToggle } from '../../theme/primitives';
import { useWorkflowGraph } from '../../workflows/hooks';
import { SHORTCUTS, shortcutLabel, useShortcuts } from '../shortcuts';
import { useLayoutStore } from '../stores/layout';
import { ModeSwitch } from './ModeSwitch';

/**
 * The workspace header of `Ace Canvas.dc.html` (D330) on Ideate, Forge and Domain: the mark and
 * ACE (to Home), the mode switch, Split, the workflow's agents and the theme toggle.
 */
export function WorkspaceHeader({
  projectId,
  workflowId,
  mode,
}: {
  projectId: string;
  workflowId: string;
  mode: WorkflowMode;
}) {
  return (
    <header className="relative z-[5] grid h-[44px] shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-[var(--line)] bg-[var(--hdr)] pl-5 pr-[14px]">
      <div className="flex items-center gap-[10px]">
        <Link
          to="/projects"
          className="flex items-center gap-2 rounded-[4px] text-[var(--ink)] no-underline hover:text-[var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
        >
          <LogoMark size={13} />
          <span className="text-[15px] font-bold tracking-[0.02em]">ACE</span>
        </Link>
      </div>
      <div className="flex items-center gap-2">
        <ModeSwitch projectId={projectId} workflowId={workflowId} />
      </div>
      <div className="flex items-center justify-end gap-2">
        <SplitToggle mode={mode} />
        <AgentStack workflowId={workflowId} />
        <ThemeToggle variant="workspace" />
      </div>
    </header>
  );
}

/**
 * Split: the chat column in Ideate and Forge, the Team aside in Domain — both are `chatOpen`
 * (D330). Domain sits outside the workflow layout, so its Ctrl+Alt+B is bound here.
 */
function SplitToggle({ mode }: { mode: WorkflowMode }) {
  const chatOpen = useLayoutStore((store) => store.chatOpen);
  const toggleChat = useLayoutStore((store) => store.toggleChat);
  useShortcuts([[SHORTCUTS.toggleChat, toggleChat]], mode === 'domain');
  const tag = mode === 'domain' ? 'TEAM' : 'CHAT';
  return (
    <button
      type="button"
      data-testid="chat-toggle"
      aria-pressed={chatOpen}
      aria-label={`${tag} Split`}
      title={`${mode === 'domain' ? 'Team' : 'Chat'} (${shortcutLabel(SHORTCUTS.toggleChat)})`}
      onClick={toggleChat}
      className={cn(
        'flex h-7 cursor-pointer items-center gap-[6px] rounded-[8px] border px-[10px] text-[11px] font-semibold text-[var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]',
        chatOpen
          ? 'border-[#ef6b3f] bg-[rgba(239,107,63,0.10)]'
          : 'border-[var(--line)] bg-transparent',
      )}
    >
      <span
        aria-hidden
        className="flex h-[10px] w-3 justify-end rounded-[2px] border-[1.5px] border-[#ef6b3f]"
      >
        <span className="w-1 bg-[#ef6b3f]" />
      </span>
      <span className="font-machine text-[9px] tracking-[0.08em] text-[var(--muted)]">{tag}</span>
      Split
    </button>
  );
}

/** One circle per agent (Agent and Model nodes, graph order), coloured by that order. */
function AgentStack({ workflowId }: { workflowId: string }) {
  const graph = useWorkflowGraph(workflowId);
  const nodes = graph.data?.nodes;
  const agents = useMemo(() => agentsOf((nodes ?? []) as Node[]), [nodes]);
  if (agents.length === 0) return null;
  return (
    <div role="list" aria-label="Agents" data-testid="agent-stack" className="flex">
      {agents.map((agent) => (
        <span
          key={agent.nodeId}
          role="listitem"
          data-testid={`agent-avatar-${agent.nodeId}`}
          className="relative -ml-[6px] flex"
        >
          <Avatar
            letter={agent.letter}
            color={agent.color}
            size={22}
            fontSize={10}
            className="shadow-[0_0_0_2px_var(--canvas)]"
          />
          <span className="sr-only">{agent.name}</span>
        </span>
      ))}
    </div>
  );
}
