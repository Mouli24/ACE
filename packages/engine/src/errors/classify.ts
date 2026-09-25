import type { Id, NodeError } from '@ace/contracts';

import { nodeErrorOf } from './kinds.js';

/**
 * One classifier for every failure the engine sees (FR-ERR-001, Arch §28).
 *
 * The eight kinds are not labels applied afterwards — they decide what happens next: whether the
 * node run is `FAILED`, `BLOCKED` or `STOPPED` (`failure.ts`), and whether the engine retries by
 * itself (`retry.ts`). So there has to be exactly one place that decides, and this is it.
 *
 * The order of the rules is the interesting part:
 *
 * 1. An error that already carries a `NodeError` is believed. An adapter or a guardrail knows more
 *    about its own failure than any heuristic here does.
 * 2. An abort is a cancellation, whatever else it looks like. Stop is the only thing that aborts a
 *    node's signal, and a half-read stream can otherwise look like a network fault.
 * 3. An HTTP status, when there is one, decides — 401/403 auth, 429 and 5xx provider, 408 network,
 *    any other 4xx `invalid_config`, because a request the provider calls malformed is not going
 *    to get better on a retry (D96).
 * 4. Then the socket-level codes and the well-known fetch messages, which are `network`.
 * 5. Anything left is `provider` and not retryable: an unknown failure inside a provider call is
 *    still the provider's, but nothing here knows that trying again would help.
 */

export interface ClassifyContext {
  /** Recorded on the error so the UI can say which provider to fix (FR-ERR-002). */
  providerId?: Id;
  /** The HTTP status, when the caller read one off a response rather than an exception. */
  status?: number;
  /** True when the run was stopped by the user: an otherwise unrecognisable failure is then ours. */
  stopped?: boolean;
}

/** `AbortError`, from any of the three shapes a runtime produces it in. */
function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR' || candidate.code === 20
  );
}

function isTimeoutName(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError'
  );
}

/** Wherever a provider SDK happens to hang the status it got back. */
function statusOf(error: unknown, context: ClassifyContext): number | undefined {
  if (context.status !== undefined) return context.status;
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** The syscall and DNS codes that mean "the call never reached anybody" (Arch §28, network row). */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** What `fetch` says when it could not get anywhere, in the runtimes ACE ships on. */
const NETWORK_MESSAGES = [/fetch failed/i, /socket hang up/i, /network(?:\s|$)/i, /getaddrinfo/i];

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, cause } = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof code === 'string') return code;
  if (typeof cause?.code === 'string') return cause.code;
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export function classifyError(error: unknown, context: ClassifyContext = {}): NodeError {
  const withProvider = (nodeError: NodeError): NodeError => ({
    ...nodeError,
    ...(nodeError.providerId === undefined && context.providerId !== undefined
      ? { providerId: context.providerId }
      : {}),
  });

  /* 1. Already classified by whoever knew best. */
  const declared = nodeErrorOf(error);
  if (declared !== undefined) return withProvider(declared);

  /* 2. Stop pressed. */
  if (isAbort(error)) {
    return withProvider({
      kind: 'user_cancelled',
      code: 'aborted',
      message: 'The call was cancelled before it finished.',
      retryable: false,
    });
  }

  const message = messageOf(error);

  /* 3. What the provider answered. */
  const status = statusOf(error, context);
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return withProvider({
        kind: 'auth',
        code: `http_${status}`,
        message: `The provider rejected the credentials (HTTP ${status}): ${message}`,
        retryable: false,
      });
    }
    if (status === 408) {
      return withProvider({
        kind: 'network',
        code: 'http_408',
        message: `The request timed out (HTTP 408): ${message}`,
        retryable: true,
      });
    }
    if (status === 429 || status >= 500) {
      return withProvider({
        kind: 'provider',
        code: `http_${status}`,
        message:
          status === 429
            ? `The provider is rate limiting this key (HTTP 429): ${message}`
            : `The provider failed (HTTP ${status}): ${message}`,
        retryable: true,
      });
    }
    if (status >= 400) {
      return withProvider({
        kind: 'invalid_config',
        code: `http_${status}`,
        message: `The provider refused the request as invalid (HTTP ${status}): ${message}`,
        retryable: false,
      });
    }
  }

  /* 4. Nothing answered at all. */
  const code = codeOf(error);
  if (
    isTimeoutName(error) ||
    (code !== undefined && NETWORK_CODES.has(code)) ||
    NETWORK_MESSAGES.some((pattern) => pattern.test(message))
  ) {
    return withProvider({
      kind: 'network',
      code: code ?? (isTimeoutName(error) ? 'timeout' : 'network_error'),
      message,
      retryable: true,
    });
  }

  /* 5. A stop in flight explains a failure nothing else recognises. */
  if (context.stopped === true) {
    return withProvider({
      kind: 'user_cancelled',
      code: 'stopped',
      message: 'The run was stopped while this node was working.',
      retryable: false,
    });
  }

  return withProvider({
    kind: 'provider',
    code: code ?? 'unknown',
    message,
    retryable: false,
  });
}
