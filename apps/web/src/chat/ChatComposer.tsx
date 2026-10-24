import {
  parseDebateAddress,
  parseWorkflowAddress,
  type Artifact,
  type Part,
  type RosterEntry,
} from '@ace/contracts';
import {
  cn,
  formatBytes,
  Icons,
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
} from '@ace/ui';
import { useEffect, useRef, useState } from 'react';

import { api } from '../app/api';
import { Avatar } from '../theme/primitives';
import { chipLabel, chipPart, useComposerChips } from './composer-chips';
import { partForArtifact } from './parts';
import { completeHandle, handleOptions, handlePartial, previewChatTarget } from './target';

/** A roster entry with the avatar the picker draws beside it (`agentsOf`, D328). */
export interface ChatRosterEntry extends RosterEntry {
  letter: string;
  color: string;
}

/** The theme's composer placeholder (D335). */
export const TEAM_PLACEHOLDER = 'Message the team… @ to tag an agent, / for commands';

const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]';
const CHIP =
  'flex h-[24px] max-w-full items-center gap-[6px] rounded-full border border-[var(--line)] bg-[var(--chip)] pl-[9px] pr-[6px] text-[11px] text-[var(--ink)]';
const CHIP_REMOVE = cn(
  FOCUS,
  'flex h-[16px] w-[16px] shrink-0 cursor-pointer items-center justify-center rounded-full text-[9px] text-[var(--muted)] hover:text-danger',
);

/**
 * The chat composer (FR-CHAT-004/007, D302), as the theme's Team chat composer (D335): a surface
 * card with a two-row textarea, Attach and Send. Enter sends, Shift+Enter breaks a line, so the
 * whole thing is reachable from the keyboard alone (NFR-USE-03). PG-1.6 (D352): while a reply is
 * on its way, Stop stands beside Send and aborts it.
 *
 * D302: a message goes to the conversation's main node, or — with one `@handle` in it — to that
 * node of the workflow, inside the same conversation. `@` opens a picker that completes the
 * handle; the line under the box says who the message goes to, or why it cannot go, by the
 * engine's own rule. The session never switches. Forge's Ask agent and Fix with agent put
 * reference chips here (`useComposerChips`), sent as `code` parts with their path and lines.
 */
