import {
  rosterFor,
  type FailureReason,
  type HaltReason,
  type Id,
  type NodeState,
  type RosterEntry,
  type Run,
  type RunState,
  type RunSummary,
} from '@ace/contracts';
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icons,
} from '@ace/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useFollowNode } from '../app/follow-node';
import { useLayoutStore } from '../app/stores/layout';
import { useWorkspaceStatus } from '../app/stores/workspace-status';
import { openFile } from '../forge/editor/actions';
import { workflowPath } from '../forge/mode';
import { useProject } from '../projects/hooks';
import { useIsCompact } from '../responsive/useIsCompact';
import { RunApprovalsDock } from '../runs/approvals/RunApprovalsDock';
import { useEndRun, useNodeRuns, useRetryNodeRun, useRun, useStartRun } from '../runs/hooks';
import { useSelectedRun } from '../runs/selected-run';
import { clockTime } from '../theme/format';
import { Avatar } from '../theme/primitives';
import { Composer } from './Composer';
import { orderedMessages } from './conversation-state';
import { Conversation, DomainEmpty } from './Conversation';
import {
  isLiveRun,
  useDomainConversation,
  usePostRunMessage,
  useRouteEnvelope,
  useSetRunBudget,
} from './hooks';
import { domainLooks, haltWords, lookOf, plural } from './looks';
import { NodeChatThreads } from './NodeChatThreads';
import { useDomainRunOverlay, withRunOverlay } from './run-overlay';
import { TeamPanel } from './TeamPanel';

/**
 * Domain (D303–D327) in the theme's team-chat view (D336): a run as its team's conversation — who
 * did what, what went to whom, who is stuck, and what it cost. `?run=` picks the run (the live one
 * by default), `?node=` a node's lens (the header's filter pills). A run that has ended opens
 * read-only. The Team aside follows the header's Team toggle (D356). Since D354 it sits inside the
 * workflow layout, which hides its chat column here; the run is the one selected run (PG-3.2) and
 * its node states and tokens are the run overlay's (PG-3.3).
 */
