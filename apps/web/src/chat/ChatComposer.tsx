import type { Artifact, Part } from '@ace/contracts';
import { Button } from '@ace/ui';
import { formatBytes } from '@ace/ui';
import { Paperclip, SendHorizontal, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import { api } from '../app/api';
import { partForArtifact } from './parts';

/**
 * The chat composer (FR-CHAT-004/007). Text plus attachments; Enter sends, Shift+Enter breaks a
 * line, so the whole thing is reachable from the keyboard alone (NFR-USE-03).
 *
 * The reusable upload hook / `AttachmentPicker` from M4 area C is not in this worktree yet, so this
 * carries a minimal picker of its own: a file goes up through the SDK's `uploadArtifact` and comes
 * back as a `Part` reference, exactly as area C's will (noted in the report). When area C lands, the
 * upload call here is the one line to swap.
 */
export function ChatComposer({
  onSend,
  disabled,
  placeholder = 'Message this agent…',
  above,
}: {
  onSend: (content: Part[]) => void;
  disabled: boolean;
  /** Defaults to the legacy tab's wording; the Chat column passes `Message @<Name>`. */
  placeholder?: string;
  /** Rendered inside the footer, above the input box (the column's mention chips). */
  above?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Artifact[]>([]);
  const [uploadError, setUploadError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const canSend = !disabled && !uploading && (text.trim().length > 0 || attachments.length > 0);

  const submit = () => {
    if (!canSend) return;
    const content: Part[] = [];
    if (text.trim().length > 0) content.push({ type: 'text', text: text.trim() });
    for (const artifact of attachments) content.push(partForArtifact(artifact));
    onSend(content);
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
      setUploadError(error instanceof Error ? error.message : 'The attachment could not be uploaded.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div
      className="flex flex-col gap-2 border-t border-border px-3.5 pb-3.5 pt-3"
      data-testid="chat-composer"
    >
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
          disabled={disabled || uploading}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip className="h-4 w-4" aria-hidden />
        </Button>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
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