export function ChatComposer({
  onSend,
  disabled,
  placeholder = TEAM_PLACEHOLDER,
  roster = [],
  mainNodeId,
  replying = false,
  queued = 0,
  onStop,
  onWorkflow,
  workflowBlocked,
  debate,
  onDebate,
}: {
  /** `targetNodeId` is set when an `@handle` names a node other than the main one. */
  onSend: (content: Part[], targetNodeId: string | undefined) => void;
  disabled: boolean;
  placeholder?: string;
  /** The workflow's agents and models, for `@handle`. Empty: every message is the main node's. */
  roster?: readonly ChatRosterEntry[];
  /** The conversation's main node; without one there is nobody to send to. */
  mainNodeId: string | undefined;
  /** PG-1.6: a reply is on its way in this session, so Stop is offered (D391: while any is). */
  replying?: boolean;
  /**
   * D391: turns sent after the one being answered that still wait their turn in the engine's
   * queue. Above zero — more than one turn outstanding — the composer says "N queued".
   */
  queued?: number;
  /** PG-1.6: abort the reply on its way; it is stored as `user_cancelled`. */
  onStop?: () => void;
  /**
   * `@workflow <task>`: run the whole workflow on the task. `extra` is what else the message
   * carries (reference chips, attachments). Without it, `@workflow` is not offered.
   */
  onWorkflow?: (task: string, extra: Part[]) => void;
  /** Why `@workflow` cannot start a run right now (one is going), or nothing. */
  workflowBlocked?: string | undefined;
  /**
   * D405 `@debate <task>`: the conversation's node and the one its debate edge joins it to argue
   * it out. `ready` says who debates, for the line under the box; `blocked` says why it cannot.
   * Absent, `@debate` is not offered.
   */
  debate?: { ready: string } | { blocked: string };
  /** Sends the whole message, `@debate` and all, as the debate's opening turn. */
  onDebate?: (content: Part[]) => void;
}) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [attachments, setAttachments] = useState<Artifact[]>([]);
  const [uploadError, setUploadError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const chips = useComposerChips((state) => state.chips);
  const draft = useComposerChips((state) => state.draft);

  // A chip or a draft from Forge brings the keyboard here, and a draft fills the box once.
  const chipCount = chips.length;
  const seenChips = useRef(chipCount);
  useEffect(() => {
    if (chipCount > seenChips.current) box.current?.focus();
    seenChips.current = chipCount;
  }, [chipCount]);
  useEffect(() => {
    if (draft === undefined) return;
    const taken = useComposerChips.getState().takeDraft();
    if (taken === undefined) return;
    setText(taken);
    setCaret(taken.length);
    box.current?.focus();
  }, [draft]);

  const at =
    roster.length === 0 && onWorkflow === undefined && debate === undefined
      ? undefined
      : handlePartial(text, caret);
  // `@workflow` heads the picker: the whole workflow, before any one node of it.
  const workflowOffered =
    onWorkflow !== undefined && at !== undefined && 'workflow'.startsWith(at.partial);
  // D405: `@debate` next, while this conversation's node can debate.
  const debateOffered =
    debate !== undefined &&
    'ready' in debate &&
    at !== undefined &&
    'debate'.startsWith(at.partial);
  const matches: Array<ChatRosterEntry | 'workflow' | 'debate'> =
    at === undefined
      ? []
      : [
          ...(workflowOffered ? ['workflow' as const] : []),
          ...(debateOffered ? ['debate' as const] : []),
          ...handleOptions(roster, at.partial),
        ];
  const pickerOpen = matches.length > 0;
  const active = Math.min(cursor, Math.max(matches.length - 1, 0));

  // A message whose first address is `@workflow` starts a run of the whole workflow instead.
  const workflow = onWorkflow === undefined ? undefined : parseWorkflowAddress(text);
  const workflowError =
    workflow === undefined
      ? undefined
      : (workflowBlocked ??
        (workflow.task === '' ? 'Say what the workflow should do after @workflow.' : undefined));
  // D405: a message whose first address is `@debate` starts a debate instead.
  const debateAsk = debate === undefined ? undefined : parseDebateAddress(text);
  const debateError =
    debateAsk === undefined || debate === undefined
      ? undefined
      : 'blocked' in debate
        ? debate.blocked
        : debateAsk.task === ''
          ? 'Say what to debate after @debate.'
          : undefined;
  const preview =
    workflow !== undefined || debateAsk !== undefined || mainNodeId === undefined
      ? undefined
      : previewChatTarget(text, roster, mainNodeId);
  const hasBody = text.trim().length > 0 || attachments.length > 0 || chips.length > 0;
  const canSend =
    !disabled &&
    !uploading &&
    hasBody &&
    (workflow !== undefined
      ? workflowError === undefined
      : debateAsk !== undefined
        ? debateError === undefined && onDebate !== undefined
        : preview !== undefined && preview.canSend);

  const place = (next: string, position: number): void => {
    setText(next);
    setCaret(position);
    setCursor(0);
    const element = box.current;
    if (element === null) return;
    element.focus();
    // After React writes the value, so the caret lands where the handle ends.
    requestAnimationFrame(() => element.setSelectionRange(position, position));
  };

  const pick = (entry: ChatRosterEntry | 'workflow' | 'debate') => {
    if (at === undefined) return;
    const handle = typeof entry === 'string' ? entry : entry.handle;
    const completed = completeHandle(text, at, caret, handle);
    place(completed.text, completed.caret);
  };

  const submit = () => {
    if (!canSend) return;
    const extra: Part[] = [];
    for (const chip of chips) extra.push(chipPart(chip));
    for (const artifact of attachments) extra.push(partForArtifact(artifact));
    if (workflow !== undefined && onWorkflow !== undefined) {
      onWorkflow(workflow.task, extra);
    } else if (debateAsk !== undefined && onDebate !== undefined) {
      onDebate([{ type: 'text', text: text.trim() }, ...extra]);
    } else {
      if (preview === undefined) return;
      const content: Part[] = [];
      if (text.trim().length > 0) content.push({ type: 'text', text: text.trim() });
      content.push(...extra);
      const target = preview.targetNodeId === mainNodeId ? undefined : preview.targetNodeId;
      onSend(content, target);
    }
    setText('');
    setCaret(0);
    setAttachments([]);
    setUploadError(undefined);
    useComposerChips.getState().clear();
  };

  const onFiles = async (files: FileList | null) => {
    if (files === null || files.length === 0) return;
    setUploadError(undefined);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const artifact = await api().uploadArtifact(file);
        setAttachments((current) => [...current, artifact]);
      }
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : 'The attachment could not be uploaded.',
      );
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const showPreview = preview !== undefined && text.trim() !== '';
  const showWorkflow = workflow !== undefined && workflowError === undefined;
  const showDebate =
    debateAsk !== undefined &&
    debateError === undefined &&
    debate !== undefined &&
    'ready' in debate;

  return (
    <div
      className="relative flex flex-col gap-[10px] px-[14px] pb-[14px] pt-[12px]"
      data-testid="chat-composer"
    >
      {pickerOpen && (
        <div
          role="listbox"
          aria-label="Nodes"
          data-testid="chat-mention-picker"
          className={cn(
            MENU_CONTENT_CLASS,
            'absolute bottom-[calc(100%-4px)] left-[14px] right-[14px] z-10',
          )}
        >
          <span className={MENU_LABEL_CLASS}>Ask a node</span>
          {matches.map((entry, index) =>
            entry === 'workflow' ? (
              <button
                key="workflow"
                type="button"
                role="option"
                aria-selected={index === active}
                data-testid="chat-mention-option-workflow"
                data-highlighted={index === active ? '' : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(entry)}
                className={cn(MENU_ITEM_CLASS, 'text-left hover:bg-[rgba(239,107,63,0.12)]')}
              >
                <Avatar
                  letter="✳"
                  color="#7a62d6"
                  size={16}
                  fontSize={8}
                  className="font-semibold"
                />
                <span className="min-w-0 truncate">
                  <span className="font-machine">@workflow</span>
                  <span className="text-[var(--muted)]">
                    {' '}
                    — run the whole workflow on this task
                  </span>
                </span>
              </button>
            ) : entry === 'debate' ? (
              <button
                key="debate"
                type="button"
                role="option"
                aria-selected={index === active}
                data-testid="chat-mention-option-debate"
                data-highlighted={index === active ? '' : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(entry)}
                className={cn(MENU_ITEM_CLASS, 'text-left hover:bg-[rgba(239,107,63,0.12)]')}
              >
                <Avatar
                  letter="⇄"
                  color="#c94c27"
                  size={16}
                  fontSize={8}
                  className="font-semibold"
                />
                <span className="min-w-0 truncate">
                  <span className="font-machine">@debate</span>
                  <span className="text-[var(--muted)]"> — let the agents argue it out</span>
                </span>
              </button>
            ) : (
              <button
                key={entry.nodeId}
                type="button"
                role="option"
                aria-selected={index === active}
                data-testid={`chat-mention-option-${entry.nodeId}`}
                data-highlighted={index === active ? '' : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(entry)}
                className={cn(MENU_ITEM_CLASS, 'text-left hover:bg-[rgba(239,107,63,0.12)]')}
              >
                <Avatar
                  letter={entry.letter}
                  color={entry.color}
                  size={16}
                  fontSize={8}
                  className="font-semibold"
                />
                <span className="min-w-0 truncate">{entry.name}</span>
                <span className="ml-auto font-machine text-[9px] text-[var(--muted)]">
                  @{entry.handle}
                </span>
              </button>
            ),
          )}
        </div>
      )}

      {queued > 0 && (
        <p
          role="status"
          data-testid="chat-queued"
          title={`${queued} more ${queued === 1 ? 'message waits' : 'messages wait'} for the reply before ${queued === 1 ? 'it' : 'them'}; each is answered in turn`}
          className="flex items-center gap-[6px] text-[10.5px] text-[var(--muted)]"
        >
          <Icons.ListOrdered aria-hidden size={12} />
          {queued} queued
        </p>
      )}

      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-[6px]" data-testid="chat-chips" aria-label="References">
          {chips.map((chip) => {
            const label = chipLabel(chip);
            return (
              <li key={chip.id} className={CHIP} title={label}>
                <span aria-hidden className="text-[10px] text-[var(--muted)]">
                  {'</>'}
                </span>
                <span className="max-w-[14rem] truncate font-machine">{label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  onClick={() => useComposerChips.getState().remove(chip.id)}
                  className={CHIP_REMOVE}
                >
                  <Icons.X aria-hidden size={10} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-[6px]" data-testid="chat-attachments">
          {attachments.map((artifact) => (
            <li key={artifact.id} className={CHIP}>
              <span className="max-w-[10rem] truncate font-machine" title={artifact.name}>
                {artifact.name}
              </span>
              <span className="shrink-0 text-[var(--muted)]">{formatBytes(artifact.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${artifact.name}`}
                onClick={() =>
                  setAttachments((current) => current.filter((each) => each.id !== artifact.id))
                }
                className={CHIP_REMOVE}
              >
                <Icons.X aria-hidden size={10} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {uploadError !== undefined && (
        <p role="alert" data-testid="chat-upload-error" className="text-[11px] text-danger">
          {uploadError}
        </p>
      )}

      <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-[10px] pb-[8px] pt-[10px] focus-within:border-[var(--focus)]">
        <textarea
          ref={box}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setCursor(0);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (pickerOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((active + 1) % matches.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((active - 1 + matches.length) % matches.length);
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                const chosen = matches[active];
                if (chosen !== undefined) pick(chosen);
                return;
              }
              if (event.key === 'Escape' && at !== undefined) {
                event.preventDefault();
                place(`${text.slice(0, at.start)}${text.slice(caret)}`, at.start);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          rows={2}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Message this agent"
          data-testid="chat-input"
          className="block w-full resize-none border-none bg-transparent p-0 text-[12.5px] leading-[1.45] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
        />
        <div className="mt-1 flex items-center gap-[6px]">
          <span className="min-w-0 flex-1 truncate text-[10.5px]">
            {showWorkflow && (
              <span data-testid="chat-send-preview" className="text-[var(--muted)]">
                to <span className="font-semibold text-[var(--ink)]">the whole workflow</span> —
                starts a run
              </span>
            )}
            {showDebate && (
              <span data-testid="chat-send-preview" className="text-[var(--muted)]">
                debate: <span className="font-semibold text-[var(--ink)]">{debate.ready}</span>
              </span>
            )}
            {showPreview && preview.canSend && (
              <span data-testid="chat-send-preview" className="text-[var(--muted)]">
                to <span className="font-semibold text-[var(--ink)]">{preview.name}</span>
              </span>
            )}
          </span>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="sr-only"
            aria-label="Attach a file"
            data-testid="chat-file-input"
            onChange={(event) => void onFiles(event.target.files)}
          />
          <button
            type="button"
            title="Attach"
            aria-label="Attach a file"
            disabled={
              disabled || uploading || (mainNodeId === undefined && onWorkflow === undefined)
            }
            onClick={() => fileInput.current?.click()}
            className={cn(
              FOCUS,
              'flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border border-[var(--line)] bg-transparent text-[var(--ink)] disabled:cursor-default',
            )}
          >
            <Icons.Paperclip aria-hidden size={14} />
          </button>
          {replying && onStop !== undefined && (
            <button
              type="button"
              title="Stop"
              aria-label="Stop"
              data-testid="chat-stop"
              onClick={onStop}
              className={cn(
                FOCUS,
                'flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border border-[var(--line)] bg-transparent text-danger',
              )}
            >
              <Icons.Square aria-hidden size={12} className="fill-current" />
            </button>
          )}
          <button
            type="button"
            title="Send"
            aria-label="Send message"
            data-testid="chat-send"
            disabled={!canSend}
            onClick={submit}
            style={{ background: canSend ? '#ef6b3f' : 'var(--sendOff)' }}
            className={cn(
              FOCUS,
              'flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-none text-[#fff] disabled:cursor-default',
            )}
          >
            <Icons.ArrowUp aria-hidden size={15} strokeWidth={2.5} />
          </button>
        </div>
      </div>
      {workflowError !== undefined && text.trim() !== '' && (
        <p role="alert" data-testid="chat-target-error" className="text-[11px] text-danger">
          {workflowError}
        </p>
      )}
      {debateError !== undefined && (
        <p role="alert" data-testid="chat-target-error" className="text-[11px] text-danger">
          {debateError}
        </p>
      )}
      {preview?.error !== undefined && (
        <p role="alert" data-testid="chat-target-error" className="text-[11px] text-danger">
          {preview.error}
        </p>
      )}
    </div>
  );
}
