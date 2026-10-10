import type { AddressingError, DeliveryMode, Id, NodeState, RosterEntry } from '@ace/contracts';
import { Button } from '@ace/ui';
import { useRef, useState, type KeyboardEvent } from 'react';

import { previewMessage } from './preview';

/**
 * The composer (D3, D4, D324–D326). It previews who a message reaches with the server's own
 * parser, lets the human take a recipient off (sent as `exclude`), refuses to send what the server
 * would refuse, autocompletes `@handles`, and picks queue or interrupt. With no live run, the
 * message starts one, with itself as the goal (D312). An ended run is read-only (D5).
 */

export interface ComposerSend {
  text: string;
  deliveryMode: DeliveryMode;
  exclude?: Id[];
}

export interface ComposerProps {
  roster: readonly RosterEntry[];
  states: Readonly<Record<Id, NodeState>>;
  /** A live run takes messages; without one, the message starts a run. */
  live: boolean;
  readOnly?: boolean;
  onSend(body: ComposerSend): Promise<unknown>;
  onStart(goal: string): Promise<unknown>;
}

function describe(error: AddressingError): string {
  if (error.code === 'unknown_handle') {
    const near = error.suggestions ?? [];
    return `${error.handle ?? 'That handle'} is not on the team${near.length === 0 ? '' : ` — did you mean ${near.join(' or ')}?`}`;
  }
  if (error.code === 'ambiguous_name' && error.handles !== undefined) {
    return `${error.message} (${error.handles.join(', ')})`;
  }
  return error.message;
}

/** The `@partial` the caret sits at the end of, if any. */
function partialAt(text: string, caret: number): { start: number; partial: string } | undefined {
  const match = /(^|\s)@([a-z0-9-]*)$/iu.exec(text.slice(0, caret));
  if (match === null) return undefined;
  return { start: caret - (match[2]?.length ?? 0) - 1, partial: (match[2] ?? '').toLowerCase() };
}

export function Composer({
  roster,
  states,
  live,
  readOnly = false,
  onSend,
  onStart,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [mode, setMode] = useState<DeliveryMode>('queue');
  const [exclude, setExclude] = useState<Id[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const box = useRef<HTMLTextAreaElement>(null);

  // A removal only stands while the text still addresses that node.
  const base = previewMessage({ text, roster, states, exclude: [], deliveryMode: mode });
  const kept = exclude.filter((nodeId) => base.reaches.some((entry) => entry.nodeId === nodeId));
  const preview =
    kept.length === 0
      ? base
      : previewMessage({ text, roster, states, exclude: kept, deliveryMode: mode });

  const at = live && !readOnly ? partialAt(text, caret) : undefined;
  const options =
    at === undefined
      ? []
      : [...roster.map((entry) => entry.handle), 'all'].filter((handle) =>
          handle.startsWith(at.partial),
        );

  const complete = (handle: string): void => {
    if (at === undefined) return;
    const next = `${text.slice(0, at.start)}@${handle} ${text.slice(caret)}`;
    const position = at.start + handle.length + 2;
    setText(next);
    setCaret(position);
    box.current?.focus();
  };

  const canSend = !readOnly && !busy && (live ? preview.canSend : text.trim() !== '');

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    setBusy(true);
    setFailure(undefined);
    try {
      if (live) {
        await onSend({
          text,
          deliveryMode: mode,
          ...(kept.length === 0 ? {} : { exclude: kept }),
        });
      } else {
        await onStart(text);
      }
      setText('');
      setExclude([]);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const errors = live ? preview.errors.map(describe) : [];
  if (failure !== undefined) errors.push(failure);

  return (
    <form
      aria-label="Composer"
      className="flex flex-col gap-2 border-t border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {readOnly && (
        <p className="text-xs text-fg-muted">This run has ended — its conversation is read-only.</p>
      )}
      <textarea
        ref={box}
        aria-label="Message"
        className="min-h-[64px] w-full rounded border border-border bg-transparent p-2 text-sm"
        placeholder={
          live
            ? 'Write to the team — name a node, or @handle it. Unaddressed goes to the Brain.'
            : 'Write a goal to start a run.'
        }
        value={text}
        disabled={readOnly}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />

      {options.length > 0 && (
        <ul role="listbox" aria-label="Handles" className="flex flex-wrap gap-1 text-xs">
          {options.map((handle) => (
            <li
              key={handle}
              role="option"
              aria-selected={false}
              className="cursor-pointer rounded border border-border px-1"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => complete(handle)}
            >
              @{handle}
            </li>
          ))}
        </ul>
      )}

      {live && !readOnly && preview.canSend && (
        <div data-testid="composer-reaches" className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-fg-muted">
            {preview.addressing === 'unaddressed' ? 'Goes to the Brain:' : 'Reaches:'}
          </span>
          {preview.reaches.map((entry) => (
            <span
              key={entry.nodeId}
              data-testid="recipient"
              data-handle={entry.handle}
              className="inline-flex items-center gap-1 rounded border border-border px-1"
            >
              @{entry.handle}
              {preview.addressing !== 'unaddressed' && (
                <button
                  type="button"
                  aria-label={`Remove @${entry.handle}`}
                  onClick={() => setExclude([...kept, entry.nodeId])}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {live && !readOnly && preview.skips.length > 0 && (
        <div data-testid="composer-skips" className="text-xs text-fg-muted">
          Skips (finished): {preview.skips.map((entry) => `@${entry.handle}`).join(', ')}
        </div>
      )}
      {!live && !readOnly && (
        <p className="text-xs text-fg-muted">
          No run is going: this starts one, with your message as its goal.
        </p>
      )}
      {errors.length > 0 && (
        <div role="alert" className="text-xs text-danger">
          {errors.map((each) => (
            <p key={each}>{each}</p>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="flex items-center gap-3">
          {live && (
            <fieldset className="flex items-center gap-2 text-xs">
              <legend className="sr-only">Delivery</legend>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="delivery"
                  checked={mode === 'queue'}
                  onChange={() => setMode('queue')}
                />
                Queue
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="delivery"
                  checked={mode === 'interrupt'}
                  onChange={() => setMode('interrupt')}
                />
                Interrupt
              </label>
            </fieldset>
          )}
          <div className="flex-1" />
          <Button type="submit" size="sm" disabled={!canSend}>
            {live ? 'Send' : 'Start team run'}
          </Button>
        </div>
      )}
    </form>
  );
}
