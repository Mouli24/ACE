import { useState, type KeyboardEvent } from 'react';

/**
 * The Timeline composer (round 4 §5 item 4, FR-CHAT-003): "Send to workflow" posts the typed text
 * as a `user` message, which the engine stores and sets as the Input node's pending text before
 * starting a run with it (`POST /workflows/:id/messages { run: true }`). This component is only the
 * input — the parent owns the mutation, so the same box works on the tab and the full page.
 *
 * Enter sends and Shift+Enter makes a newline, so the whole thing is reachable from the keyboard
 * (NFR-USE-03). An empty or whitespace-only message is never sent.
 *
 * In the theme (D328) it is Domain's composer: a surface card, radius 14, a borderless 14px / 1.5
 * box, and the 36px ↑ send button — accent with text, `--sendOff` without.
 */

export interface TimelineComposerProps {
  onSend: (text: string) => void;
  /** True while the post is in flight; the button and the box disable so nothing double-sends. */
  busy?: boolean;
  placeholder?: string;
}

export function TimelineComposer({ onSend, busy = false, placeholder }: TimelineComposerProps) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !busy;

  const send = () => {
    if (!canSend) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <form
      data-testid="timeline-composer"
      className="border-t border-[var(--line)] p-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="flex items-end gap-2 rounded-[14px] border border-[var(--line)] bg-[var(--surface)] py-[10px] pl-4 pr-[10px] focus-within:border-[#ef6b3f]">
        <textarea
          aria-label="Message to send to the workflow"
          placeholder={placeholder ?? 'Send a message to the workflow…'}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={busy}
          className="max-h-40 min-h-[36px] flex-1 resize-none border-none bg-transparent py-[7px] font-human text-[14px] leading-[1.5] text-[var(--ink)] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canSend}
          data-testid="timeline-send"
          aria-label="Send to workflow"
          title="Send to workflow"
          className="h-9 w-9 shrink-0 cursor-pointer rounded-[9px] border-none text-[16px] font-bold text-[#fff] outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-default"
          style={{ background: canSend ? '#ef6b3f' : 'var(--sendOff)' }}
        >
          <span aria-hidden>↑</span>
        </button>
      </div>
    </form>
  );
}
