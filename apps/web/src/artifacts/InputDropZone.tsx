import type { InputConfig } from '@ace/contracts';
import { Icons, cn, formatBytes } from '@ace/ui';
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
 * upload shows a small progress row, and a 413/415 shows inline (FR-MM-001). How many files are
 * attached is the card's own meta line (`INPUT · 2 FILES`, D332); the attachment list and picker
 * live in the node settings — the card only needs to accept the drop and show what is going on.
 */
export function InputDropZone({ nodeId, workflowId, config, children }: InputDropZoneProps) {
  const { add } = useInputArtifacts(workflowId, nodeId, config);
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
  const percent = Math.round((state.progress?.ratio ?? 0) * 100);

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
        'relative rounded-[8px]',
        dragging && 'outline-dashed outline-[1.5px] outline-offset-2 outline-[#ef6b3f]',
      )}
    >
      {children}

      {dragging && (
        <div
          data-testid={`input-drop-overlay-${nodeId}`}
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[8px] bg-[rgba(239,107,63,0.12)] text-[12px] font-semibold text-[var(--ink)]"
        >
          Drop to attach
        </div>
      )}

      {(busy || (state.status === 'error' && state.error)) && (
        <div className="mt-[6px] flex flex-col gap-[4px]">
          {busy && (
            <div
              role="progressbar"
              aria-label={`Uploading ${state.fileName ?? 'file'}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              data-testid={`input-drop-progress-${nodeId}`}
              className="flex flex-col gap-[3px]"
            >
              <span className="flex items-center justify-between gap-[6px] font-machine text-[9px] text-[var(--muted)]">
                <span className="truncate">
                  {state.fileName}
                  {state.progress ? ` · ${formatBytes(state.progress.loaded)}` : ''}
                </span>
                <span>{percent}%</span>
              </span>
              <span className="block h-[4px] overflow-hidden rounded-[2px] bg-[var(--line)]">
                <span
                  className="block h-full rounded-[2px] bg-[#ef6b3f] transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </span>
            </div>
          )}
          {state.status === 'error' && state.error && (
            <p
              role="alert"
              data-testid={`input-drop-error-${nodeId}`}
              data-code={state.error.code}
              className="flex items-start gap-[6px] rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-[8px] py-[6px] text-[10px] leading-[1.45] text-danger"
            >
              <span className="flex-1">{uploadErrorMessage(state.error)}</span>
              <button
                type="button"
                aria-label="Dismiss upload error"
                className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-[10px] leading-none text-[var(--muted)] outline-none hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                onClick={reset}
              >
                <Icons.X aria-hidden size={12} />
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
