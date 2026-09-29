import type { ErrorCode, ErrorKind } from '@ace/contracts';

/**
 * The two refusals the artifact upload path raises (round 4 §2.1, FR-MM-001, FR-MM-003).
 *
 * The service stays HTTP-free (round 4 §4 item 1): it takes bytes and metadata and throws a domain
 * error, and the gateway (Wave 3) turns that into the §2.4 envelope. Each error carries the
 * `ErrorCode` and `details` §2.1 pairs with it, so the gateway maps it in one line —
 * `new HttpError(err.kind, err.code, err.message, err.details)` — without re-deriving anything.
 */

/** An upload larger than `Settings.maxUploadMb` → 413 `upload_too_large` `details:{ maxBytes }` (§2.1, FR-MM-001, TC-MM-001). */
export class UploadTooLargeError extends Error {
  override readonly name = 'UploadTooLargeError';
  readonly kind: ErrorKind = 'invalid_config';
  readonly code: ErrorCode = 'upload_too_large';

  constructor(readonly maxBytes: number) {
    super(`The upload is larger than the ${maxBytes}-byte limit.`);
  }

  /** The `details` §2.1 requires: the limit, in bytes, that was crossed. */
  get details(): { maxBytes: number } {
    return { maxBytes: this.maxBytes };
  }
}

/** A file whose media type and name are both off the §2.1 allow-list → 415 `unsupported_type` (FR-MM-003, TC-MM-002). */
export class UnsupportedTypeError extends Error {
  override readonly name = 'UnsupportedTypeError';
  readonly kind: ErrorKind = 'invalid_config';
  readonly code: ErrorCode = 'unsupported_type';

  constructor(
    readonly mime: string,
    readonly fileName: string,
  ) {
    super(`Files of type "${mime}" are not accepted.`);
  }

  /** The rejected type and name, so the gateway can say which file it refused. */
  get details(): { mime: string; name: string } {
    return { mime: this.mime, name: this.fileName };
  }
}