export function DomainRunView() {
  const { projectId = '', workflowId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // D354: the mode keys and the sockets are the workflow layout's; Domain registers none itself.
  const teamOpen = useLayoutStore((s) => s.teamOpen);
  const toggleTeam = useLayoutStore((s) => s.toggleTeam);
  // PG-3.7: at phone width the Team aside is a sheet over the chat, opened from the header.
  const compact = useIsCompact();
  const [teamSheet, setTeamSheet] = useState(false);
  const project = useProject(projectId);
  // PG-3.2: the one selected run — the live one by default, else the newest; `?run=new` none.
  const selected = useSelectedRun(workflowId);
  const node = params.get('node') ?? undefined;
  const runId = selected.runId;
  const run = useRun(runId);
  // PG-4.1/PG-4.5: the node runs behind the messages — envelopes as delivered, memory, reuse.
  const nodeRuns = useNodeRuns(runId);
  // PG-3.3: the overlay every mode reads hears the run end first; the record follows its refetch.
  const overlay = useDomainRunOverlay(runId);
  const overlayEnded =
    overlay.held && (overlay.status === 'COMPLETE' || overlay.status === 'HALTED');
  const live = run.data !== undefined && isLiveRun(run.data) && !overlayEnded;
  const roster: RosterEntry[] = useMemo(
    () => (run.data === undefined ? [] : rosterFor(run.data.snapshot.nodes)),
    [run.data],
  );
  /** Every node's name, so a node with no handle (an Input, an Output) is named, not an id. */
  const names = useMemo(
    () => new Map((run.data?.snapshot.nodes ?? []).map((each) => [each.id, each.name])),
    [run.data],
  );
  /** Each agent's colour and letter, as the canvas has them (D328), and its model. */
  const looks = useMemo(() => domainLooks(run.data?.snapshot.nodes ?? []), [run.data]);

  // Read once the run is known, so the page knows whether it is live before it shows anything.
  const conversation = useDomainConversation(run.data?.id, {
    ...(node === undefined ? {} : { node }),
    live,
  });
  const { byId } = conversation;
  const messages = useMemo(() => orderedMessages({ byId }), [byId]);
  // PG-3.3: node states and tokens come from the run overlay, as in Ideate and Forge.
  const usage = useMemo(
    () => withRunOverlay(conversation.usage, overlay),
    [conversation.usage, overlay],
  );
  const states: Record<Id, NodeState> = useMemo(
    () => Object.fromEntries((usage?.perNode ?? []).map((entry) => [entry.nodeId, entry.state])),
    [usage],
  );
  /**
   * PG-4.2: why each failed node failed — the newest node run's `failureReason` on record, with
   * the overlay's (ahead of the refetch) over it — so the Team aside says which failure it was.
   */
  const failureReasons = useMemo(() => {
    const reasons = new Map<Id, FailureReason>();
    for (const record of nodeRuns.data ?? []) {
      if (record.failureReason === undefined) reasons.delete(record.nodeId);
      else reasons.set(record.nodeId, record.failureReason);
    }
    for (const [nodeId, reason] of overlay.failureReasons) reasons.set(nodeId, reason);
    return reasons;
  }, [nodeRuns.data, overlay.failureReasons]);

  // The footer's message count (D330), cleared when Domain closes. Its tokens are the selected
  // run's, read by the footer itself in every mode (PG-3.3).
  const setMessageCount = useWorkspaceStatus((s) => s.setMessageCount);
  useEffect(() => setMessageCount(messages.length), [messages.length, setMessageCount]);
  useEffect(() => () => setMessageCount(null), [setMessageCount]);

  // Chat auto-scroll: new messages and live text keep the bottom in view, unless the person has
  // scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  }, [messages, conversation.tokens]);

  const post = usePostRunMessage(runId);
  const route = useRouteEnvelope(runId);
  const budget = useSetRunBudget(runId);
  const end = useEndRun();
  const start = useStartRun(workflowId);
  const retry = useRetryNodeRun();
  // PG-3.4: a message, a roster card or the lens's pill leads to its node on the canvas, this run.
  const follow = useFollowNode();
  const showOnCanvas = (nodeId: Id): void => follow(nodeId, 'ideate');

  const select = (next: { run?: Id; node?: Id }): void => {
    const query = new URLSearchParams();
    const nextRun = 'run' in next ? next.run : runId;
    if (nextRun !== undefined) query.set('run', nextRun);
    const nextNode = 'node' in next ? next.node : node;
    if (nextNode !== undefined) query.set('node', nextNode);
    setParams(query);
  };

  const streamOpen = live && conversation.streamStatus === 'open';

  return (
    <div data-testid="domain-page" className="flex h-full min-h-0 flex-1">
      <section aria-label="Domain" className="relative flex min-w-0 flex-1 flex-col">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_480px_at_0%_0%,var(--glow),transparent_70%)]"
        />
        <header
          className={cn(
            'relative flex flex-wrap items-center gap-[10px] border-b border-[var(--line)] py-3',
            compact ? 'px-3' : 'px-6',
          )}
        >
          <div className="text-[16px] font-bold tracking-[-0.01em]">Team chat</div>
          {streamOpen && (
            <span
              data-testid="domain-live"
              className="flex h-6 items-center gap-[5px] rounded-full border border-[var(--line)] px-[9px] font-machine text-[10px] text-[#2f9e63]"
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-[#2f9e63] [animation:livePulse_2s_ease-in-out_infinite]"
              />
              live
            </span>
          )}
          {roster.length > 0 && (
            <nav
              aria-label="Lenses"
              className={cn(
                'flex gap-1.5',
                // One scrolling row on a phone, so the lenses never push the chat off screen.
                compact ? 'order-last w-full flex-nowrap overflow-x-auto pb-1' : 'flex-wrap',
              )}
            >
              <FilterPill
                label="All"
                letter="✳"
                color="var(--seg)"
                active={node === undefined}
                onPick={() => select({ node: undefined })}
              />
              {roster.map((entry, index) => {
                const look = lookOf(looks, entry.nodeId, entry.name, index);
                return (
                  <FilterPill
                    key={entry.nodeId}
                    label={entry.name}
                    letter={look.letter}
                    color={look.color}
                    active={node === entry.nodeId}
                    onPick={() => select({ node: entry.nodeId })}
                    onShowOnCanvas={() => showOnCanvas(entry.nodeId)}
                  />
                );
              })}
            </nav>
          )}
          <div className="flex-1" />
          <span className="text-[12px] text-[var(--muted)]">
            {plural(messages.length, 'message')}
          </span>
          {compact && (
            <button
              type="button"
              data-testid="domain-team-sheet-open"
              aria-expanded={teamSheet}
              onClick={() => setTeamSheet((open) => !open)}
              className="flex h-7 cursor-pointer items-center rounded-full border border-[var(--line)] bg-transparent px-[11px] text-[12px] font-semibold text-[var(--ink)] outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
            >
              Team
            </button>
          )}
          <RunPill
            runId={runId}
            run={run.data}
            status={overlayEnded ? overlay.status : undefined}
            haltReason={overlayEnded ? overlay.haltReason : run.data?.haltReason}
            runs={selected.runs ?? []}
            live={live}
            ending={end.isPending}
            onSelect={(id) => select({ run: id, node: undefined })}
            onNew={() => select({ run: 'new', node: undefined })}
            onDetails={(id) => navigate(`/runs/${id}`)}
            onEnd={(id) => end.mutate(id)}
          />
        </header>

        {/* PG-3.6: in a node's lens, that node's direct chats (Ideate's channel), read-only. */}
        {node !== undefined && roster.some((entry) => entry.nodeId === node) && (
          <NodeChatThreads
            projectId={projectId}
            workflowId={workflowId}
            nodeId={node}
            nodeName={names.get(node) ?? 'this node'}
          />
        )}

        <div
          ref={scroller}
          className="relative min-h-0 flex-1 overflow-y-auto"
          onScroll={(event) => {
            const element = event.currentTarget;
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          }}
        >
          {conversation.error !== undefined && (
            <p role="alert" className="px-6 pt-4 text-center text-[13px] text-[#c94c27]">
              {conversation.error}
            </p>
          )}
          {runId === undefined ? (
            <DomainEmpty>This workflow has no runs yet.</DomainEmpty>
          ) : (
            <Conversation
              messages={messages}
              roster={roster}
              names={names}
              looks={looks}
              tokens={conversation.tokens}
              readOnly={!live}
              onRoute={(envelopeId, body) => route.mutateAsync({ envelopeId, body })}
              {...(project.data === undefined ? {} : { folderPath: project.data.folderPath })}
              onOpenFile={(path) => {
                // D336: an output card inside the project opens its file in Forge.
                openFile(projectId, path);
                navigate(workflowPath(projectId, workflowId, 'forge', params));
              }}
              // PG-1.5/PG-1.6: a failed turn's Retry is the node retry; a turn id is its node run.
              onRetryTurn={(turnId) =>
                retry.mutateAsync({ nodeRunId: turnId, withDownstream: false })
              }
              onShowOnCanvas={showOnCanvas}
              {...(nodeRuns.data === undefined ? {} : { nodeRuns: nodeRuns.data })}
            />
          )}
        </div>

        {/* PG-3.5: a node WAITING on an approval is answered here as on the Canvas. */}
        <RunApprovalsDock
          runId={run.data?.id}
          revision={messages.length}
          className={cn('relative border-t border-[var(--line)] py-3', compact ? 'px-3' : 'px-6')}
        />

        {(runId === undefined || run.data !== undefined) && (
          <Composer
            roster={roster}
            states={states}
            looks={looks}
            live={live}
            // An ended run's conversation is read-only, but the composer never is: a message
            // starts a new run, with itself as the goal (D3, D312).
            ended={runId !== undefined && !live}
            onSend={(body) => post.mutateAsync(body)}
            onStart={async (goal) => {
              // D312: the message is the run's goal; a run started here stays open (D323).
              const created = await start.mutateAsync({ goal, domain: { stayOpen: true } });
              select({ run: created.id, node: undefined });
            }}
          />
        )}
      </section>
      {!compact && teamOpen && (
        <TeamPanel
          usage={usage}
          looks={looks}
          failureReasons={failureReasons}
          agentCount={roster.length}
          readOnly={!live}
          onSetBudget={(limit) => budget.mutateAsync(limit)}
          onClose={toggleTeam}
          focusedNodeId={node}
          onShowOnCanvas={showOnCanvas}
        />
      )}
      {compact && teamSheet && (
        // PG-3.7: on a phone the Team aside covers the chat, and closes back to it.
        <div data-testid="domain-team-sheet" className="fixed inset-0 z-40 flex bg-[var(--panel)]">
          <TeamPanel
            usage={conversation.usage}
            looks={looks}
            failureReasons={failureReasons}
            agentCount={roster.length}
            readOnly={!live}
            onSetBudget={(limit) => budget.mutateAsync(limit)}
            onClose={() => setTeamSheet(false)}
          />
        </div>
      )}
    </div>
  );
}

