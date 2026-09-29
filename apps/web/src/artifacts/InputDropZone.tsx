import type { InputConfig } from '@ace/contracts';
import { cn, formatBytes } from '@ace/ui';
import { Paperclip, Upload, X } from 'lucide-react';
import { useCallback, useState, type DragEvent, type ReactNode } from 'react';

import { useArtifactUpload } from './useArtifactUpload';
import { useInputArtifacts } from './useInputArtifacts';
import { uploadErrorMessage } from './upload-error';

export interface InputDropZoneProps {
  nodeId: string;
  workflowId: string;
  config: InputConfig;
  /** The node card this wraps; the card itself is the drop target (FR-MM-007). */
  children: ReactNode;
}

/** True when a drag carries files, so a node-connection drag never lights up the drop overlay. */
function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/**
 * Makes an Input node card a file drop target (M4 §2 item 1, FR-MM-007). A file dropped on the card
 * uploads and attaches to the node's `artifactIds`; a drag shows a "drop to attach" overlay, the
 * upload shows a small progress row, and a 413/415 shows inline (FR-MM-001). The attachment list and
 * picker live in the config panel — the card only needs to accept the drop and show what is going on.
 */
export function InputDropZone({ nodeId, workflowId, config, children }: InputDropZoneProps) {
  const { add, artifactIds } = useInputArtifacts(workflowId, nodeId, config);
  const { state, upload, reset } = useArtifactUpload();
  const [dragging, setDragging] = useState(false);

  const onDrop = useCallback(
    async (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      for (const file of Array.from(event.dataTransfer.files)) {
        const artifact = await upload(file);
        if (artifact) add(artifact.id);
      }
    },
    [upload, add],
  );

  const busy = state.status === 'uploading';

  return (
    <div
      data-testid={`input-dropzone-${nodeId}`}
      data-dragging={dragging ? 'true' : 'false'}
      onDragOver={(event) => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Ignore leaves into a child element; only a leave of the whole zone clears the overlay.
        if (event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => void onDrop(event)}
      className={cn(
        'relative rounded-card',
        dragging && 'outline-dashed outline-2 outline-offset-2 outline-accent',
      )}
    >
      {children}

      {dragging && (
        <div
          data-testid={`input-drop-overlay-${nodeId}`}
          className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded-card bg-accent/15 font-human text-xs text-fg"
        >
          <Upload className="h-4 w-4" aria-hidden />
          Drop to attach
        </div>
      )}

      {(busy || (state.status === 'error' && state.error) || artifactIds.length > 0) && (
        <div className="mt-1 flex flex-col gap-1 px-1">
          {artifactIds.length > 0 && !busy && state.status !== 'error' && (
            <span
              data-testid={`input-attachment-count-${nodeId}`}
              className="flex items-center gap-1 font-machine text-[10px] text-fg-muted"
            >
              <Paperclip className="h-3 w-3" aria-hidden />
              {artifactIds.length} file{artifactIds.length === 1 ? '' : 's'} attached
            </span>
          )}
          {busy && (
            <div
              role="progressbar"
              aria-label={`Uploading ${state.fileName ?? 'file'}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((state.progress?.ratio ?? 0) * 100)}
              data-testid={`input-drop-progress-${nodeId}`}
              className="flex flex-col gap-0.5"
            >
              <span className="flex items-center justify-between font-machine text-[10px] text-fg-muted">
                <span className="truncate">
                  {state.fileName}
                  {state.progress ? ` · ${formatBytes(state.progress.loaded)}` : ''}
                </span>
                <span>{Math.round((state.progress?.ratio ?? 0) * 100)}%</span>
              </span>
              <span className="block h-1 overflow-hidden rounded-full bg-border">
                <span
                  className="block h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${Math.round((state.progress?.ratio ?? 0) * 100)}%` }}
                />
              </span>
            </div>
          )}
          {state.status === 'error' && state.error && (
            <p
              role="alert"
              data-testid={`input-drop-error-${nodeId}`}
              data-code={state.error.code}
              className="flex items-start gap-1 rounded-md border border-danger/60 bg-danger/10 px-1.5 py-1 font-human text-[11px] text-danger"
            >
              <span className="flex-1">{uploadErrorMessage(state.error)}</span>
              <button
                type="button"
                aria-label="Dismiss upload error"
                className="shrink-0 text-danger"
                onClick={reset}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
