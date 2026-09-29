import type { AceApiError } from '@ace/sdk';
import { formatBytes } from '@ace/ui';

/**
 * The inline message for a failed upload (FR-MM-001, NFR-USE-03: say what happened and what to do).
 *
 * A 413 `upload_too_large` carries `details.maxBytes`, so the limit is quoted back exactly — the
 * person needs the number to know how much to trim. A 415 `unsupported_type` names the type as the
 * problem. Anything else falls back to the engine's own message, which is already a sentence.
 */
export function uploadErrorMessage(error: AceApiError): string {
  if (error.code === 'upload_too_large') {
    const maxBytes = readMaxBytes(error.details);
    if (maxBytes !== undefined) {
      return `That file is over the ${formatBytes(maxBytes)} upload limit. Choose a smaller file.`;
    }
    return 'That file is over the upload limit. Choose a smaller file.';
  }
  if (error.code === 'unsupported_type') {
    return 'That file type cannot be uploaded. Choose a supported file type.';
  }
  if (error.kind === 'network') {
    return 'The upload could not reach the engine. Check it is running and try again.';
  }
  return error.message;
}

/** `details` is `unknown` on the error; read `maxBytes` only when it is genuinely a number. */
function readMaxBytes(details: unknown): number | undefined {
  if (typeof details === 'object' && details !== null && 'maxBytes' in details) {
    const value = (details as { maxBytes: unknown }).maxBytes;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}
