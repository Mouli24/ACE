import { Button, Textarea } from '@ace/ui';
import { SendHorizonal } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

/**
 * The Timeline composer (round 4 §5 item 4, FR-CHAT-003): "Send to workflow" posts the typed text
 * as a `user` message, which the engine stores and sets as the Input node's pending text before
 * starting a run with it (`POST /workflows/:id/messages { run: true }`). This component is only the
 * input — the parent owns the mutation, so the same box works on the tab and the full page.
 *
 * Enter sends and Shift+Enter makes a newline, so the whole thing is reachable from the keyboard
 * (NFR-USE-03). An empty or whitespace-only message is never sent.
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
      className="flex items-end gap-2 border-t border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Textarea
        aria-label="Message to send to the workflow"
        placeholder={placeholder ?? 'Send a message to the workflow…'}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        disabled={busy}
        className="max-h-40 min-h-[2.5rem] flex-1 resize-y"
      />
      <Button type="submit" disabled={!canSend} data-testid="timeline-send">
        <SendHorizonal className="h-4 w-4" aria-hidden />
        Send to workflow
      </Button>
    </form>
  );
}
