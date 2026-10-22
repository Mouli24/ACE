import {
  parseWorkflowAddress,
  type AddressingError,
  type DeliveryMode,
  type Id,
  type NodeState,
  type RosterEntry,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { Button, cn, Icons, MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from '@ace/ui';
import { useRef, useState, type KeyboardEvent } from 'react';

import { Avatar } from '../theme/primitives';
import { lookOf, type DomainLooks } from './looks';
import { previewMessage } from './preview';

/**
 * The composer (D3, D4, D324–D326) in the theme's Domain card (D336). It previews who a message
 * reaches with the server's own parser, lets the human take a recipient off (sent as `exclude`),
 * refuses to send what the server would refuse, autocompletes `@handles`, offers a mention chip per
 * agent, and picks queue or interrupt. Enter sends, Shift+Enter breaks a line. With no live run,
 * the message starts one, with itself as the goal (D312). An ended run is read-only (D5).
 */

export interface ComposerSend {
  text: string;
  deliveryMode: DeliveryMode;
  exclude?: Id[];
}

export interface ComposerProps {
  roster: readonly RosterEntry[];
  states: Readonly<Record<Id, NodeState>>;
  /** Each agent's colour and letter, for the mention chips (D328). */
  looks?: DomainLooks;
  /** A live run takes messages; without one, the message starts a run. */
  live: boolean;
  /** The run shown has ended: its conversation is read-only, and a message starts a new run. */
  ended?: boolean;
  readOnly?: boolean;
  onSend(body: ComposerSend): Promise<unknown>;
  onStart(goal: string): Promise<unknown>;
  /**
   * `@workflow <task>`: run the whole workflow on the task — a new run that completes on its own,
   * not one that stays open. Only once the run shown has ended (or with none); without it,
   * `@workflow` is read like any other text.
   */
  onWorkflow?(task: string): Promise<unknown>;
  /** Why `@workflow` cannot start a run right now, beyond the run shown being live. */
  workflowBlocked?: string | undefined;
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

const NOTE = 'text-[11.5px] text-[var(--muted)]';
const CHIP =
  'flex h-[22px] items-center gap-1 rounded-full border border-[var(--line)] px-2 font-machine text-[10.5px] text-[var(--ink)]';

export function Composer({
  roster,
  states,
  looks,
  live,
  ended = false,
  readOnly = false,
  onSend,
  onStart,
  onWorkflow,
  workflowBlocked,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [mode, setMode] = useState<DeliveryMode>('queue');
  const [exclude, setExclude] = useState<Id[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  /**
   * PG-1.5: the post failed, and its text is still in the box. `ended`: the engine refused it
   * because the run has ended (409), so it is offered as a new run's goal instead.
   */
  const [unsent, setUnsent] = useState<{ text: string; ended: boolean }>();
  const box = useRef<HTMLTextAreaElement>(null);

  // A removal only stands while the text still addresses that node.
  const base = previewMessage({ text, roster, states, exclude: [], deliveryMode: mode });
  const kept = exclude.filter((nodeId) => base.reaches.some((entry) => entry.nodeId === nodeId));
  const preview =
    kept.length === 0
      ? base
      : previewMessage({ text, roster, states, exclude: kept, deliveryMode: mode });

  // `@workflow <task>`: the whole workflow, as a new run (only once nothing is live).
  const workflow = onWorkflow === undefined ? undefined : parseWorkflowAddress(text);
  const workflowError =
    workflow === undefined
      ? undefined
      : live
        ? 'A run is going — @workflow starts a new run once this one has ended.'
        : (workflowBlocked ??
          (workflow.task === '' ? 'Say what the workflow should do after @workflow.' : undefined));

  const at = !readOnly && (live || onWorkflow !== undefined) ? partialAt(text, caret) : undefined;
  const options =
    at === undefined
      ? []
      : (live ? [...roster.map((entry) => entry.handle), 'all'] : ['workflow']).filter((handle) =>
          handle.startsWith(at.partial),
        );

  const place = (next: string, position: number): void => {
    setText(next);
    setCaret(position);
    const element = box.current;
    if (element === null) return;
    element.focus();
    // After React writes the value, so the caret lands where the handle ends.
    requestAnimationFrame(() => element.setSelectionRange(position, position));
  };

  const complete = (handle: string): void => {
    if (at === undefined) return;
    const next = `${text.slice(0, at.start)}@${handle} ${text.slice(caret)}`;
    place(next, at.start + handle.length + 2);
  };

  /** A mention chip appends the agent's handle, with a space before it when needed (D336). */
  const mention = (handle: string): void => {
    const next = `${text !== '' && !/\s$/u.test(text) ? `${text} ` : text}@${handle} `;
    place(next, next.length);
  };

  const canSend =
    !readOnly &&
    !busy &&
    (workflow !== undefined
      ? workflowError === undefined
      : live
        ? preview.canSend
        : text.trim() !== '');

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    setBusy(true);
    setFailure(undefined);
    setUnsent(undefined);
    try {
      if (workflow !== undefined && onWorkflow !== undefined) {
        await onWorkflow(workflow.task);
      } else if (live) {
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
      // PG-1.5: the text stays in the box; the failure says why and offers to send it again.
      const ended = live && AceApiError.is(error) && error.status === 409;
      setUnsent({ text, ended });
      if (!ended) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  /** PG-1.5: a run that has ended takes the message as a new run's goal (D312). */
  const startNew = async (): Promise<void> => {
    if (unsent === undefined) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await onStart(unsent.text);
      setText('');
      setExclude([]);
      setUnsent(undefined);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // D336: Enter sends, Shift+Enter breaks the line; an IME composition keeps its Enter.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const errors =
    workflow !== undefined
      ? workflowError === undefined
        ? []
        : [workflowError]
      : live
        ? preview.errors.map(describe)
        : [];
  if (failure !== undefined) errors.push(failure);
  const writable = !readOnly;

  return (
    <form
      aria-label="Composer"
      className="relative border-t border-[var(--line)] px-6 pb-[18px] pt-[14px]"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="mx-auto max-w-[860px] rounded-[14px] border border-[var(--line)] bg-[var(--surface)] pb-[10px] pl-4 pr-3 pt-3 has-[textarea:focus-visible]:border-[#ef6b3f]">
        <textarea
          ref={box}
          aria-label="Message"
          rows={2}
          className="block w-full resize-none border-none bg-transparent text-[14px] leading-[1.5] text-[var(--ink)] outline-none placeholder:text-[var(--muted)] disabled:cursor-not-allowed"
          placeholder="Message the team… @ to tag an agent, / for commands"
          value={text}
          disabled={readOnly}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />

        <div className="flex flex-col gap-1.5 empty:hidden">
          {options.length > 0 && (
            <ul
              role="listbox"
              aria-label="Handles"
              className={cn(MENU_CONTENT_CLASS, 'mt-1.5 w-fit min-w-[160px]')}
            >
              {options.map((handle) => (
                <li
                  key={handle}
                  role="option"
                  aria-selected={false}
                  className={cn(
                    MENU_ITEM_CLASS,
                    'font-machine text-[11.5px] hover:bg-[rgba(239,107,63,0.12)]',
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => complete(handle)}
                >
                  @{handle}
                  {handle === 'workflow' && (
                    <span className="ml-2 font-human text-[var(--muted)]">
                      — run the whole workflow on this task
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {live && writable && workflow === undefined && preview.canSend && (
            <div
              data-testid="composer-reaches"
              className="mt-1.5 flex flex-wrap items-center gap-1.5"
            >
              <span className={NOTE}>
                {preview.addressing === 'unaddressed' ? 'Goes to the Brain:' : 'Reaches:'}
              </span>
              {preview.reaches.map((entry) => (
                <span
                  key={entry.nodeId}
                  data-testid="recipient"
                  data-handle={entry.handle}
                  className={CHIP}
                >
                  @{entry.handle}
                  {preview.addressing !== 'unaddressed' && (
                    <button
                      type="button"
                      aria-label={`Remove @${entry.handle}`}
                      className="-mr-1 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                      onClick={() => setExclude([...kept, entry.nodeId])}
                    >
                      <Icons.X aria-hidden size={10} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {live && writable && preview.skips.length > 0 && (
            <div data-testid="composer-skips" className={NOTE}>
              Skips (finished): {preview.skips.map((entry) => `@${entry.handle}`).join(', ')}
            </div>
          )}
          {live && writable && (
            <fieldset className="mt-1.5 flex items-center gap-3">
              <legend className="sr-only">Delivery</legend>
              {(['queue', 'interrupt'] as const).map((each) => (
                <label
                  key={each}
                  className={cn(NOTE, 'flex cursor-pointer items-center gap-1.5', {
                    'text-[var(--ink)]': mode === each,
                  })}
                >
                  <input
                    type="radio"
                    name="delivery"
                    className="m-0 h-3 w-3 cursor-pointer accent-[#ef6b3f]"
                    checked={mode === each}
                    onChange={() => setMode(each)}
                  />
                  {each === 'queue' ? 'Queue' : 'Interrupt'}
                </label>
              ))}
            </fieldset>
          )}
          {readOnly && (
            <p className={cn(NOTE, 'mt-1.5')}>
              This run has ended — its conversation is read-only.
            </p>
          )}
          {!live && writable && (
            <p className={cn(NOTE, 'mt-1.5')}>
              {workflow !== undefined
                ? 'Starts a new run of the whole workflow, with your task as its goal and its input.'
                : ended
                  ? 'This run has ended — its conversation is read-only. Sending starts a new run, with your message as its goal.'
                  : 'No run is going: this starts one, with your message as its goal.'}
            </p>
          )}
          {errors.length > 0 && (
            <div role="alert" className="mt-1.5 text-[11.5px] text-danger">
              {errors.map((each) => (
                <p key={each}>{each}</p>
              ))}
            </div>
          )}
          {unsent !== undefined && writable && (
            <div
              role="alert"
              data-testid="composer-unsent"
              className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px]"
            >
              {unsent.ended ? (
                <>
                  <span className="text-danger">
                    This run has ended, so it takes no more messages.
                  </span>
                  <Button type="button" size="sm" disabled={busy} onClick={() => void startNew()}>
                    Start a new run with this message
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-[var(--muted)]">Your message was not sent.</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy || text.trim() === ''}
                    onClick={() => void submit()}
                  >
                    <Icons.RotateCcw aria-hidden size={13} />
                    Resend
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        {writable && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex flex-1 flex-wrap items-center gap-1.5">
              {live &&
                roster.map((entry, index) => {
                  const look = lookOf(looks, entry.nodeId, entry.name, index);
                  return (
                    <button
                      key={entry.nodeId}
                      type="button"
                      className="flex h-[26px] cursor-pointer items-center gap-[5px] rounded-full border border-[var(--line)] bg-transparent pl-1 pr-[9px] font-machine text-[10.5px] text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                      onClick={() => mention(entry.handle)}
                    >
                      <Avatar
                        letter={look.letter}
                        color={look.color}
                        size={16}
                        fontSize={8}
                        className="font-human"
                      />
                      @{entry.handle}
                    </button>
                  );
                })}
              {!live && (
                <span className="ml-1 whitespace-nowrap text-[11.5px] text-[var(--muted)]">
                  Enter starts a team run
                </span>
              )}
            </div>
            <button
              type="submit"
              aria-label={live ? 'Send' : 'Start team run'}
              disabled={!canSend}
              className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border-none text-[#fff] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)] disabled:cursor-not-allowed"
              style={{
                background: text.trim() !== '' && canSend ? '#ef6b3f' : 'var(--sendOff)',
              }}
            >
              <Icons.ArrowUp aria-hidden size={17} strokeWidth={2.5} />
            </button>
          </div>
        )}
      </div>
    </form>
  );
}
