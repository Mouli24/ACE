import type { Artifact } from '@ace/contracts';
import { Button, Icons, cn } from '@ace/ui';
import { useCallback, useId, useRef, useState, type DragEvent } from 'react';

import { useArtifactUpload } from './useArtifactUpload';
import { uploadErrorMessage } from './upload-error';

export interface AttachmentPickerProps {
  /** Called once per file that uploaded, with its `Artifact` (dedupe is the caller's job). */
  onUploaded: (artifact: Artifact) => void;
  /** The label above the drop region; the Input node and the chat composer word it differently. */
  label?: string;
  /** Compact rendering (icon button, no drop region) for the chat composer (FR-CHAT-007). */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

/**
 * A file picker with drag-and-drop, upload progress and an inline error (M4 §2, FR-MM-001/007), in
 * the Ace UI theme (D328): a dashed drop region on the canvas colour, the theme's ⌁ attach glyph,
 * an orange progress bar. Reusable on purpose: the Input node's attachments and the knowledge base's
 * documents both mount it and only differ in `label`/`compact`. The upload itself lives in
 * `useArtifactUpload`.
 */
export function AttachmentPicker({
  onUploaded,
  label = 'Attachments',
  compact = false,
  disabled = false,
  className,
  'data-testid': testId = 'attachment-picker',
}: AttachmentPickerProps) {
  const { state, upload, reset } = useArtifactUpload();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [dragging, setDragging] = useState(false);

  const uploadAll = useCallback(
    async (files: FileList | File[]) => {
      // One at a time so the progress bar always tracks the file `state.fileName` names, and a
      // failure (413/415) stops the row it belongs to without discarding files already up.
      for (const file of Array.from(files)) {
        const artifact = await upload(file);
        if (artifact) onUploaded(artifact);
      }
    },
    [upload, onUploaded],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) return;
      if (event.dataTransfer.files.length > 0) void uploadAll(event.dataTransfer.files);
    },
    [disabled, uploadAll],
  );

  const busy = state.status === 'uploading';
  const percent = Math.round((state.progress?.ratio ?? 0) * 100);

  const pickerButton = (
    <>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        className="sr-only"
        disabled={disabled || busy}
        data-testid={`${testId}-input`}
        onChange={(event) => {
          if (event.target.files) void uploadAll(event.target.files);
          event.target.value = '';
        }}
      />
      <Button
        type="button"
        variant={compact ? 'ghost' : 'secondary'}
        size={compact ? 'icon' : 'sm'}
        disabled={disabled || busy}
        aria-label={compact ? 'Attach a file' : undefined}
        data-testid={`${testId}-button`}
        onClick={() => inputRef.current?.click()}
      >
        <Icons.Paperclip aria-hidden size={12} />
        {compact ? '' : 'Choose a file'}
      </Button>
    </>
  );

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid={testId}>
      {!compact && (
        <div
          data-testid={`${testId}-dropzone`}
          data-dragging={dragging ? 'true' : 'false'}
          onDragOver={(event) => {
            event.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center gap-2 rounded-[12px] border border-dashed border-[var(--line)] bg-[var(--canvas)] p-4 text-center',
            dragging && 'border-[#ef6b3f] bg-[rgba(239,107,63,0.06)]',
            disabled && 'opacity-60',
          )}
        >
          <label htmlFor={inputId} className="text-[11.5px] text-[var(--muted)]">
            {label}: drag a file here or
          </label>
          {pickerButton}
        </div>
      )}
      {compact && pickerButton}

      {busy && (
        <div
          role="progressbar"
          aria-label={`Uploading ${state.fileName ?? 'file'}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-testid={`${testId}-progress`}
          className="flex flex-col gap-1"
        >
          <div className="flex items-center justify-between gap-2 font-machine text-[10px] text-[var(--muted)]">
            <span className="truncate">{state.fileName}</span>
            <span>{percent}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-[var(--line)]">
            <div
              className="h-full rounded-full bg-[#ef6b3f] transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      {state.status === 'error' && state.error && (
        <p
          role="alert"
          data-testid={`${testId}-error`}
          data-code={state.error.code}
          className="flex items-start gap-2 text-[11px] leading-[1.45] text-danger"
        >
          <span className="flex-1">{uploadErrorMessage(state.error)}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-[10px] text-danger outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
            onClick={reset}
          >
            <Icons.X aria-hidden size={12} />
          </button>
        </p>
      )}
    </div>
  );
}
