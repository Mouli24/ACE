import {
  ERROR_CODE_HTTP_STATUS,
  aceError,
  type ApiError,
  type ErrorCode,
  type ErrorKind,
  type ValidationIssue,
} from '@ace/contracts';
import { ZodError } from 'zod';

/**
 * Every non-2xx response the engine sends is this shape (FR-SYS-006, §2.3, Arch §20.1).
 *
 * The status comes from the code rather than being passed separately, so a handler cannot answer
 * `not_found` with a 200 or `stale_version` with a 400 — §2.3 pairs them and this is where that
 * pairing is enforced.
 */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly kind: ErrorKind,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly retryable?: boolean,
  ) {
    super(message);
  }

  get status(): number {
    return ERROR_CODE_HTTP_STATUS[this.code];
  }

  toApiError(): ApiError {
    return aceError(this.kind, this.code, this.message, {
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
    });
  }
}

/* The round-1 refusals, each named so a handler reads as the rule it is enforcing. */

export const unauthorized = (): HttpError =>
  new HttpError('auth', 'unauthorized', 'A valid session token is required.');

export const forbiddenOrigin = (origin: string): HttpError =>
  new HttpError('auth', 'forbidden_origin', `Origin "${origin}" is not on the allow-list.`, {
    origin,
  });

export const notFound = (what: string): HttpError =>
  new HttpError('workflow', 'not_found', `${what} was not found.`);

export const validationFailed = (
  message: string,
  details: ValidationIssue[] | ZodError['issues'],
): HttpError => new HttpError('invalid_config', 'validation_failed', message, details);

export const staleVersion = (currentVersion: number): HttpError =>
  new HttpError(
    'workflow',
    'stale_version',
    `The workflow has moved on; it is now at version ${currentVersion}. Refetch and reapply.`,
    { currentVersion },
  );

export const invalidPath = (path: string, reason: string): HttpError =>
  new HttpError('invalid_config', 'invalid_path', `${path} cannot be used: ${reason}`, { path });

export const unsupportedFormatVersion = (found: unknown, expected: number): HttpError =>
  new HttpError(
    'invalid_config',
    'unsupported_format_version',
    `This file is format version ${String(found)}; this engine reads version ${expected}.`,
    { found, expected },
  );

export const notImplemented = (what: string): HttpError =>
  new HttpError('workflow', 'not_implemented', `${what} is not supported yet.`);

/**
 * Turn anything thrown inside a handler into the §2.3 envelope.
 *
 * An unexpected error becomes a 500 whose message is fixed text: the thrown message could carry a
 * path, a query or a key, and BR-07 does not make an exception for stack traces. The real error
 * goes to the log, where it is redacted.
 */
export function toApiError(error: unknown): { status: number; body: ApiError } {
  if (error instanceof HttpError) {
    return { status: error.status, body: error.toApiError() };
  }

  if (error instanceof ZodError) {
    const body = aceError('invalid_config', 'validation_failed', 'The request body is invalid.', {
      details: error.issues,
    });
    return { status: ERROR_CODE_HTTP_STATUS.validation_failed, body };
  }

  return {
    status: ERROR_CODE_HTTP_STATUS.internal,
    body: aceError('provider', 'internal', 'The engine hit an unexpected error.', {
      retryable: false,
    }),
  };
}