const PILL =
  'flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border pl-1.5 pr-[11px] text-[12px] font-semibold text-[var(--ink)] outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/** A lens (D5): the theme's filter pill — an 18px avatar and the agent's name. */
function FilterPill({
  label,
  letter,
  color,
  active,
  onPick,
  onShowOnCanvas,
}: {
  label: string;
  letter: string;
  color: string;
  active: boolean;
  onPick(): void;
  /** PG-3.4: the lens's node on the canvas, offered beside the pill while it is the lens. */
  onShowOnCanvas?(): void;
}) {
  const pill = (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPick}
      className={cn(
        PILL,
        active ? 'border-[var(--ink)] bg-[var(--surface)]' : 'border-[var(--line)] bg-transparent',
      )}
    >
      <Avatar letter={letter} color={color} size={18} fontSize={9} />
      {label}
    </button>
  );
  if (!active || onShowOnCanvas === undefined) return pill;
  return (
    <span className="flex items-center gap-[2px]">
      {pill}
      <button
        type="button"
        aria-label={`Show ${label} on canvas`}
        title="Show on canvas"
        onClick={onShowOnCanvas}
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
      >
        <Icons.LocateFixed aria-hidden size={13} />
      </button>
    </span>
  );
}

/** When a run started: its time today, its date and time before. */
function startedLabel(at: string): string {
  const date = new Date(at);
  if (date.toDateString() === new Date().toDateString()) return clockTime(at);
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The run pill (D336, uncovered): which run this is and how it stands, and — in its menu — the
 * other runs, New run, Run details and End run.
 */
function RunPill({
  runId,
  run,
  status,
  haltReason,
  runs,
  live,
  ending,
  onSelect,
  onNew,
  onDetails,
  onEnd,
}: {
  runId: Id | undefined;
  run: Run | undefined;
  /** PG-3.3: the run's end as the overlay heard it, ahead of the record's refetch. */
  status?: RunState | undefined;
  /** PG-4.2: why a HALTED run halted, so the pill says it rather than a bare HALTED. */
  haltReason?: HaltReason | undefined;
  runs: readonly RunSummary[];
  live: boolean;
  ending: boolean;
  onSelect(id: Id): void;
  onNew(): void;
  onDetails(id: Id): void;
  onEnd(id: Id): void;
}) {
  // A run opened by link that the list does not hold (yet) is still listed.
  const listed: Pick<RunSummary, 'id' | 'status' | 'startedAt'>[] =
    run !== undefined && !runs.some((each) => each.id === run.id) ? [run, ...runs] : [...runs];
  const canNew = !live && runId !== undefined;
  const canEnd = live && runId !== undefined && (run?.allowedActions ?? []).includes('end');
  if (listed.length === 0 && runId === undefined) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            PILL,
            'pl-[11px] data-[state=open]:border-[var(--ink)] data-[state=open]:bg-[var(--surface)]',
            'border-[var(--line)] bg-transparent',
          )}
        >
          <span>
            {runId === undefined
              ? 'New run'
              : run === undefined
                ? 'Run'
                : `Run · ${clockTime(run.startedAt)}`}
          </span>
          {run !== undefined && (
            <span
              data-testid="domain-run-status"
              className="font-machine text-[10px] font-normal text-[var(--muted)]"
            >
              {status ?? run.status}
              {(status ?? run.status) === run.status &&
                run.blockedReason !== undefined &&
                ` · ${run.blockedReason}`}
              {(status ?? run.status) === 'HALTED' && haltReason !== undefined && (
                <span data-testid="domain-run-halt" data-reason={haltReason}>
                  {` · ${haltWords(haltReason)}`}
                </span>
              )}
            </span>
          )}
          <Icons.ChevronDown aria-hidden size={12} className="text-[var(--muted)]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[360px] overflow-y-auto">
        {listed.map((each) => (
          <DropdownMenuItem key={each.id} onSelect={() => onSelect(each.id)}>
            <span className="flex-1">
              {each.status} · {startedLabel(each.startedAt)}
            </span>
            {each.id === runId && <Icons.Check aria-hidden size={13} className="text-[#e8572e]" />}
          </DropdownMenuItem>
        ))}
        {listed.length > 0 && (canNew || runId !== undefined) && <DropdownMenuSeparator />}
        {canNew && <DropdownMenuItem onSelect={onNew}>New run</DropdownMenuItem>}
        {runId !== undefined && (
          <DropdownMenuItem onSelect={() => onDetails(runId)}>Run details</DropdownMenuItem>
        )}
        {canEnd && runId !== undefined && (
          <DropdownMenuItem destructive disabled={ending} onSelect={() => onEnd(runId)}>
            End run
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
