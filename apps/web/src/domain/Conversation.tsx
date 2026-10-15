import type {
  ArtifactRef,
  DomainMessage,
  DomainTurn,
  Envelope,
  FailureReason,
  Id,
  NodeRun,
  Part,
  RosterEntry,
  RouteEnvelopeRequest,
} from '@ace/contracts';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Icons,
  INPUT_CLASS,
} from '@ace/ui';
import { useId, useMemo, useState, type ReactNode } from 'react';

import { ACTIONS_CLASS, ActionButton, CopyButton } from '../chat/MessageActions';
import { nameOf } from '../forge/files/paths';
import { EnvelopeView } from '../inspector/EnvelopeView';
import { MemoryOpsList, ReusedNote } from '../inspector/RecordNotes';
import { clockTime, initial } from '../theme/format';
import { lookOf, plural, seconds, type DomainLooks } from './looks';
import { artifactTarget } from './open-artifact';

/**
 * The conversation (D5, D8, D303, D310, D327) in the theme's Domain view (D336): every message the
 * server projected, in cursor order — a 34px avatar, the name, an agent's @handle chip, the time,
 * the text. A human message shows whom it went to and how far each delivery got; an envelope shows
 * from → to, its kind and what the router did, and — while held — the human's approve, edit and
 * reject; an agent message's "What it did" lists the turn's steps and, expanded, its full output;
 * each file it produced is an output card that opens in Forge (or through the D307 seam).
 */

export interface ConversationProps {
  messages: readonly DomainMessage[];
  roster: readonly RosterEntry[];
  /** Every node of the run's snapshot by id, so one without a handle (an Input) has its name. */
  names?: ReadonlyMap<Id, string>;
  /** Each agent's colour and letter (D328). */
  looks?: DomainLooks;
  /** Live text of the turns still running, by turn id. */
  tokens: Readonly<Record<string, string>>;
  readOnly: boolean;
  onRoute(envelopeId: Id, body: RouteEnvelopeRequest): Promise<unknown>;
  /** The project's folder: a file under it opens in Forge. */
  folderPath?: string;
  /** Open a project file (relative path) in Forge; without it, files open as artifacts. */
  onOpenFile?(path: string): void;
  /**
   * PG-1.5/PG-1.6: retry a failed node turn (its node run) with the existing node retry. Absent:
   * no Retry is offered.
   */
  onRetryTurn?(turnId: Id): Promise<unknown>;
  /**
   * PG-3.4: follow a message's node to the canvas — the agent who wrote it, or the one node a
   * person's message went to. Absent: not offered.
   */
  onShowOnCanvas?(nodeId: Id): void;
  /**
   * PG-4.1/PG-4.5: the run's node runs, so a delivered envelope opens the edge envelopes it
   * travelled as (linked by `teamEnvelopeId`) and a turn shows what it remembered and whether it was
   * reused. Absent: neither is offered.
   */
  nodeRuns?: readonly NodeRun[];
}

/** The theme's empty state: one muted 13px line, centred. */
export function DomainEmpty({ children }: { children: ReactNode }) {
  return <p className="px-6 py-10 text-center text-[13px] text-[var(--muted)]">{children}</p>;
}

interface Who {
  /** The node the message is about: its author, or the one node a person's message went to. */
  nodeId?: Id;
  name: string;
  handle?: string;
  letter: string;
  bg: string;
  ink: string;
  line: string;
}

