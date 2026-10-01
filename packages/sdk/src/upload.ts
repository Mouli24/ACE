import { ARTIFACT_UPLOAD_FIELD, ArtifactSchema, type Artifact } from '@ace/contracts';

import { AceApiError } from './errors.js';

/**
 * `uploadArtifact` (round 4 §2.1, M4 §2, FR-MM-001/007). `fetch` cannot report upload progress, so
 * a multipart `POST /artifacts` goes through `XMLHttpRequest`, whose `upload.onprogress` a progress
 * bar can read. Everything else matches the REST client: the session token as `Authorization:
 * Bearer`, the response validated against `Artifact`, failures raised as `AceApiError`.
 */

/** One tick of upload progress; `ratio` is `0..1`, `0` while the total is not yet known. */
export interface UploadProgress {
  loaded: number;
  total: number;
  ratio: number;
}

export interface UploadArtifactOptions {
  /** Called as the bytes go up, so the Input node and chat composer can show a bar (FR-MM-007). */
  onProgress?: (progress: UploadProgress) => void;
  /** The filename stored with the artifact; taken from a `File` when omitted. */
  filename?: string;
  /** Aborts the upload; the promise rejects with a `network` `AceApiError`. */
  signal?: AbortSignal;
}

/** What `createAceClient` passes in — the resolved URL, token and XHR constructor plus the file. */
export interface UploadArtifactConfig extends UploadArtifactOptions {
  url: string;
  token: string;
  XHR: typeof XMLHttpRequest;
  file: Blob;
}

const UPLOAD_PATH = '/artifacts';

export function uploadArtifact(config: UploadArtifactConfig): Promise<Artifact> {
  return new Promise<Artifact>((resolve, reject) => {
    if (typeof config.XHR !== 'function') {
      reject(
        AceApiError.network(
          new Error(
            'uploadArtifact needs an XMLHttpRequest; pass one via createAceClient options.',
          ),
        ),
      );
      return;
    }

    const form = new FormData();
    const filename =
      config.filename ??
      (typeof File !== 'undefined' && config.file instanceof File ? config.file.name : undefined);
    if (filename === undefined) form.append(ARTIFACT_UPLOAD_FIELD, config.file);
    else form.append(ARTIFACT_UPLOAD_FIELD, config.file, filename);

    const xhr = new config.XHR();
    xhr.open('POST', config.url);
    xhr.responseType = 'text';
    // The multipart boundary is the browser's to set: naming `content-type` here would break it.
    xhr.setRequestHeader('authorization', `Bearer ${config.token}`);
    xhr.setRequestHeader('accept', 'application/json');

    const { onProgress } = config;
    if (onProgress) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        const total = event.lengthComputable ? event.total : config.file.size;
        onProgress({ loaded: event.loaded, total, ratio: total > 0 ? event.loaded / total : 0 });
      };
    }

    xhr.onerror = () =>
      reject(AceApiError.network(new Error('The upload could not reach the engine.')));
    xhr.onabort = () => reject(AceApiError.network(new Error('The upload was aborted.')));

    xhr.onload = () => {
      let body: unknown;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        body = undefined;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(ArtifactSchema.parse(body));
        } catch (error) {
          reject(
            AceApiError.invalidResponse(
              UPLOAD_PATH,
              error instanceof Error ? error.message : error,
            ),
          );
        }
        return;
      }

      reject(AceApiError.fromUploadResponse(xhr.status, body));
    };

    const { signal } = config;
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(form);
  });
}
