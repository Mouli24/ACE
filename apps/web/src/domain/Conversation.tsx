import type { DomainMessage, Id, RosterEntry, RouteEnvelopeRequest } from '@ace/contracts';
import { Button } from '@ace/ui';
import { useState } from 'react';

import { openArtifactHref } from './open-artifact';

/**
 * The conversation (D5, D8, D303, D310, D327): every message the server projected, in cursor
 * order. A human message shows whom it went to and how far each delivery got; an envelope shows
 * from → to, its kind and what the router did, and — while held — the human's approve, edit and
 * reject; an agent message expands to its steps and full output, and its files open through the
 * D307 seam.
 */

export interface ConversationProps {
  messages: readonly DomainMessage[];
  roster: readonly RosterEntry[];
  /** Every node of the run's snapshot by id, so one without a handle (an Input) has its name. */
  names?: ReadonlyMap<Id, string>;
  /** Live text of the turns still running, by turn id. */
  tokens: Readonly<Record<string, string>>;
  readOnly: boolean;
  onRoute(envelopeId: Id, body: RouteEnvelopeRequest): Promise<unknown>;
}

export function Conversation({
  messages,
  roster,
  names,
  tokens,
  readOnly,
  onRoute,
}: ConversationProps) {
  const label = (nodeId: Id | undefined): string => {
    if (nodeId === undefined) return '?';
    const entry = roster.find((each) => each.nodeId === nodeId);
    return entry === undefined ? (names?.get(nodeId) ?? nodeId) : `@${entry.handle}`;
  };
  const handle = (nodeId: Id): string =>
    roster.find((each) => each.nodeId === nodeId)?.handle ?? nodeId;

  if (messages.length === 0) {
    return <p className="p-3 text-sm text-fg-muted">Nothing has been said in this run yet.</p>;
  }

  return (
    <ol aria-label="Conversation" className="flex flex-col gap-2 p-3">
      {messages.map((message) => (
        <li
          key={message.id}
          data-testid="domain-message"
          data-type={message.type}
          className={`rounded border border-border p-2 text-sm ${message.level === 'warn' ? 'border-warn' : ''} ${message.level === 'error' ? 'border-danger' : ''}`}
        >
          <MessageHeader message={message} label={label} />
          <Body
            message={message}
            label={label}
            handle={handle}
            live={message.turn === undefined ? undefined : tokens[message.turn.turnId]}
            readOnly={readOnly}
            onRoute={onRoute}
          />
        </li>
      ))}
    </ol>
  );
}

function MessageHeader({
  message,
  label,
}: {
  message: DomainMessage;
  label: (id: Id | undefined) => string;
}) {
  const who =
    message.author.kind === 'human'
      ? 'You'
      : message.author.kind === 'system'
        ? 'System'
        : `${label(message.author.nodeId)}${message.author.kind === 'brain' ? ' (Brain)' : ''}`;
  const to = message.type === 'envelope' ? [] : (message.to ?? []);
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-xs text-fg-muted">
      <strong className="text-fg">{who}</strong>
      {to.length > 0 && <span>→ {to.map(label).join(', ')}</span>}
      <time dateTime={message.at}>{new Date(message.at).toLocaleTimeString()}</time>
    </div>
  );
}

interface BodyProps {
  message: DomainMessage;
  label: (id: Id | undefined) => string;
  handle: (id: Id) => string;
  live: string | undefined;
  readOnly: boolean;
  onRoute: ConversationProps['onRoute'];
}

function Body({ message, label, handle, live, readOnly, onRoute }: BodyProps) {
  if (message.type === 'envelope' && message.envelope !== undefined) {
    const envelope = message.envelope;
    return (
      <div>
        <div className="text-xs">
          <span>
            {label(envelope.from)} → {(message.to ?? []).map(label).join(', ')}
          </span>{' '}
          · <span>{envelope.kind}</span> ·{' '}
          <span data-testid="envelope-routing">{envelope.routing ?? 'sent'}</span>
          {envelope.inReplyTo !== undefined && <span> · in reply to {envelope.inReplyTo}</span>}
        </div>
        <p>
          {message.text}
          {message.textSource === 'auto' && (
            <span className="ml-1 text-[10px] text-fg-muted">auto</span>
          )}
        </p>
        {envelope.original !== undefined && (
          <p className="text-xs text-fg-muted">
            The agent wrote: {envelope.original.kind} to{' '}
            {envelope.original.to.map(label).join(', ')}: {envelope.original.summary}
          </p>
        )}
        {envelope.history.length > 0 && (
          <p className="text-xs text-fg-muted">
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
      </div>
    );
  }

  const turn = message.turn;
  return (
    <div>
      <p className="whitespace-pre-wrap">
        {message.text === '' && live !== undefined ? live : message.text}
        {message.textSource === 'auto' && (
          <span className="ml-1 text-[10px] text-fg-muted">auto</span>
        )}
      </p>
      {message.delivery !== undefined && message.delivery.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1 text-xs">
          {message.delivery.map((entry) => (
            <span
              key={entry.nodeId}
              data-testid={`delivery-${handle(entry.nodeId)}`}
              className="rounded border border-border px-1"
            >
              @{handle(entry.nodeId)} {entry.state}
            </span>
          ))}
        </div>
      )}
      {turn !== undefined && (
        <div className="mt-1 text-xs text-fg-muted">
          {turn.trigger !== 'dispatch' && <span>{turn.trigger} · </span>}
          <span>{turn.outcome}</span>
          {turn.durationMs !== undefined && <span> · {(turn.durationMs / 1000).toFixed(1)} s</span>}
          {turn.error !== undefined && <span> · {turn.error}</span>}
        </div>
      )}
      {turn !== undefined && (turn.steps.length > 0 || (message.output?.length ?? 0) > 0) && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer">Steps and output</summary>
          {turn.steps.length > 0 && (
            <ol className="ml-4 list-decimal">
              {turn.steps.map((step) => (
                <li key={step.id}>
                  {step.label} <span className="text-fg-muted">{step.status}</span>
                </li>
              ))}
            </ol>
          )}
          {(message.output ?? []).map((part, index) =>
            part.type === 'text' || part.type === 'code' ? (
              <pre key={index} className="whitespace-pre-wrap">
                {part.text}
              </pre>
            ) : part.type === 'json' ? (
              <pre key={index} className="whitespace-pre-wrap">
                {JSON.stringify(part.value, null, 2)}
              </pre>
            ) : null,
          )}
        </details>
      )}
      {message.artifacts !== undefined && message.artifacts.length > 0 && (
        <ul className="mt-1 text-xs">
          {message.artifacts.map((ref) => {
            const href = openArtifactHref(ref);
            const name = `${ref.path}${ref.bytes === null ? '' : ` (${ref.bytes.toLocaleString('en-US')} bytes)`}`;
            return (
              <li key={`${ref.path}:${ref.artifactId ?? ''}`}>
                {href === undefined ? (
                  name
                ) : (
                  <a href={href} target="_blank" rel="noreferrer" className="underline">
                    {name}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

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
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" disabled={busy} onClick={() => void route({ decision: 'approve' })}>
          Approve
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(!editing)}>
          Edit
        </Button>
        <input
          aria-label="Reason"
          className="rounded border border-border bg-transparent px-1 text-xs"
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
        <div className="flex items-center gap-1">
          <input
            aria-label="Edited summary"
            className="flex-1 rounded border border-border bg-transparent px-1 text-xs"
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
        <p role="alert" className="text-xs text-danger">
          {failure}
        </p>
      )}
    </div>
  );
}
