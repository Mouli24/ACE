import {
  rosterFor,
  type Id,
  type NodeState,
  type RosterEntry,
  type Run,
  type RunSummary,
} from '@ace/contracts';
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ace/ui';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { SHORTCUTS, useShortcuts } from '../app/shortcuts';
import { useLayoutStore } from '../app/stores/layout';
import { useWorkspaceStatus } from '../app/stores/workspace-status';
import { openFile } from '../forge/editor/actions';
import { workflowPath } from '../forge/mode';
import { useProject } from '../projects/hooks';
import { useEndRun, useRun, useRuns, useStartRun } from '../runs/hooks';
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
import { domainLooks, lookOf, plural } from './looks';
import { TeamPanel } from './TeamPanel';

/**
 * Domain (D303–D327) in the theme's team-chat view (D336): a run as its team's conversation — who
 * did what, what went to whom, who is stuck, and what it cost. `?run=` picks the run (the live one
 * by default), `?node=` a node's lens (the header's filter pills). A run that has ended opens
 * read-only. The Team aside follows the header's Split toggle.
 */
export function DomainPage() {
  const { projectId = '', workflowId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // The mode switch's keys work here too (D299): Domain sits outside the workflow layout.
  useShortcuts([
    [SHORTCUTS.ideate, () => navigate(workflowPath(projectId, workflowId, 'ideate'))],
    [SHORTCUTS.forge, () => navigate(workflowPath(projectId, workflowId, 'forge'))],
  ]);
  const chatOpen = useLayoutStore((s) => s.chatOpen);
  const toggleChat = useLayoutStore((s) => s.toggleChat);
  const project = useProject(projectId);
  const runs = useRuns(workflowId);
  const requested = params.get('run') ?? undefined;
  const node = params.get('node') ?? undefined;

  const fallback = useMemo(() => {
    const list = runs.data ?? [];
    return (list.find((summary) => isLiveRun(summary)) ?? list[0])?.id;
  }, [runs.data]);
  // `?run=new`: write a goal to start a new run, whatever ran before.
  const runId = requested === 'new' ? undefined : (requested ?? fallback);
  const run = useRun(runId);
  const live = run.data !== undefined && isLiveRun(run.data);
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
  const states: Record<Id, NodeState> = useMemo(
    () =>
      Object.fromEntries(
        (conversation.usage?.perNode ?? []).map((entry) => [entry.nodeId, entry.state]),
      ),
    [conversation.usage],
  );

  // The footer's message count and token totals (D330), cleared when Domain closes.
  const setMessageCount = useWorkspaceStatus((s) => s.setMessageCount);
  const setTokens = useWorkspaceStatus((s) => s.setTokens);
  const totalIn = conversation.usage?.total.input;
  const totalOut = conversation.usage?.total.output;
  useEffect(() => setMessageCount(messages.length), [messages.length, setMessageCount]);
  useEffect(
    () =>
      setTokens(
        totalIn === undefined || totalOut === undefined ? null : { in: totalIn, out: totalOut },
      ),
    [totalIn, totalOut, setTokens],
  );
  useEffect(
    () => () => {
      setMessageCount(null);
      setTokens(null);
    },
    [setMessageCount, setTokens],
  );

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
        <header className="relative flex flex-wrap items-center gap-[10px] border-b border-[var(--line)] px-6 py-3">
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
            <nav aria-label="Lenses" className="flex flex-wrap gap-1.5">
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
                  />
                );
              })}
            </nav>
          )}
          <div className="flex-1" />
          <span className="text-[12px] text-[var(--muted)]">
            {plural(messages.length, 'message')}
          </span>
          <RunPill
            runId={runId}
            run={run.data}
            runs={runs.data ?? []}
            live={live}
            ending={end.isPending}
            onSelect={(id) => select({ run: id, node: undefined })}
            onNew={() => select({ run: 'new', node: undefined })}
            onDetails={(id) => navigate(`/runs/${id}`)}
            onEnd={(id) => end.mutate(id)}
          />
        </header>

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
                navigate(workflowPath(projectId, workflowId, 'forge'));
              }}
            />
          )}
        </div>

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
      {chatOpen && (
        <TeamPanel
          usage={conversation.usage}
          looks={looks}
          agentCount={roster.length}
          readOnly={!live}
          onSetBudget={(limit) => budget.mutateAsync(limit)}
          onClose={toggleChat}
        />
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
}: {
  label: string;
  letter: string;
  color: string;
  active: boolean;
  onPick(): void;
}) {
  return (
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
              {run.status}
              {run.blockedReason !== undefined && ` · ${run.blockedReason}`}
            </span>
          )}
          <span aria-hidden className="text-[10px] text-[var(--muted)]">
            ▾
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[360px] overflow-y-auto">
        {listed.map((each) => (
          <DropdownMenuItem key={each.id} onSelect={() => onSelect(each.id)}>
            <span className="flex-1">
              {each.status} · {startedLabel(each.startedAt)}
            </span>
            {each.id === runId && (
              <span aria-hidden className="text-[11px] text-[#e8572e]">
                ✓
              </span>
            )}
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
