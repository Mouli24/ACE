import type { ChatMessage, Node, Part } from '@ace/contracts';
import { cn, PartRenderer } from '@ace/ui';
import { useEffect, useRef, type ReactNode } from 'react';

import { api } from '../app/api';
import { useNodeOverlay } from '../runs/run-store';
import type { AgentLook } from '../theme/agents';
import { fmt } from '../theme/constants';
import { clockTime } from '../theme/format';
import { Avatar } from '../theme/primitives';
import { ChangesCardSlot } from './ChangesCardSlot';
import { ChatActivity } from './ChatActivity';
import {
  CHAT_NOTE_CLASS,
  CHAT_NOTE_HEAD_CLASS,
  ChatRefusalCard,
  ChatVerdicts,
} from './ChatVerdicts';
import type { ChatConversation as Conversation } from './useChat';

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

/** A turn's parts: text through the kit's Markdown in the theme's type, media via PartRenderer. */
function Body({ content }: { content: Part[] }) {
  const contentUrl = (artifactId: string) => api().artifactContentUrl(artifactId);
  return (
    <div className="mt-1 flex flex-col gap-2" data-testid="message-body">
      {content.map((part, index) => (
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

/**
 * The line under an agent turn (FR-CHAT-006, D335): the model that actually answered, its tokens,
 * and whether a run of the node wrote it (D285) — then the theme's "Send to Forge →" chip. Only
 * real values: a turn with none of them has no line.
 */
function TurnMeta({
  message,
  onSendToForge,
}: {
  message: ChatMessage;
  onSendToForge: (() => void) | undefined;
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
  }
  if (message.runId !== undefined) {
    parts.push(
      <span key="run" data-testid="chat-run-badge">
        run
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="min-w-0 text-[10px] text-[var(--muted)]">
        {parts.flatMap((part, index) => (index === 0 ? [part] : [' · ', part]))}
      </span>
      {onSendToForge !== undefined && (
        <button
          type="button"
          data-testid="chat-send-to-forge"
          onClick={onSendToForge}
          className="h-[22px] shrink-0 cursor-pointer whitespace-nowrap rounded-full border border-[var(--line)] bg-[var(--chip)] px-[9px] text-[10px] font-semibold text-[var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
        >
          Send to Forge →
        </button>
      )}
    </div>
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
  onSendToForge,
  speakers,
  projectId,
}: {
  node: Node;
  convo: Conversation;
  /** The input box, when it belongs inside the conversation (the phone tab); the column keeps its own. */
  composer?: ReactNode;
  /** The meta line's "Send to Forge →" (the column only); absent, the chip is not drawn. */
  onSendToForge?: () => void;
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
  const scroller = useRef<HTMLDivElement>(null);
  const run = useNodeOverlay(node.id);
  const running = WORKING.has(run.state);
  const runText =
    run.state === 'WAITING'
      ? 'Waiting for your approval…'
      : run.state === 'RUNNING'
        ? run.streamedText
        : '';
  const typing = convo.awaitingReply || convo.streamingText.length > 0 || run.state === 'RUNNING';
  const hasStreamText = convo.streamingText.length > 0 || runText.length > 0;

  // Follow the tail as turns arrive, the reply streams, the run works and typing starts or stops.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [convo.messages.length, convo.streamingText, convo.refusal, convo.error, typing, runText]);

  const empty =
    convo.messages.length === 0 &&
    !convo.awaitingReply &&
    !running &&
    convo.refusal === undefined &&
    convo.error === undefined;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="chat-conversation"
      data-node-id={node.id}
    >
      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col gap-[20px] overflow-y-auto px-[14px] py-[16px]"
      >
        {empty && (
          <p className="flex flex-1 items-center justify-center text-center text-[13px] text-[var(--muted)]">
            Chat with {node.name} — it answers with its model and goal. Run the workflow and its
            result lands here too.
          </p>
        )}

        {convo.messages.map((message) => {
          const you = message.role === 'user';
          const speaker = you ? undefined : otherSpeaker(message.speakerNodeId);
          const name = you ? 'You' : (speaker?.name ?? node.name);
          return (
            <div key={message.id} data-testid={`chat-turn-${message.role}`}>
              <Row you={you} name={name} at={message.at} speaker={speaker}>
                {message.error !== undefined ? (
                  <div
                    role="alert"
                    data-testid="chat-error-turn"
                    data-code={message.error.code}
                    className={cn(CHAT_NOTE_CLASS, 'mt-1')}
                  >
                    <div className={CHAT_NOTE_HEAD_CLASS}>
                      {name} could not answer · {message.error.code}
                      {message.runId !== undefined && (
                        <span data-testid="chat-run-badge">· run</span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap break-words">{message.error.message}</p>
                  </div>
                ) : (
                  <>
                    <Body content={message.content} />
                    {!you && <TurnMeta message={message} onSendToForge={onSendToForge} />}
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
              </Row>
            </div>
          );
        })}

        {convo.streamingText.length > 0 && (
          <div aria-live="polite" data-testid="chat-streaming">
            <Row you={false} name={replyName} speaker={replying}>
              <Body content={[{ type: 'text', text: convo.streamingText }]} />
            </Row>
          </div>
        )}

        {runText.length > 0 && (
          <div aria-live="polite" data-testid="chat-run-live">
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
            <span aria-hidden className="animate-[livePulse_1s_ease-in-out_infinite]">
              ●
            </span>
            {convo.awaitingReply || convo.streamingText.length > 0 ? replyName : node.name} is
            typing…
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
