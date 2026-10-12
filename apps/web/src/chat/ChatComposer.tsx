import type { Artifact, Part } from '@ace/contracts';
import { cn, formatBytes, MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS } from '@ace/ui';
import { useRef, useState } from 'react';

import { api } from '../app/api';
import { Avatar } from '../theme/primitives';
import { insertMention, mentionMatches, parseMention, type Mentionable } from './mentions';
import { partForArtifact } from './parts';

/** A node the composer can `@mention`, with what the picker shows beside its name. */
export interface MentionTarget extends Mentionable {
  /** The node's handle, without the `@`. */
  handle: string;
  /** The agent avatar's initial and colour (`agentsOf`), so the picker matches the tabs. */
  letter: string;
  color: string;
}

/** The theme's composer placeholder (D335). */
export const TEAM_PLACEHOLDER = 'Message the team… @ to tag an agent, / for commands';

const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/**
 * The chat composer (FR-CHAT-004/007), as the theme's Team chat composer (D335): a surface card
 * with a two-row textarea, ⌁ Attach and ↑ Send. Enter sends, Shift+Enter breaks a line, so the
 * whole thing is reachable from the keyboard alone (NFR-USE-03).
 *
 * `@` opens a picker over the nodes that can chat; choosing one completes the mention and points
 * the chat at that node. A message that opens with `@<node>` is sent to that node — the mention is
 * stripped, it is an address, not part of the message — and anything else goes to the node the
 * chat is already talking to. With no such node and no mention there is nobody to send to, so the
 * send stays disabled.
 */
export function ChatComposer({
  onSend,
  disabled,
  placeholder = TEAM_PLACEHOLDER,
  mentionables = [],
  onMention,
  hasTarget = true,
}: {
  /** `mentioned` is the node a leading `@mention` named, when there was one. */
  onSend: (content: Part[], mentioned: string | undefined) => void;
  disabled: boolean;
  placeholder?: string;
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
          <span className={MENU_LABEL_CLASS}>Nodes</span>
          {matches.map((node, index) => (
            <button
              key={node.id}
              type="button"
              role="option"
              aria-selected={index === active}
              data-testid={`chat-mention-option-${node.id}`}
              data-highlighted={index === active ? '' : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(node)}
              className={cn(MENU_ITEM_CLASS, 'text-left hover:bg-[rgba(239,107,63,0.12)]')}
            >
              <Avatar
                letter={node.letter}
                color={node.color}
                size={16}
                fontSize={8}
                className="font-semibold"
              />
              <span className="min-w-0 truncate">{node.name}</span>
              <span className="ml-auto font-machine text-[9px] text-[var(--muted)]">
                @{node.handle}
              </span>
            </button>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-[6px]" data-testid="chat-attachments">
          {attachments.map((artifact) => (
            <li
              key={artifact.id}
              className="flex h-[24px] max-w-full items-center gap-[6px] rounded-full border border-[var(--line)] bg-[var(--chip)] pl-[9px] pr-[6px] text-[11px] text-[var(--ink)]"
            >
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
                className={cn(
                  FOCUS,
                  'flex h-[16px] w-[16px] shrink-0 cursor-pointer items-center justify-center rounded-full text-[9px] text-[var(--muted)] hover:text-[#c94c27]',
                )}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {uploadError !== undefined && (
        <p role="alert" data-testid="chat-upload-error" className="text-[11px] text-[#c94c27]">
          {uploadError}
        </p>
      )}

      <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-[10px] pb-[8px] pt-[10px] focus-within:border-[#ef6b3f]">
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
          rows={2}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Message this agent"
          data-testid="chat-input"
          className="block w-full resize-none border-none bg-transparent p-0 text-[12.5px] leading-[1.45] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
        />
        <div className="mt-1 flex items-center gap-[6px]">
          <span className="flex-1" />
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
            disabled={disabled || uploading || !hasTarget}
            onClick={() => fileInput.current?.click()}
            className={cn(
              FOCUS,
              'h-[30px] w-[30px] shrink-0 cursor-pointer rounded-[8px] border border-[var(--line)] bg-transparent text-[13px] text-[var(--ink)] disabled:cursor-default',
            )}
          >
            ⌁
          </button>
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
              'h-[30px] w-[30px] shrink-0 cursor-pointer rounded-[8px] border-none text-[14px] font-bold text-[#fff] disabled:cursor-default',
            )}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