export function Conversation({
  messages,
  roster,
  names,
  looks,
  tokens,
  readOnly,
  onRoute,
  folderPath,
  onOpenFile,
  onRetryTurn,
  onShowOnCanvas,
  nodeRuns,
}: ConversationProps) {
  /** PG-4.1: every edge envelope a team envelope was delivered as, by `teamEnvelopeId`. */
  const delivered = useMemo(() => {
    const byTeam = new Map<Id, Envelope[]>();
    const seen = new Set<Id>();
    for (const row of nodeRuns ?? []) {
      for (const envelope of row.inputEnvelopes) {
        // A retry's row carries the same envelope again; it was delivered once.
        if (envelope.teamEnvelopeId === undefined || seen.has(envelope.id)) continue;
        seen.add(envelope.id);
        byTeam.set(envelope.teamEnvelopeId, [
          ...(byTeam.get(envelope.teamEnvelopeId) ?? []),
          envelope,
        ]);
      }
    }
    return byTeam;
  }, [nodeRuns]);
  const nodeRunById = useMemo(
    () => new Map((nodeRuns ?? []).map((row) => [row.id, row])),
    [nodeRuns],
  );
  const allNames = useMemo(() => {
    const map = new Map<Id, string>(names ?? []);
    for (const entry of roster) if (!map.has(entry.nodeId)) map.set(entry.nodeId, entry.name);
    return map;
  }, [names, roster]);

  const label = (nodeId: Id | undefined): string => {
    if (nodeId === undefined) return '?';
    const entry = roster.find((each) => each.nodeId === nodeId);
    return entry === undefined ? (names?.get(nodeId) ?? nodeId) : `@${entry.handle}`;
  };
  const handle = (nodeId: Id): string =>
    roster.find((each) => each.nodeId === nodeId)?.handle ?? nodeId;

  const whoOf = (message: DomainMessage): Who => {
    if (message.author.kind === 'human') {
      const only = message.to?.length === 1 ? message.to[0] : undefined;
      return {
        ...(only === undefined ? {} : { nodeId: only }),
        name: 'You',
        letter: 'Y',
        bg: 'var(--surface)',
        ink: 'var(--ink)',
        line: 'var(--line)',
      };
    }
    const nodeId =
      message.author.nodeId ??
      (message.author.kind === 'brain' ? roster.find((each) => each.brain)?.nodeId : undefined);
    if (nodeId === undefined) {
      // The Brain's router speaking in a workflow with no Brain node: the theme's ✳.
      return {
        name: 'Brain',
        letter: '✳',
        bg: 'rgba(239,107,63,0.14)',
        ink: '#e8572e',
        line: 'transparent',
      };
    }
    const index = roster.findIndex((each) => each.nodeId === nodeId);
    const entry = roster[index];
    if (entry !== undefined) {
      const look = lookOf(looks, nodeId, entry.name, index);
      return {
        nodeId,
        name: entry.name,
        handle: entry.handle,
        letter: look.letter,
        bg: look.color,
        ink: '#fff',
        line: 'transparent',
      };
    }
    // A node that is not an agent (an Input, an Output): its name, never its id when known.
    const name = names?.get(nodeId) ?? nodeId;
    return {
      nodeId,
      name,
      letter: initial(name),
      bg: 'var(--surface)',
      ink: 'var(--ink)',
      line: 'var(--line)',
    };
  };

  if (messages.length === 0) {
    return <DomainEmpty>Nothing has been said in this run yet.</DomainEmpty>;
  }

  return (
    <ol
      aria-label="Conversation"
      className="mx-auto flex max-w-[860px] flex-col gap-[28px] px-6 pb-3 pt-[28px]"
    >
      {messages.map((message) => (
        <li
          key={message.id}
          data-testid="domain-message"
          data-type={message.type}
          className="group"
        >
          {message.type === 'system' ? (
            <SystemRow message={message} />
          ) : (
            <MessageRow
              message={message}
              who={whoOf(message)}
              label={label}
              handle={handle}
              live={message.turn === undefined ? undefined : tokens[message.turn.turnId]}
              readOnly={readOnly}
              onRoute={onRoute}
              folderPath={folderPath}
              onOpenFile={onOpenFile}
              onRetryTurn={onRetryTurn}
              onShowOnCanvas={onShowOnCanvas}
              envelopes={
                message.envelope === undefined ? undefined : delivered.get(message.envelope.id)
              }
              nodeRun={
                message.turn === undefined ? undefined : nodeRunById.get(message.turn.turnId)
              }
              names={allNames}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * PG-1.6: what Copy takes from a Domain message — its text, or the live text of a turn still
 * running; with neither, its output's words. Domain is a projection of the log (D303), so Copy is
 * its only message action.
 */
function copyOf(message: DomainMessage, live?: string): string {
  if (message.text !== '') return message.text;
  if (live !== undefined && live !== '') return live;
  return (message.output ?? [])
    .map((part) =>
      part.type === 'text' || part.type === 'code'
        ? part.text
        : part.type === 'json'
          ? JSON.stringify(part.value, null, 2)
          : '',
    )
    .filter((text) => text !== '')
    .join('\n\n');
}

/** A system note (uncovered): one compact muted line under the avatars' column. */
function SystemRow({ message }: { message: DomainMessage }) {
  const ink =
    message.level === 'error' ? '#c94c27' : message.level === 'warn' ? '#e8572e' : 'var(--muted)';
  return (
    <div className="flex items-baseline gap-2 pl-[48px] text-[12px]" style={{ color: ink }}>
      <span className="min-w-0 flex-1 whitespace-pre-wrap">{message.text}</span>
      <div className={cn(ACTIONS_CLASS, 'self-center')}>
        <CopyButton text={copyOf(message)} />
      </div>
      <time dateTime={message.at} className="shrink-0 text-[11.5px] text-[var(--muted)]">
        {clockTime(message.at)}
      </time>
    </div>
  );
}

interface RowProps {
  message: DomainMessage;
  who: Who;
  label: (id: Id | undefined) => string;
  handle: (id: Id) => string;
  live: string | undefined;
  readOnly: boolean;
  onRoute: ConversationProps['onRoute'];
  folderPath: string | undefined;
  onOpenFile: ConversationProps['onOpenFile'];
  onRetryTurn: ConversationProps['onRetryTurn'];
  onShowOnCanvas?: ConversationProps['onShowOnCanvas'];
  /** PG-4.1: the edge envelopes this message's team envelope was delivered as. */
  envelopes: readonly Envelope[] | undefined;
  /** PG-4.5: the node run behind this message's turn. */
  nodeRun: NodeRun | undefined;
  names: ReadonlyMap<Id, string>;
}

function MessageRow({ message, who, label, onShowOnCanvas, ...rest }: RowProps) {
  const nodeId = who.nodeId;
  const to = message.type === 'envelope' ? [] : (message.to ?? []);
  return (
    <div className="flex gap-[14px]">
      <span
        aria-hidden
        className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border text-[13px] font-bold"
        style={{ background: who.bg, color: who.ink, borderColor: who.line }}
      >
        {who.letter}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[10px]">
        <div className="flex min-h-[24px] flex-wrap items-center gap-2">
          <span className="text-[14.5px] font-bold">{who.name}</span>
          {who.handle !== undefined && (
            <span className="flex h-[22px] items-center rounded-full border border-[var(--line)] px-2 font-machine text-[10.5px] text-[var(--muted)]">
              @{who.handle}
            </span>
          )}
          {to.length > 0 && (
            <span className="text-[12px] text-[var(--muted)]">→ {to.map(label).join(', ')}</span>
          )}
          <div className="flex-1" />
          <div className={ACTIONS_CLASS}>
            {nodeId !== undefined && onShowOnCanvas !== undefined && (
              <ActionButton label="Show on canvas" onClick={() => onShowOnCanvas(nodeId)}>
                <Icons.LocateFixed aria-hidden size={14} />
              </ActionButton>
            )}
            <CopyButton text={copyOf(message, rest.live)} />
          </div>
          <time dateTime={message.at} className="text-[11.5px] text-[var(--muted)]">
            {clockTime(message.at)}
          </time>
        </div>
        <Body message={message} label={label} {...rest} />
      </div>
    </div>
  );
}

/** The text: 14.5px / 1.55, with the D327 `auto` marker when it is an excerpt. */
function Text({ text, auto }: { text: string; auto: boolean }) {
  if (text === '' && !auto) return null;
  return (
    <div className="-mt-1 whitespace-pre-wrap text-[14.5px] leading-[1.55] [text-wrap:pretty]">
      {text}
      {auto && <span className="ml-1.5 font-machine text-[10px] text-[var(--muted)]">auto</span>}
    </div>
  );
}

type BodyProps = Omit<RowProps, 'who'>;

function Body({
  message,
  label,
  handle,
  live,
  readOnly,
  onRoute,
  folderPath,
  onOpenFile,
  onRetryTurn,
  envelopes,
  nodeRun,
  names,
}: BodyProps) {
  const auto = message.textSource === 'auto';
  if (message.type === 'envelope' && message.envelope !== undefined) {
    const envelope = message.envelope;
    return (
      <>
        <Text text={message.text} auto={auto} />
        <div className="font-machine text-[11px] text-[var(--muted)]">
          <span>
            {label(envelope.from)} → {(message.to ?? []).map(label).join(', ')}
          </span>{' '}
          · <span>{envelope.kind}</span> ·{' '}
          <span data-testid="envelope-routing">{envelope.routing ?? 'sent'}</span>
          {envelope.inReplyTo !== undefined && <span> · in reply to {envelope.inReplyTo}</span>}
        </div>
        {envelope.original !== undefined && (
          <p className="text-[12px] text-[var(--muted)]">
            The agent wrote: {envelope.original.kind} to{' '}
            {envelope.original.to.map(label).join(', ')}: {envelope.original.summary}
          </p>
        )}
        {envelope.history.length > 0 && (
          <p className="text-[12px] text-[var(--muted)]">
            {envelope.history
              .map(
                (step) =>
                  `${step.decision} by ${step.by}${step.reason === undefined ? '' : ` (${step.reason})`}`,
              )
              .join(' · ')}
          </p>
        )}
        {envelope.routing === 'HELD' && !readOnly && (
          <HeldActions envelopeId={envelope.id} summary={message.text} onRoute={onRoute} />
        )}
        {envelopes !== undefined && envelopes.length > 0 && (
          <ViewEnvelope envelopes={envelopes} names={names} />
        )}
      </>
    );
  }

  const turn = message.turn;
  const output = (message.output ?? []).filter(shownPart);
  return (
    <>
      <Text text={message.text === '' && live !== undefined ? live : message.text} auto={auto} />
      {message.delivery !== undefined && message.delivery.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.delivery.map((entry) => (
            <span
              key={entry.nodeId}
              data-testid={`delivery-${handle(entry.nodeId)}`}
              className="flex h-[22px] items-center rounded-full border border-[var(--line)] px-2 font-machine text-[10.5px] text-[var(--muted)]"
            >
              @{handle(entry.nodeId)} {entry.state}
            </span>
          ))}
        </div>
      )}
      {turn !== undefined && <TurnMeta turn={turn} />}
      {/* PG-4.5: a turn copied from an earlier run says so, and what it remembered or forgot. */}
      {nodeRun !== undefined && <ReusedNote nodeRun={nodeRun} />}
      {nodeRun?.memoryOps !== undefined && nodeRun.memoryOps.length > 0 && (
        <MemoryOpsList ops={nodeRun.memoryOps} />
      )}
      {turn !== undefined && (turn.outcome === 'FAILED' || turn.failureReason !== undefined) && (
        <TurnFailure turn={turn} onRetry={onRetryTurn} />
      )}
      {turn !== undefined && (turn.steps.length > 0 || output.length > 0) && (
        <WhatItDid turn={turn} output={output} />
      )}
      {(message.artifacts ?? []).map((ref) => (
        <OutputCard
          key={`${ref.path}:${ref.artifactId ?? ''}`}
          artifact={ref}
          folderPath={folderPath}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  );
}

/**
 * PG-4.1: "View envelope" — the edge envelopes a delivered team envelope travelled as, one per
 * receiving node, with what each was handed: sources by name, used vs budget, contract and the
 * input-point verdicts, as the Inspector shows them.
 */
function ViewEnvelope({
  envelopes,
  names,
}: {
  envelopes: readonly Envelope[];
  names: ReadonlyMap<Id, string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="view-envelope"
        onClick={() => setOpen(true)}
        className="cursor-pointer self-start rounded-[6px] border-none bg-transparent p-0 text-[12px] font-semibold text-[#e8623a] outline-none hover:text-[#c94c27] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
      >
        View envelope
      </button>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="max-h-[calc(100vh-48px)] max-w-[680px] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Envelope</DialogTitle>
              <DialogDescription>
                What each receiving node was handed: its reads, its context budget and the contract
                its answer is held to (BR-02).
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2" data-testid="envelope-dialog">
              {envelopes.map((envelope) => (
                <EnvelopeView key={envelope.id} envelope={envelope} names={names} showTo />
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

const shownPart = (part: Part): boolean =>
  part.type === 'text' || part.type === 'code' || part.type === 'json';

/** How a turn went, when that is not the plain case (a dispatch turn that ended OK). */
function TurnMeta({ turn }: { turn: DomainTurn }) {
  if (turn.trigger === 'dispatch' && turn.outcome === 'OK' && turn.error === undefined) return null;
  return (
    <div className="font-machine text-[11px] text-[var(--muted)]">
      {turn.trigger !== 'dispatch' && <span>{turn.trigger} · </span>}
      <span>{turn.outcome}</span>
      {turn.durationMs !== undefined && <span> · {(turn.durationMs / 1000).toFixed(1)} s</span>}
      {turn.error !== undefined && <span className="text-[#c94c27]"> · {turn.error}</span>}
    </div>
  );
}

/** PG-1.5: why a node turn failed, in words — never only the enum. */
const FAILURE_WORDS: Readonly<Record<FailureReason, string>> = {
  CONTRACT_VIOLATION: 'contract violation — its output did not match the output contract',
  RUN_FAILED: 'provider failure — the model call failed',
  GUARDRAIL_VIOLATION: 'guardrail block — a guardrail stopped it',
  BLOCKED: 'blocked — a node before it failed',
};

/**
 * PG-1.5/PG-1.6: a failed node turn says why, and offers Retry — the existing node retry
 * (FR-ERR-003). The engine answers whether the run can take it (D323/D360); a refusal is shown here.
 */
function TurnFailure({
  turn,
  onRetry,
}: {
  turn: DomainTurn;
  onRetry: ConversationProps['onRetryTurn'];
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  const why =
    turn.failureReason === undefined ? 'it did not finish' : FAILURE_WORDS[turn.failureReason];
  return (
    <div
      role="alert"
      data-testid="domain-turn-failure"
      data-reason={turn.failureReason}
      className="flex max-w-[560px] flex-col gap-1.5 rounded-[10px] border border-[rgba(201,76,39,0.35)] bg-[rgba(201,76,39,0.06)] px-3 py-2 text-[12.5px]"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="font-bold text-[#c94c27]">Failed: </span>
          {why}
        </span>
        {onRetry !== undefined && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setRefused(undefined);
              onRetry(turn.turnId)
                .catch((error: unknown) =>
                  setRefused(error instanceof Error ? error.message : String(error)),
                )
                .finally(() => setBusy(false));
            }}
          >
            <Icons.RotateCcw aria-hidden size={13} />
            Retry
          </Button>
        )}
      </div>
      {turn.error !== undefined && (
        <p className="whitespace-pre-wrap break-words font-machine text-[11px] text-[var(--muted)]">
          {turn.error}
        </p>
      )}
      {refused !== undefined && <p className="text-[11.5px] text-[#c94c27]">{refused}</p>}
    </div>
  );
}

/** The toggle's mark follows the turn: ✓ done, ● still going, ✕ ended otherwise. */
function outcomeMark(turn: DomainTurn): { glyph: string; color: string; pulse: boolean } {
  if (turn.outcome === 'OK') return { glyph: '✓', color: '#2f9e63', pulse: false };
  if (turn.outcome === 'RUNNING' || turn.outcome === 'WAITING') {
    return { glyph: '●', color: '#ef6b3f', pulse: true };
  }
  return { glyph: '✕', color: '#c94c27', pulse: false };
}

/** "What it did" (D327, D336): the turn's steps with their durations, then its full output. */
function WhatItDid({ turn, output }: { turn: DomainTurn; output: Part[] }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const mark = outcomeMark(turn);
  const timed = turn.steps.filter((step) => step.durationMs !== undefined);
  const total = timed.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="flex cursor-pointer items-center gap-[10px] rounded-[6px] border-none bg-transparent p-0 text-left text-[var(--ink)] outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
      >
        <span
          aria-hidden
          className="text-[13px]"
          style={{
            color: mark.color,
            animation: mark.pulse ? 'livePulse 1s ease-in-out infinite' : undefined,
          }}
        >
          {mark.glyph}
        </span>
        <span className="shrink-0 whitespace-nowrap text-[13.5px] font-bold">What it did</span>
        {turn.steps.length > 0 && (
          <span className="whitespace-nowrap font-machine text-[11px] text-[var(--muted)]">
            {plural(turn.steps.length, 'step')}
            {timed.length > 0 && ` · ${seconds(total)}`}
          </span>
        )}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11.5px] text-[var(--muted)]">
          {open ? (
            <Icons.ChevronDown aria-hidden size={12} />
          ) : (
            <Icons.ChevronRight aria-hidden size={12} />
          )}
          {open ? 'hide' : 'show'}
        </span>
      </button>
      {open && (
        <div id={panel} className="flex flex-col gap-2">
          {turn.steps.length > 0 && (
            <ol className="flex flex-col rounded-[10px] border border-[var(--line)] bg-[var(--soft)]">
              {turn.steps.map((step, index) => {
                const ok = step.status === 'ok';
                const duration = step.durationMs === undefined ? '—' : seconds(step.durationMs);
                return (
                  <li
                    key={step.id}
                    className="flex items-center gap-[10px] border-t px-3 py-[9px] text-[12.5px]"
                    style={{ borderTopColor: index === 0 ? 'transparent' : 'var(--line)' }}
                  >
                    <span
                      aria-hidden
                      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[9px]"
                      style={
                        ok
                          ? { background: 'rgba(47,158,99,0.14)', color: '#2f9e63' }
                          : { background: 'var(--hover)', color: '#c94c27' }
                      }
                    >
                      {ok ? '✓' : '✕'}
                    </span>
                    <span className="min-w-0 flex-1 break-words">{step.label}</span>
                    <span className="shrink-0 font-machine text-[10.5px] text-[var(--muted)]">
                      {ok ? duration : `${step.status} · ${duration}`}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          {output.length > 0 && (
            <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px]">
              {output.map((part, index) =>
                part.type === 'text' ? (
                  <p key={index} className="whitespace-pre-wrap text-[12.5px] leading-[1.55]">
                    {part.text}
                  </p>
                ) : part.type === 'code' ? (
                  <pre
                    key={index}
                    className="whitespace-pre-wrap font-machine text-[11.5px] leading-[1.55]"
                  >
                    {part.text}
                  </pre>
                ) : part.type === 'json' ? (
                  <pre
                    key={index}
                    className="whitespace-pre-wrap font-machine text-[11.5px] leading-[1.55]"
                  >
                    {JSON.stringify(part.value, null, 2)}
                  </pre>
                ) : null,
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const OPEN_CLASS =
  'flex h-7 cursor-pointer items-center whitespace-nowrap rounded-[8px] border border-[var(--line)] bg-[var(--chip)] px-3 text-[12px] font-semibold text-[var(--ink)] no-underline outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/** An output card (D336): the file's name, where it is, and "Open →" — Forge when it is the project's. */
function OutputCard({
  artifact,
  folderPath,
  onOpenFile,
}: {
  artifact: ArtifactRef;
  folderPath: string | undefined;
  onOpenFile: ConversationProps['onOpenFile'];
}) {
  const name = nameOf(artifact.path.replace(/\\/gu, '/'));
  const target = artifactTarget(artifact, folderPath, onOpenFile !== undefined);
  return (
    <div
      data-testid="domain-output"
      className="max-w-[560px] overflow-hidden rounded-[12px] border border-[rgba(47,158,99,0.35)] bg-[var(--surface)]"
    >
      <div className="flex items-center gap-2 border-b border-[rgba(47,158,99,0.25)] bg-[rgba(47,158,99,0.10)] px-[14px] py-[10px] text-[13px] font-bold">
        <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#2f9e63]" />
        <span className="min-w-0 truncate">{name}</span>
      </div>
      <div className="flex items-center gap-[10px] px-[14px] py-[11px]">
        <span className="min-w-0 flex-1 break-all font-machine text-[11.5px] text-[var(--muted)]">
          {artifact.path}
          {artifact.bytes === null ? '' : ` · ${artifact.bytes.toLocaleString('en-US')} bytes`}
        </span>
        {target?.kind === 'forge' ? (
          <button
            type="button"
            aria-label={`Open ${name}`}
            className={OPEN_CLASS}
            onClick={() => onOpenFile?.(target.path)}
          >
            Open
            <Icons.ArrowRight aria-hidden size={12} className="ml-1" />
          </button>
        ) : target?.kind === 'href' ? (
          <a
            href={target.href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${name}`}
            className={OPEN_CLASS}
          >
            Open
            <Icons.ArrowRight aria-hidden size={12} className="ml-1" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

const SMALL_FIELD = cn(INPUT_CLASS, 'h-[30px] w-auto min-w-0 flex-1 px-[10px] text-[12px]');

function HeldActions({
  envelopeId,
  summary,
  onRoute,
}: {
  envelopeId: Id;
  summary: string;
  onRoute: ConversationProps['onRoute'];
}) {
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(summary);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const route = async (body: RouteEnvelopeRequest): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    try {
      await onRoute(envelopeId, body);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-[560px] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void route({ decision: 'approve' })}>
          Approve
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(!editing)}>
          Edit
        </Button>
        <input
          aria-label="Reason"
          className={SMALL_FIELD}
          placeholder="Why (sent to the agent)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() =>
            void route({
              decision: 'reject',
              ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
            })
          }
        >
          Reject
        </Button>
      </div>
      {editing && (
        <div className="flex items-center gap-2">
          <input
            aria-label="Edited summary"
            className={SMALL_FIELD}
            value={edited}
            onChange={(event) => setEdited(event.target.value)}
          />
          <Button
            size="sm"
            disabled={busy || edited.trim() === ''}
            onClick={() => void route({ decision: 'edit', edit: { summary: edited.trim() } })}
          >
            Forward edited
          </Button>
        </div>
      )}
      {failure !== undefined && (
        <p role="alert" className="text-[12px] text-[#c94c27]">
          {failure}
        </p>
      )}
    </div>
  );
}
