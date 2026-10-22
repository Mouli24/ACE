import {
  isAddressableNode,
  isCliProviderType,
  type ChatMessage,
  type Node,
  type Part,
  type Provider,
  type Usage,
} from '@ace/contracts';
import { cn, Icons, PartRenderer } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { api } from '../app/api';
import { useCheckpoint } from '../forge/changes/hooks';
import { stepFilesOf } from '../forge/open-in-forge';
import { useNodeRunsOnce, useRun } from '../runs/hooks';
import { useNodeOverlay } from '../runs/run-store';
import { UNDO_UNAVAILABLE_TITLE, UndoChoiceButtons, undoReasonText } from '../runs/UndoChoice';
import { formatUsd } from '../usage/format';
import { queryKeys } from '../workflows/query-keys';
import type { AgentLook } from '../theme/agents';
import { fmt } from '../theme/constants';
import { clockTime } from '../theme/format';
import { Avatar } from '../theme/primitives';
import { ChangesCardSlot } from './ChangesCardSlot';
import { ChatActivity } from './ChatActivity';
import { useFollowTail } from './follow-tail';
import {
  CHAT_NOTE_CLASS,
  CHAT_NOTE_HEAD_CLASS,
  ChatRefusalCard,
  ChatVerdicts,
} from './ChatVerdicts';
import { ActionButton, EarlierVersion, EditBox, MessageActions } from './MessageActions';
import type { ChatConversation as Conversation } from './useChat';

/** PG-1.5: how long past the node's own timeout a reply may stay silent before it is called lost. */
export const STALL_GRACE_MS = 10_000;

/** D302: a CLI working in the project folder gets a run's floor (the engine's CLI_SESSION_MIN_TIMEOUT_MS). */
const CLI_TURN_FLOOR_MS = 600_000;

/**
 * PG-1.5 client stall rule: true once no `chat.token` or `chat.message` has arrived for the node's
 * timeout plus 10 s while a reply is owed. A node with no timeout never stalls by this rule.
 */
export function useStalled(waitingSince: number | undefined, budgetMs: number): boolean {
  const [stalledFor, setStalledFor] = useState<number>();
  useEffect(() => {
    if (waitingSince === undefined || budgetMs <= 0) return;
    const wait = waitingSince + budgetMs + STALL_GRACE_MS - Date.now();
    const timer = setTimeout(() => setStalledFor(waitingSince), Math.max(wait, 0));
    return () => clearTimeout(timer);
  }, [waitingSince, budgetMs]);
  return waitingSince !== undefined && stalledFor === waitingSince;
}

/** The node's own clock for one chat turn, as the engine reads it (D302's CLI floor included). */
function turnBudgetMs(node: Node, providers: readonly Provider[] | undefined): number {
  if (node.kind !== 'agent' && node.kind !== 'model') return 0;
  const timeoutMs = node.config.execution.timeoutMs;
  const provider = providers?.find((each) => each.id === node.config.providerId);
  const cli = provider !== undefined && isCliProviderType(provider.type);
  return timeoutMs > 0 && cli ? Math.max(timeoutMs, CLI_TURN_FLOOR_MS) : timeoutMs;
}

/** One rendered item: a turn, or a run of turns a retry or an edit replaced (PG-1.6). */
type Item = { kind: 'turn'; message: ChatMessage } | { kind: 'earlier'; messages: ChatMessage[] };

function itemsOf(messages: readonly ChatMessage[]): Item[] {
  const items: Item[] = [];
  for (const message of messages) {
    if (message.supersededAt === undefined) {
      items.push({ kind: 'turn', message });
      continue;
    }
    const last = items.at(-1);
    if (last?.kind === 'earlier') last.messages.push(message);
    else items.push({ kind: 'earlier', messages: [message] });
  }
  return items;
}

/**
 * A message's text in the theme's type (D335): 13px / 1.5 ink. The kit's Markdown already draws a
 * list as the theme's bullet rows (an orange `•`, 8px from the text, 6px apart); the chat sets their
 * text to the aside's 12.5px / 1.4.
 */
