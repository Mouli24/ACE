import type { Artifact } from '@ace/contracts';
import { Button, cn } from '@ace/ui';
import { Paperclip, Upload, X } from 'lucide-react';
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
 * A file picker with drag-and-drop, upload progress and an inline error (M4 §2, FR-MM-001/007).
 * Reusable on purpose: the Input node's attachments area and the chat composer (area E) both mount
 * it and only differ in `label`/`compact`. The upload itself lives in `useArtifactUpload`.
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
        size="sm"
        disabled={disabled || busy}
        aria-label={compact ? 'Attach a file' : undefined}
        data-testid={`${testId}-button`}
        onClick={() => inputRef.current?.click()}
      >
        <Paperclip className="h-3.5 w-3.5" aria-hidden />
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
            'flex flex-col items-center gap-2 rounded-card border border-dashed border-border p-4 text-center',
            dragging && 'border-accent bg-accent/10',
            disabled && 'opacity-60',
          )}
        >
          <Upload className="h-5 w-5 text-fg-muted" aria-hidden />
          <label htmlFor={inputId} className="font-human text-xs text-fg-muted">
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
          aria-valuenow={Math.round((state.progress?.ratio ?? 0) * 100)}
          data-testid={`${testId}-progress`}
          className="flex flex-col gap-1"
        >
          <div className="flex items-center justify-between font-machine text-[10px] text-fg-muted">
            <span className="truncate">{state.fileName}</span>
            <span>{Math.round((state.progress?.ratio ?? 0) * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${Math.round((state.progress?.ratio ?? 0) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {state.status === 'error' && state.error && (
        <p
          role="alert"
          data-testid={`${testId}-error`}
          data-code={state.error.code}
          className="flex items-start gap-2 rounded-md border border-danger/60 bg-danger/10 px-2 py-1.5 font-human text-xs text-danger"
        >
          <span className="flex-1">{uploadErrorMessage(state.error)}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            className="shrink-0 text-danger"
            onClick={reset}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </p>
      )}
    </div>
  );
}
