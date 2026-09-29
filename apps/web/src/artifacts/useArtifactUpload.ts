import type { Artifact } from '@ace/contracts';
import { AceApiError, type UploadProgress } from '@ace/sdk';
import { useCallback, useState } from 'react';

import { api } from '../app/api';

/** The state of the current (or last) upload, so a bar and an inline error can read one thing. */
export interface ArtifactUploadState {
  status: 'idle' | 'uploading' | 'error';
  /** The bytes sent so far; `undefined` until an upload starts. */
  progress: UploadProgress | undefined;
  /** The file being (or last) uploaded, for the progress row and the error message. */
  fileName: string | undefined;
  /** Set when the last upload failed; the caller renders it inline (FR-MM-001). */
  error: AceApiError | undefined;
}

export interface UseArtifactUpload {
  state: ArtifactUploadState;
  /**
   * Upload one file. Resolves to the `Artifact` on success, or `undefined` when it failed — the
   * failure is left in `state.error` so the caller shows it inline rather than throwing. Files go
   * up one at a time, so the progress bar is always about the one file `state.fileName` names.
   */
  upload: (file: File) => Promise<Artifact | undefined>;
  /** Clear the error/progress back to idle (e.g. when the person dismisses the message). */
  reset: () => void;
}

const IDLE: ArtifactUploadState = {
  status: 'idle',
  progress: undefined,
  fileName: undefined,
  error: undefined,
};

/**
 * Upload artifacts with progress and typed errors (M4 §2, FR-MM-001/007). Dependency-light on
 * purpose: it holds no artifact list of its own, so the Input node's attachments area and the chat
 * composer (area E) can both drive it and keep their own lists.
 */
export function useArtifactUpload(): UseArtifactUpload {
  const [state, setState] = useState<ArtifactUploadState>(IDLE);

  const reset = useCallback(() => setState(IDLE), []);

  const upload = useCallback(async (file: File): Promise<Artifact | undefined> => {
    setState({
      status: 'uploading',
      progress: { loaded: 0, total: file.size, ratio: 0 },
      fileName: file.name,
      error: undefined,
    });
    try {
      const artifact = await api().uploadArtifact(file, {
        onProgress: (progress) =>
          setState((prev) => (prev.status === 'uploading' ? { ...prev, progress } : prev)),
      });
      setState(IDLE);
      return artifact;
    } catch (caught) {
      const error = AceApiError.is(caught) ? caught : AceApiError.network(caught);
      setState({ status: 'error', progress: undefined, fileName: file.name, error });
      return undefined;
    }
  }, []);

  return { state, upload, reset };
}