const TEXT_CLASS =
  'text-[13px] leading-[1.5] text-[var(--ink)] [text-wrap:pretty] [&_ul>li]:text-[12.5px] [&_ul>li]:leading-[1.4]';

/** The 26px avatar: "Y" on the surface for you, ✳ on the orange wash for the node (D335). */
function ChatAvatar({ you }: { you: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border border-[var(--line)] font-bold',
        you
          ? 'bg-[var(--surface)] text-[11px] text-[var(--ink)]'
          : 'bg-[rgba(239,107,63,0.14)] text-[14px] text-[#e8572e]',
      )}
    >
      {you ? 'Y' : '✳'}
    </span>
  );
}

/**
 * One theme message row: avatar, name and time, then the body (D335). D302: a reply another node
 * gave in this conversation wears that node's avatar and name (`speaker`).
 */
function Row({
  you,
  name,
  at,
  speaker,
  children,
}: {
  you: boolean;
  name: string;
  /** Omitted for a reply still on its way: it has no time yet. */
  at?: string;
  speaker?: AgentLook | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-[10px]">
      {speaker === undefined ? (
        <ChatAvatar you={you} />
      ) : (
        <Avatar letter={speaker.letter} color={speaker.color} size={26} fontSize={11} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="text-[12.5px] font-bold"
            {...(speaker === undefined ? {} : { 'data-testid': 'chat-speaker' })}
          >
            {name}
          </span>
          {at !== undefined && (
            <span className="text-[10px] text-[var(--muted)]">{clockTime(at)}</span>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/gu;

/**
 * PG-1.6: a fenced code block inside a text part becomes a `code` part of its own, so the kit's code
 * block draws it with its own Copy; the text around it stays text.
 */
export function splitFences(content: readonly Part[]): Part[] {
  return content.flatMap((part): Part[] => {
    if (part.type !== 'text' || !part.text.includes('```')) return [part];
    const out: Part[] = [];
    let last = 0;
    for (const match of part.text.matchAll(FENCE)) {
      const before = part.text.slice(last, match.index).trim();
      if (before !== '') out.push({ type: 'text', text: before });
      const language = (match[1] ?? '').trim();
      out.push({
        type: 'code',
        language: language === '' ? 'text' : language,
        text: (match[2] ?? '').replace(/\n$/u, ''),
      });
      last = match.index + match[0].length;
    }
    const after = part.text.slice(last).trim();
    if (after !== '') out.push({ type: 'text', text: after });
    return out.length === 0 ? [part] : out;
  });
}

/** A turn's parts: text through the kit's Markdown in the theme's type, media via PartRenderer. */
function Body({ content }: { content: Part[] }) {
  const contentUrl = (artifactId: string) => api().artifactContentUrl(artifactId);
  return (
    <div className="mt-1 flex flex-col gap-2" data-testid="message-body">
      {splitFences(content).map((part, index) => (
        <PartRenderer
          key={index}
          part={part}
          contentUrl={contentUrl}
          {...(part.type === 'text' ? { className: TEXT_CLASS } : {})}
        />
      ))}
    </div>
  );
}

/** A turn's cost as the meta line says it (PG-2.2): `$0.0012`, or "cost unknown" (PG-1.4). */
export function chatCostText(usage: Usage): string {
  return usage.costKnown === false ? 'cost unknown' : formatUsd(usage.costUsd);
}

/**
 * The line under an agent turn (FR-CHAT-006, D335): the model that actually answered, its tokens,
 * and whether a run of the node wrote it (D285) — then "Open in Forge →" when the turn wrote files.
 * Agents write their work into the project themselves, so there is nothing to send to Forge. Only
 * real values: a turn with none of them has no line.
 */
function TurnMeta({
  message,
  onOpenRun,
  agenticForge,
}: {
  message: ChatMessage;
  onOpenRun: ((runId: string) => void) | undefined;
  /** D378: opens the files the turn wrote in Forge; drawn only when it wrote some. */
  agenticForge: AgenticForge | undefined;
}) {
  const parts: ReactNode[] = [];
  if (message.modelId !== undefined) {
    parts.push(
      <span key="model" data-testid="chat-model">
        {message.modelId}
      </span>,
    );
  }
  if (message.usage !== undefined) {
    parts.push(
      <span key="usage" data-testid="chat-usage">
        {fmt(message.usage.tokensIn)} in · {fmt(message.usage.tokensOut)} out
      </span>,
    );
    // PG-2.2: the turn's cost. An unpriced remote model's cost is unknown, never $0 (PG-1.4).
    parts.push(
      <span key="cost" data-testid="chat-cost">
        {chatCostText(message.usage)}
      </span>,
    );
  }
  if (message.runId !== undefined) {
    parts.push(
      <span key="run" data-testid="chat-run-badge">
        run
      </span>,
    );
    if (onOpenRun !== undefined) {
      parts.push(<SeeWholeRun key="see-run" runId={message.runId} onOpenRun={onOpenRun} />);
    }
  }
  if (parts.length === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="min-w-0 text-[10px] text-[var(--muted)]">
        {parts.flatMap((part, index) => (index === 0 ? [part] : [' · ', part]))}
      </span>
      {agenticForge !== undefined &&
        (message.runId !== undefined || message.checkpointId !== undefined) && (
          <OpenInForgeChip message={message} forge={agenticForge} />
        )}
    </div>
  );
}

/** What an agentic node's turns need to open their files in Forge (D378). */
interface AgenticForge {
  nodeId: string;
  projectId: string;
  open: (paths: readonly string[], runId?: string) => void;
}

/**
 * D378: "Open in Forge" on an agentic node's turn — the files of that step: a run turn's node
 * run (workspace summary, else its calls' changed paths), or a chat turn's checkpoint.
 */
function OpenInForgeChip({ message, forge }: { message: ChatMessage; forge: AgenticForge }) {
  const nodeRuns = useNodeRunsOnce(message.runId).data;
  const checkpoint = useCheckpoint(forge.projectId, message.checkpointId ?? '').data;
  const nodeRun = nodeRuns?.filter((each) => each.nodeId === forge.nodeId).at(-1);
  const fromRun = stepFilesOf(nodeRun);
  const files = fromRun.length > 0 ? fromRun : (checkpoint?.files.map((file) => file.path) ?? []);
  // A turn that wrote nothing has nothing to open.
  if (files.length === 0) return null;
  return (
    <button
      type="button"
      data-testid="chat-open-in-forge"
      onClick={() => forge.open(files, message.runId)}
      className="flex h-[22px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-[var(--line)] bg-[var(--chip)] px-[9px] text-[10px] font-semibold text-[var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
    >
      Open in Forge
      <Icons.ArrowRight aria-hidden size={11} />
    </button>
  );
}

/** A run turn's way to the whole run: the chat column's Run tab on that run (`?run=`). */
function SeeWholeRun({ runId, onOpenRun }: { runId: string; onOpenRun: (runId: string) => void }) {
  return (
    <button
      type="button"
      data-testid="chat-see-run"
      onClick={() => onOpenRun(runId)}
      className="cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 font-semibold text-[#e8623a] hover:text-danger focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
    >
      See the whole run →
    </button>
  );
}

/**
 * Under a node's thread whose latest turn a run wrote: the node was one agent of a team, and the
 * rest of that run's work is a click away.
 */
function RunHint({ runId, onOpenRun }: { runId: string; onOpenRun: (runId: string) => void }) {
  const run = useRun(runId);
  const agents = run.data?.snapshot.nodes.filter(isAddressableNode).length;
  return (
    <p
      data-testid="chat-run-hint"
      className="m-0 flex flex-wrap items-baseline gap-x-1 text-[11px] text-[var(--muted)]"
    >
      <span>
        {agents === undefined
          ? 'This was part of a run.'
          : `This was part of a run — ${agents} ${agents === 1 ? 'agent' : 'agents'} worked on it.`}
      </span>
      <SeeWholeRun runId={runId} onOpenRun={onOpenRun} />
    </p>
  );
}

/** Busy states of a node's run that the chat shows (FR-EXE-009). */
const WORKING = new Set(['RUNNING', 'WAITING']);

/**
 * One node's conversation (FR-CHAT-004/006/007/008, D285), in the theme's Team chat rows (D335):
 * the stored turns — the direct chat and what runs of the node wrote — the reply streaming in, the
 * node's run while it is working, and whatever stopped a message: a guardrail, a failed send, or a
 * model call that failed. "{name} is typing…" shows only while a real stream says so: a reply is
 * owed or streaming, or the node is running.
 */
export function ChatConversation({
  node,
  convo,
  composer,
  speakers,
  projectId,
  onOpenRun,
  openInForge,
}: {
  node: Node;
  convo: Conversation;
  /** D378: opens in Forge the files a turn wrote (the column only). */
  openInForge?: (paths: readonly string[], runId?: string) => void;
  /** A run turn's "See the whole run →": show that run's conversation (the column only). */
  onOpenRun?: (runId: string) => void;
  /** The input box, when it belongs inside the conversation (the phone tab); the column keeps its own. */
  composer?: ReactNode;
  /** D302: the workflow's agents by node id, to name a reply another node gave. */
  speakers?: ReadonlyMap<string, AgentLook>;
  /** The project, for a turn's Changes card (D300). */
  projectId?: string;
}) {
  /** Another node that answered here (D302); undefined for the conversation's own node. */
  const otherSpeaker = (speakerNodeId: string | undefined): AgentLook | undefined =>
    speakerNodeId === undefined || speakerNodeId === node.id
      ? undefined
      : speakers?.get(speakerNodeId);
  const replying = otherSpeaker(convo.replyingNodeId);
  const replyName = replying?.name ?? node.name;
  // Any node's chat can write in the project (D302), so any turn that did offers its files.
  const agenticForge: AgenticForge | undefined =
    openInForge !== undefined && projectId !== undefined
      ? { nodeId: node.id, projectId, open: openInForge }
      : undefined;
  const scroller = useFollowTail<HTMLDivElement>();
  const run = useNodeOverlay(node.id);
  const running = WORKING.has(run.state);
  const runText =
    run.state === 'WAITING'
      ? 'Waiting for your approval…'
      : run.state === 'RUNNING'
        ? run.streamedText
        : '';
  const queryClient = useQueryClient();
  const budgetMs = turnBudgetMs(node, queryClient.getQueryData<Provider[]>(queryKeys.providers()));
  // PG-1.5: a reply owed and silent past the node's timeout + 10 s is "No answer — Retry".
  const stalled = useStalled(convo.waitingSince, budgetMs);
  const [editing, setEditing] = useState<string>();
  /** PG-2.4: undo choices the person cancelled — the failed turn stays, its buttons go. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const typing =
    !stalled && (convo.awaitingReply || convo.streamingText.length > 0 || run.state === 'RUNNING');
  const hasStreamText = convo.streamingText.length > 0 || runText.length > 0;
  const busy = convo.awaitingReply || convo.sending;

  /** A message and its actions (PG-1.6). `earlier`: a replaced turn — Copy and Delete only. */
  const renderTurn = (message: ChatMessage, earlier: boolean) => {
    const you = message.role === 'user';
    const speaker = you ? undefined : otherSpeaker(message.speakerNodeId);
    const name = you ? 'You' : (speaker?.name ?? node.name);
    const isEditing = editing === message.id && !earlier;
    // The turns an edit of this message would replace, and how many of them changed files.
    const replaced = you
      ? convo.messages.filter((each) => each.id >= message.id && each.supersededAt === undefined)
      : [];
    const checkpointIds = replaced.flatMap((each) =>
      each.checkpointId === undefined ? [] : [each.checkpointId],
    );
    return (
      <div key={message.id} data-testid={`chat-turn-${message.role}`} className="group">
        <Row you={you} name={name} at={message.at} speaker={speaker}>
          {isEditing ? (
            <EditBox
              initial={message.content
                .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                .join('\n')}
              changedFiles={projectId === undefined ? 0 : checkpointIds.length}
              onCancel={() => setEditing(undefined)}
              onSend={(text, revert) => {
                setEditing(undefined);
                const others = message.content.filter((part) => part.type !== 'text');
                convo.edit(
                  message,
                  [{ type: 'text', text }, ...others],
                  revert && projectId !== undefined && checkpointIds.length > 0
                    ? { projectId, checkpointIds }
                    : undefined,
                );
              }}
            />
          ) : message.error !== undefined ? (
            // [audit W-15] not an alert: a failed turn read back from history is not news; the
            // turn that has just failed is said once, by the announcement below
            <div
              data-testid="chat-error-turn"
              data-code={message.error.code}
              data-kind={message.error.kind}
              className={cn(CHAT_NOTE_CLASS, 'mt-1')}
            >
              <div className={CHAT_NOTE_HEAD_CLASS}>
                {message.error.kind === 'user_cancelled'
                  ? `Stopped · ${name} did not finish`
                  : message.error.code === 'checkpoint_unavailable'
                    ? UNDO_UNAVAILABLE_TITLE
                    : `${name} could not answer · ${message.error.code}`}
                {message.runId !== undefined && <span data-testid="chat-run-badge">· run</span>}
                {message.runId !== undefined && onOpenRun !== undefined && (
                  <span className="ml-1">
                    <SeeWholeRun runId={message.runId} onOpenRun={onOpenRun} />
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words">
                {message.error.code === 'checkpoint_unavailable'
                  ? undoReasonText(message.error.message)
                  : message.error.message}
              </p>
              {/* PG-2.2: what the turn spent before it stopped — a budget refusal names it. */}
              {message.usage !== undefined &&
                message.usage.tokensIn + message.usage.tokensOut > 0 && (
                  <p className="text-[10px] text-[var(--muted)]" data-testid="chat-usage">
                    {fmt(message.usage.tokensIn)} in · {fmt(message.usage.tokensOut)} out ·{' '}
                    <span data-testid="chat-cost">{chatCostText(message.usage)}</span>
                  </p>
                )}
              {/* PG-2.4 (D361): the turn stopped before writing — run it once without undo, or not. */}
              {message.error.code === 'checkpoint_unavailable' &&
                !earlier &&
                !dismissed.has(message.id) && (
                  <div className="mt-2">
                    <UndoChoiceButtons
                      busy={busy}
                      onRunWithoutUndo={() => convo.retryWithoutUndo(message)}
                      onCancel={() => setDismissed((set) => new Set(set).add(message.id))}
                    />
                  </div>
                )}
            </div>
          ) : (
            <>
              <Body content={message.content} />
              {!you && (
                <TurnMeta message={message} onOpenRun={onOpenRun} agenticForge={agenticForge} />
              )}
            </>
          )}
          {message.activity !== undefined && <ChatActivity items={message.activity} />}
          {message.checkpointId !== undefined && projectId !== undefined && (
            <ChangesCardSlot projectId={projectId} checkpointId={message.checkpointId} />
          )}
          {message.verdicts.length > 0 && (
            <div className="mt-2">
              <ChatVerdicts verdicts={message.verdicts} />
            </div>
          )}
          {!isEditing && (
            <div className="mt-1">
              <MessageActions
                message={message}
                busy={busy}
                onDelete={() => convo.remove(message)}
                {...(earlier
                  ? {}
                  : you
                    ? { onEdit: () => setEditing(message.id) }
                    : { onRetry: () => convo.retry(message) })}
              />
            </div>
          )}
        </Row>
      </div>
    );
  };

  // Follow the tail as turns arrive, the reply streams, the run works and typing starts or stops —
  // [audit W-13] while the reader is at the tail; another node or thread opens at its tail.
  const follow = scroller.follow;
  useEffect(() => follow(true), [follow, node.id, convo.threadId]);
  useEffect(() => {
    follow();
  }, [
    follow,
    convo.messages.length,
    convo.streamingText,
    convo.refusal,
    convo.error,
    typing,
    runText,
    stalled,
  ]);

  // The thread's latest turn came from a run: say so under it, with the way to the whole run.
  const latestRunId = convo.messages
    .filter((each) => each.supersededAt === undefined)
    .at(-1)?.runId;

  /*
   * [audit W-15] The reply is said once, when it lands — not token by token, which is what a
   * live region around the streaming text did. A thread opened or switched to says nothing.
   */
  const latestReply = convo.messages
    .filter((each) => each.role !== 'user' && each.supersededAt === undefined)
    .at(-1);
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef<{ threadId: string | undefined; replyId: string | undefined }>({
    threadId: convo.threadId,
    replyId: latestReply?.id,
  });
  useEffect(() => {
    const before = announced.current;
    announced.current = { threadId: convo.threadId, replyId: latestReply?.id };
    if (latestReply === undefined || before.threadId !== convo.threadId) return;
    if (before.replyId === latestReply.id) return;
    const who = otherSpeaker(latestReply.speakerNodeId)?.name ?? node.name;
    setAnnouncement(
      latestReply.error === undefined ? `${who} answered.` : `${who} could not answer.`,
    );
    // keyed on the reply's id alone: it is said once, whatever else re-renders
  }, [convo.threadId, latestReply?.id]);

  const empty =
    convo.messages.length === 0 &&
    !convo.awaitingReply &&
    !running &&
    convo.refusal === undefined &&
    convo.error === undefined &&
    convo.loadError === undefined;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="chat-conversation"
      data-node-id={node.id}
    >
      <div
        ref={scroller.ref}
        onScroll={scroller.onScroll}
        className="flex min-h-0 flex-1 flex-col gap-[20px] overflow-y-auto px-[14px] py-[16px]"
      >
        {/* [audit W-11] a conversation that could not be read is not an empty one */}
        {convo.loadError !== undefined && (
          <div role="alert" data-testid="chat-load-error" className={CHAT_NOTE_CLASS}>
            <div className={CHAT_NOTE_HEAD_CLASS}>Could not read this conversation</div>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1">{convo.loadError.message}</p>
              <ActionButton label="Retry" onClick={convo.loadError.retry}>
                <Icons.RotateCcw aria-hidden size={14} />
              </ActionButton>
            </div>
          </div>
        )}

        {empty && (
          <p className="flex flex-1 items-center justify-center text-center text-[13px] text-[var(--muted)]">
            Chat with {node.name} — it answers with its model and goal. Run the workflow and its
            result lands here too.
          </p>
        )}

        {itemsOf(convo.messages).map((item) =>
          item.kind === 'turn' ? (
            renderTurn(item.message, false)
          ) : (
            <EarlierVersion
              key={`earlier-${item.messages[0]?.id ?? ''}`}
              count={item.messages.length}
            >
              {item.messages.map((message) => renderTurn(message, true))}
            </EarlierVersion>
          ),
        )}

        {latestRunId !== undefined && onOpenRun !== undefined && (
          <RunHint runId={latestRunId} onOpenRun={onOpenRun} />
        )}

        {/* [audit W-15] the text streams outside any live region; the announcement says it once */}
        <p role="status" data-testid="chat-announce" className="sr-only">
          {announcement}
        </p>

        {convo.streamingText.length > 0 && (
          <div data-testid="chat-streaming">
            <Row you={false} name={replyName} speaker={replying}>
              <Body content={[{ type: 'text', text: convo.streamingText }]} />
            </Row>
          </div>
        )}

        {runText.length > 0 && (
          <div data-testid="chat-run-live">
            <Row you={false} name={node.name}>
              <Body content={[{ type: 'text', text: runText }]} />
            </Row>
          </div>
        )}

        {typing && (
          <div
            aria-live="polite"
            data-testid={hasStreamText ? 'chat-typing' : 'chat-thinking'}
            className="flex items-center gap-2 pl-[36px] text-[11px] text-[var(--muted)]"
          >
            <Icons.Circle
              aria-hidden
              size={8}
              className="animate-[livePulse_1s_ease-in-out_infinite] fill-current"
            />
            {convo.awaitingReply || convo.streamingText.length > 0 ? replyName : node.name} is
            typing…
          </div>
        )}

        {/* PG-2.2 (D359): a tool call the guardrail asked a person about; the turn waits. */}
        {convo.approvals.map((request) => (
          <div
            key={request.id}
            role="alert"
            data-testid="chat-approval"
            className={CHAT_NOTE_CLASS}
          >
            <div className={CHAT_NOTE_HEAD_CLASS}>
              {request.nodeName} wants to run{' '}
              {request.command === undefined ? 'a tool' : 'a command'} · approval needed
            </div>
            {request.command === undefined ? (
              <p className="whitespace-pre-wrap break-words">{request.reason}</p>
            ) : (
              request.command.denylisted && (
                <p className="font-semibold text-danger">This matches the risky-command list.</p>
              )
            )}
            <pre
              data-testid={request.command === undefined ? undefined : 'chat-approval-command'}
              className="m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-[6px] bg-[var(--chip)] p-[6px] font-mono text-[11px]"
            >
              {request.command?.text ?? request.preview}
            </pre>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="chat-approval-approve"
                onClick={() => convo.decideApproval(request, 'approve')}
                className="flex h-[28px] cursor-pointer items-center rounded-[8px] border border-[var(--line)] bg-[var(--ink)] px-[12px] text-[12px] font-semibold text-[var(--surface)] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
              >
                {request.command === undefined ? 'Approve' : 'Allow'}
              </button>
              {request.command?.allowPrefix !== undefined && !request.command.denylisted && (
                <button
                  type="button"
                  data-testid="chat-approval-always"
                  onClick={() => convo.decideApproval(request, 'approve', true)}
                  className="flex min-h-[28px] max-w-full cursor-pointer items-center rounded-[8px] border border-[var(--line)] bg-[var(--chip)] px-[12px] py-[4px] text-left text-[12px] font-semibold text-[var(--ink)] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                >
                  <span className="break-all">
                    Always allow <span className="font-mono">{request.command.allowPrefix}</span>
                  </span>
                </button>
              )}
              <button
                type="button"
                data-testid="chat-approval-reject"
                onClick={() => convo.decideApproval(request, 'reject')}
                className="flex h-[28px] cursor-pointer items-center rounded-[8px] border border-[var(--line)] bg-[var(--chip)] px-[12px] text-[12px] font-semibold text-[var(--ink)] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
              >
                {request.command === undefined ? 'Reject' : 'Deny'}
              </button>
            </div>
          </div>
        ))}

        {stalled && (
          <div role="alert" data-testid="chat-stalled" className={CHAT_NOTE_CLASS}>
            <div className={CHAT_NOTE_HEAD_CLASS}>No answer</div>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1">
                {replyName} has not answered within its time limit. Retry reads the conversation
                again, and asks again if the answer is not there.
              </p>
              <ActionButton label="Retry" onClick={convo.recover}>
                <Icons.RotateCcw aria-hidden size={14} />
              </ActionButton>
            </div>
          </div>
        )}

        {convo.refusal !== undefined && (
          <ChatRefusalCard message={convo.refusal.message} verdicts={convo.refusal.verdicts} />
        )}

        {convo.error !== undefined && (
          <div role="alert" data-testid="chat-send-error" className={CHAT_NOTE_CLASS}>
            <div className={CHAT_NOTE_HEAD_CLASS}>not sent</div>
            <p>{convo.error}</p>
          </div>
        )}
      </div>

      {composer}
    </div>
  );
}
