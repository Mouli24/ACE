import type { Artifact, Part } from '@ace/contracts';
import { Button } from '@ace/ui';
import { formatBytes } from '@ace/ui';
import { Paperclip, SendHorizontal, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import { api } from '../app/api';
import { insertMention, mentionMatches, parseMention, type Mentionable } from './mentions';
import { partForArtifact } from './parts';

/** A node the composer can `@mention`, with what the picker shows beside its name. */
export interface MentionTarget extends Mentionable {
  kind: string;
  /** The provider dot's colour; undefined draws the mock colour. */
  providerType?: string | undefined;
}

/**
 * The chat composer (FR-CHAT-004/007). Text plus attachments; Enter sends, Shift+Enter breaks a
 * line, so the whole thing is reachable from the keyboard alone (NFR-USE-03).
 *
 * `@` opens a picker over the nodes that can chat; choosing one completes the mention and points
 * the chat at that node. A message that opens with `@<node>` is sent to that node — the mention is
 * stripped, it is an address, not part of the message — and anything else goes to the node the
 * chat is already talking to. With no such node and no mention there is nobody to send to, so the
 * send stays disabled and the placeholder says how to pick one.
 */
export function ChatComposer({
  onSend,
  disabled,
  placeholder = 'Message this agent…',
  above,
  mentionables = [],
  onMention,
  hasTarget = true,
}: {
  /** `mentioned` is the node a leading `@mention` named, when there was one. */
  onSend: (content: Part[], mentioned: string | undefined) => void;
  disabled: boolean;
  placeholder?: string;
  /** Rendered inside the footer, above the input box (the column's mention chips). */
  above?: ReactNode;
  mentionables?: readonly MentionTarget[];
  /** A node was picked from the `@` picker. */
  onMention?: (nodeId: string) => void;
  /** Whether a message without a mention has somewhere to go. */
  hasTarget?: boolean;
}) {
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const [attachments, setAttachments] = useState<Artifact[]>([]);
  const [uploadError, setUploadError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const matches = mentionMatches(text, mentionables);
  const pickerOpen = matches.length > 0;
  const active = Math.min(cursor, Math.max(matches.length - 1, 0));

  const addressed = parseMention(text, mentionables);
  const hasBody = addressed.body.length > 0 || attachments.length > 0;
  const canSend =
    !disabled && !uploading && (addressed.node !== undefined || (hasTarget && hasBody));

  const pick = (node: MentionTarget) => {
    setText(insertMention(text, node.name));
    setCursor(0);
    onMention?.(node.id);
  };

  const submit = () => {
    if (!canSend) return;
    const content: Part[] = [];
    if (addressed.body.length > 0) content.push({ type: 'text', text: addressed.body });
    for (const artifact of attachments) content.push(partForArtifact(artifact));
    onSend(content, addressed.node?.id);
    setText('');
    setAttachments([]);
    setUploadError(undefined);
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

  return (
    <div
      className="relative flex flex-col gap-2 border-t border-border px-3.5 pb-3.5 pt-3"
      data-testid="chat-composer"
    >
      {pickerOpen && (
        <div
          role="listbox"
          aria-label="Nodes"
          data-testid="chat-mention-picker"
          className="absolute bottom-[calc(100%-4px)] left-3.5 right-3.5 z-10 flex flex-col rounded-xl border border-border-strong bg-panel p-1 shadow-lg"
        >
          <span className="px-2.5 pb-1 pt-1.5 font-machine text-[9px] uppercase tracking-[0.2em] text-fg-faint">
            Nodes
          </span>
          {matches.map((node, index) => (
            <button
              key={node.id}
              type="button"
              role="option"
              aria-selected={index === active}
              data-testid={`chat-mention-option-${node.id}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(node)}
              className={`flex h-[34px] items-center gap-[9px] rounded-lg px-2.5 text-left hover:bg-card ${
                index === active ? 'bg-card' : ''
              }`}
            >
              <span
                aria-hidden
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={{ background: `var(--color-provider-${node.providerType ?? 'mock'})` }}
              />
              <span className="text-[14.5px]">{node.name}</span>
              <span className="ml-auto font-machine text-[10px] text-fg-faint">{node.kind}</span>
            </button>
          ))}
        </div>
      )}
      {above}
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1" data-testid="chat-attachments">
          {attachments.map((artifact) => (
            <li
              key={artifact.id}
              className="flex items-center gap-1 rounded-chip border border-border bg-card px-2 py-0.5 text-[11px]"
            >
              <span className="max-w-[10rem] truncate font-machine" title={artifact.name}>
                {artifact.name}
              </span>
              <span className="text-fg-muted">{formatBytes(artifact.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${artifact.name}`}
                onClick={() =>
                  setAttachments((current) => current.filter((each) => each.id !== artifact.id))
                }
                className="text-fg-muted hover:text-danger"
              >
                <X className="h-3 w-3" aria-hidden />
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

      <div className="flex items-end gap-2 rounded-[14px] border border-border bg-card py-1.5 pl-3 pr-1.5 focus-within:ring-2 focus-within:ring-accent">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="sr-only"
          aria-label="Attach a file"
          data-testid="chat-file-input"
          onChange={(event) => void onFiles(event.target.files)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Attach a file"
          disabled={disabled || uploading || !hasTarget}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip className="h-4 w-4" aria-hidden />
        </Button>
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCursor(0);
          }}
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
              if (event.key === 'Escape') {
                event.preventDefault();
                setText(text.replace(/@[^\s@]*$/, ''));
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Message this agent"
          data-testid="chat-input"
          className="max-h-32 min-h-9 flex-1 resize-none border-0 bg-transparent px-0 py-1 font-human text-[14.5px] leading-[1.45] text-fg placeholder:text-fg-faint focus-visible:outline-none"
        />
        <button
          type="button"
          aria-label="Send message"
          data-testid="chat-send"
          disabled={!canSend}
          onClick={submit}
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-accent text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg disabled:opacity-40"
        >
          <SendHorizontal className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
