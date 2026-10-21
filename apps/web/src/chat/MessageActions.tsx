import type { ChatMessage, Part } from '@ace/contracts';
import { cn, Icons } from '@ace/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ConfirmDelete } from './ConfirmDelete';

/**
 * PG-1.6 (D352): what a chat message offers — Copy, Retry (an agent reply or a failed turn), Edit &
 * resend (your own message) and Delete — on hover or keyboard focus, and always on a touch screen,
 * where there is no hover.
 */

const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/** The actions bar: hidden until its row is hovered or focused; always there without hover. */
export const ACTIONS_CLASS =
  'flex items-center gap-[2px] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100';

const ICON_BUTTON = cn(
  FOCUS,
  'flex h-[24px] w-[24px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-40',
);

/** The text a message copies: its words, code as written, JSON pretty-printed; files by name. */
export function copyText(content: readonly Part[]): string {
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
        case 'code':
          return part.text;
        case 'json':
          return JSON.stringify(part.value, null, 2);
        default:
          return 'name' in part && typeof part.name === 'string' ? part.name : '';
      }
    })
    .filter((text) => text !== '')
    .join('\n\n');
}

/** Write to the clipboard; `false` when the browser refused. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** One icon button with its name for screen readers and as its tooltip. */
export function ActionButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={ICON_BUTTON}
    >
      {children}
    </button>
  );
}

/** Copy, with a moment of "Copied" so the press is seen. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ActionButton
      label={copied ? 'Copied' : label}
      onClick={() => {
        void writeClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? <Icons.Check aria-hidden size={14} /> : <Icons.Copy aria-hidden size={14} />}
    </ActionButton>
  );
}

export interface MessageActionHandlers {
  onRetry?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

/** The bar under one message. Each action is offered only where it applies. */
export function MessageActions({
  message,
  onRetry,
  onEdit,
  onDelete,
  busy = false,
}: MessageActionHandlers & { message: ChatMessage; busy?: boolean }) {
  // [audit W-9] Delete asks first: a message has no undo
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={ACTIONS_CLASS} data-testid="chat-message-actions">
      <CopyButton text={copyText(message.content)} />
      {onRetry !== undefined && (
        <ActionButton label="Retry" onClick={onRetry} disabled={busy}>
          <Icons.RotateCcw aria-hidden size={14} />
        </ActionButton>
      )}
      {onEdit !== undefined && (
        <ActionButton label="Edit & resend" onClick={onEdit} disabled={busy}>
          <Icons.Pencil aria-hidden size={14} />
        </ActionButton>
      )}
      {onDelete !== undefined && (
        <ActionButton label="Delete" onClick={() => setConfirming(true)}>
          <Icons.Trash2 aria-hidden size={14} />
        </ActionButton>
      )}
      {onDelete !== undefined && confirming && (
        <ConfirmDelete
          title="Delete this message?"
          description="It is taken out of this conversation. This cannot be undone."
          confirmLabel="Delete message"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onDelete();
          }}
        />
      )}
    </div>
  );
}

/**
 * Turns a retry or an edit replaced (PG-1.6), folded into one "Earlier version" row. Open, they are
 * shown dimmed, as they were; they are never part of a later prompt.
 */
export function EarlierVersion({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="chat-earlier-version" className="flex flex-col gap-[12px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          FOCUS,
          'flex cursor-pointer items-center gap-1 self-start rounded-[6px] border-none bg-transparent p-0 pl-[36px] text-[11px] text-[var(--muted)] hover:text-[var(--ink)]',
        )}
      >
        {open ? (
          <Icons.ChevronDown aria-hidden size={12} />
        ) : (
          <Icons.ChevronRight aria-hidden size={12} />
        )}
        Earlier version
        <span className="text-[10px]">
          ({count} {count === 1 ? 'message' : 'messages'})
        </span>
      </button>
      {open && <div className="flex flex-col gap-[20px] opacity-60">{children}</div>}
    </div>
  );
}

/**
 * Edit & resend in place: the message's text in a box; Enter sends, Shift+Enter breaks a line,
 * Escape cancels. When turns this replaces changed files, it offers to revert those changes too.
 */
export function EditBox({
  initial,
  changedFiles,
  onSend,
  onCancel,
}: {
  initial: string;
  /** How many replaced turns changed files (they each have a checkpoint, D300); 0 hides the offer. */
  changedFiles: number;
  onSend: (text: string, revert: boolean) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [revert, setRevert] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const canSend = text.trim() !== '';
  const send = () => {
    if (canSend) onSend(text.trim(), revert);
  };
  return (
    <div className="mt-1 flex flex-col gap-2" data-testid="chat-edit">
      <textarea
        ref={box}
        aria-label="Edit message"
        value={text}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="block w-full resize-y rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-[10px] py-[8px] text-[12.5px] leading-[1.45] text-[var(--ink)] outline-none focus:border-[#ef6b3f]"
      />
      {changedFiles > 0 && (
        <label className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
          <input
            type="checkbox"
            checked={revert}
            onChange={(event) => setRevert(event.target.checked)}
          />
          Also revert the file changes of the {changedFiles === 1 ? 'turn' : 'turns'} this replaces
        </label>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          className={cn(
            FOCUS,
            'h-[26px] cursor-pointer rounded-[7px] border-none bg-[#ef6b3f] px-[10px] text-[11.5px] font-semibold text-[#fff] disabled:cursor-default disabled:opacity-50',
          )}
        >
          Send edited message
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            FOCUS,
            'h-[26px] cursor-pointer rounded-[7px] border border-[var(--line)] bg-transparent px-[10px] text-[11.5px] text-[var(--ink)]',
          )}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
