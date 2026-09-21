import { ApiErrorSchema, type ApiError, type ErrorKind } from '@ace/contracts';

/**
 * Every failure the client surfaces: the FR-SYS-006 envelope from the engine, or one the SDK
 * builds itself (network failure, response that does not match the contract, request body that
 * fails the contract before it is sent). `status` is the HTTP status, `0` when no response came.
 */
export class AceApiError extends Error {
  override readonly name = 'AceApiError';
  readonly status: number;
  readonly kind: ErrorKind;
  readonly code: string;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(status: number, error: ApiError['error']) {
    super(error.message);
    this.status = status;
    this.kind = error.kind;
    this.code = error.code;
    this.details = error.details;
    this.retryable = error.retryable;
  }

  static is(value: unknown): value is AceApiError {
    return value instanceof AceApiError;
  }

  /** The §2.3 envelope, for code that wants to re-emit it. */
  toApiError(): ApiError {
    return {
      error: {
        kind: this.kind,
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
        retryable: this.retryable,
      },
    };
  }

  /** Build from an HTTP response body; falls back to `internal` when the body is not an envelope. */
  static fromResponse(status: number, body: unknown): AceApiError {
    const parsed = ApiErrorSchema.safeParse(body);
    if (parsed.success) return new AceApiError(status, parsed.data.error);
    return new AceApiError(status, {
      kind: status >= 500 ? 'provider' : 'workflow',
      code: 'internal',
      message: `Engine answered ${status} without an error envelope.`,
      retryable: status >= 500,
    });
  }

  static network(cause: unknown): AceApiError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new AceApiError(0, {
      kind: 'network',
      code: 'network_error',
      message: `Could not reach the engine: ${message}`,
      retryable: true,
    });
  }

  static invalidResponse(path: string, issues: unknown): AceApiError {
    return new AceApiError(200, {
      kind: 'workflow',
      code: 'invalid_response',
      message: `Response from ${path} does not match the contract.`,
      details: issues,
      retryable: false,
    });
  }

  static invalidRequest(path: string, issues: unknown): AceApiError {
    return new AceApiError(0, {
      kind: 'invalid_config',
      code: 'validation_failed',
      message: `Request to ${path} does not match the contract.`,
      details: issues,
      retryable: false,
    });
  }
}
