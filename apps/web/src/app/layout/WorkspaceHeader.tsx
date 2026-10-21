import type { Node } from '@ace/contracts';
import { cn } from '@ace/ui';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';

import type { WorkflowMode } from '../../forge/mode';
import { agentsOf } from '../../theme/agents';
import { Avatar, LogoMark, ThemeToggle } from '../../theme/primitives';
import { useWorkflowGraph } from '../../workflows/hooks';
import { SHORTCUTS, shortcutLabel } from '../shortcuts';
import { useLayoutStore } from '../stores/layout';
import { HeaderRunControls } from './HeaderRunControls';
import { ModeSwitch } from './ModeSwitch';

/**
 * The workspace header of `Ace Canvas.dc.html` (D330) on Ideate, Forge and Domain: the mark and
 * ACE (to Home), the run controls (PG-1.2, D360), the mode switch, the Chat or Team toggle (D356),
 * the workflow's agents and the theme toggle.
 *
 * Audit U-17: a workflow that cannot be loaded (not found, or the engine failed) has nothing to
 * run, switch or chat with, so the header keeps only the mark and the theme toggle around the
 * layout's message — no live Run controls for a workflow that is not there.
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
  const missing = useWorkflowGraph(workflowId).isError;
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
        {/* PG-1.2 (D360): the run controls in every mode, over D330's header layout. */}
        {!missing && <HeaderRunControls workflowId={workflowId} />}
      </div>
      <div className="flex items-center gap-2">
        {!missing && <ModeSwitch projectId={projectId} workflowId={workflowId} />}
      </div>
      <div className="flex items-center justify-end gap-2">
        {!missing && <SplitToggle mode={mode} />}
        <AgentStack workflowId={workflowId} />
        <ThemeToggle variant="workspace" />
      </div>
    </header>
  );
}

/**
 * D356 (amends D330/D336): two toggles where there was one Split — Chat, the chat column of Ideate
 * and Forge, and Team, Domain's Team aside — each remembered on its own, so closing one leaves the
 * other as it was. Each mode shows its own; Ctrl+Alt+B toggles it (bound by the workflow layout).
 */
function SplitToggle({ mode }: { mode: WorkflowMode }) {
  const team = mode === 'domain';
  const open = useLayoutStore((store) => (team ? store.teamOpen : store.chatOpen));
  const toggleChat = useLayoutStore((store) => store.toggleChat);
  const toggleTeam = useLayoutStore((store) => store.toggleTeam);
  const label = team ? 'Team' : 'Chat';
  return (
    <button
      type="button"
      data-testid={team ? 'team-toggle' : 'chat-toggle'}
      aria-pressed={open}
      aria-label={label}
      title={`${label} (${shortcutLabel(SHORTCUTS.toggleChat)})`}
      onClick={team ? toggleTeam : toggleChat}
      className={cn(
        'flex h-7 cursor-pointer items-center gap-[6px] rounded-[8px] border px-[10px] text-[11px] font-semibold text-[var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]',
        open
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
      {label}
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
