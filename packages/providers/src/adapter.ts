import type { ErrorKind, Id, NodeError, ProviderState } from '@ace/contracts';

/**
 * The provider adapter contract (Arch §14.2) and the one place SDK and HTTP failures become ACE
 * error kinds (Arch §28).
 *
 * The interface itself is declared in `@ace/engine`'s ports, because the engine may not import
 * this package (CLAUDE.md §3.4 rule 3); it is re-exported here so `packages/providers` is still
 * where an adapter author looks, with exactly one declaration behind it.
 *
 * Every adapter maps its own errors *inside* the adapter, so nothing above this layer has to know
 * what an Anthropic 429 looks like versus an Ollama connection refusal. The engine sees a
 * `NodeError` with a kind it already has a rule for.
 */

export {
  FINISH_REASONS,
  type AgentTurn,
  type FinishReason,
  type GenerateRequest,
  type ModelInfo,
  type ProducedPart,
  type ProviderAdapter,
  type ProviderAdapterFactory,
  type ProviderDetection,
  type ProviderStatus,
  type StreamChunk,
  type ToolResult,
} from '@ace/engine';

/* -------------------------------------------------------------------------- */
/* Error mapping (Arch §28)                                                    */
/* -------------------------------------------------------------------------- */

/** Thrown by an adapter that has already decided what kind of failure this is. */
export class ProviderCallError extends Error {
  override readonly name = 'ProviderCallError';

  constructor(readonly nodeError: NodeError) {
    super(nodeError.message);
  }
}

/** Transport-level failures, which are worth retrying because the request never landed. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Names Node, undici and the DOM use for "the caller gave up". */
const ABORT_NAMES: ReadonlySet<string> = new Set(['AbortError', 'TimeoutError']);

export interface ErrorContext {
  providerId?: Id;
  /**
   * The signal the call was given. When the call ends in an abort, its reason says why: a
   * `TimeoutError` — what `AbortSignal.timeout()` sets, alone or inside `AbortSignal.any` — is the
   * caller giving up on a provider that went quiet, and anything else is a stop (D97).
   */
  signal?: AbortSignal;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && ABORT_NAMES.has(error.name);
}

/** A `TimeoutError`, whether thrown or left as an abort reason, and whatever built it. */
function isTimeoutError(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'TimeoutError'
  );
}

/**
 * A call that ended because it was aborted, as the `NodeError` its reason deserves (Arch §28).
 *
 * A timeout is a `network` failure and retryable (D97, D109): the provider went quiet, and the next
 * attempt may well answer. Anything else is the user's stop — `user_cancelled`, never retried. The
 * reason is read off `error` itself or, because an SDK may surface a bare `AbortError` while the
 * real reason sits on the signal, off `context.signal`.
 */
export function abortedCallError(error: unknown, context: ErrorContext = {}): NodeError {
  const nodeError: NodeError =
    isTimeoutError(error) || isTimeoutError(context.signal?.reason)
      ? {
          kind: 'network',
          code: 'timeout',
          message: 'The provider did not answer before the call timed out.',
          retryable: true,
        }
      : {
          kind: 'user_cancelled',
          code: 'aborted',
          message: 'The call was cancelled before it finished.',
          retryable: false,
        };

  return context.providerId === undefined
    ? nodeError
    : { ...nodeError, providerId: context.providerId };
}

function kindForStatus(status: number): { kind: ErrorKind; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (status === 429) return { kind: 'provider', retryable: true };
  if (status >= 500) return { kind: 'provider', retryable: true };
  // Everything else in the 4xx range is the request's own fault — a model that does not exist, a
  // body the provider will not accept. Retrying sends exactly the same request, so pre-flight and
  // the config are what has to change (Arch §28 invalid_config).
  return { kind: 'invalid_config', retryable: false };
}

/** Build the NodeError an HTTP status deserves (Arch §28). */
export function statusToNodeError(
  status: number,
  message: string,
  context: ErrorContext = {},
): NodeError {
  const { kind, retryable } = kindForStatus(status);

  return {
    kind,
    code: `http_${status}`,
    message: `Provider responded ${status}: ${message}`,
    retryable,
    ...(context.providerId === undefined ? {} : { providerId: context.providerId }),
  };
}

function errorCode(error: object): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Node's TLS verification codes: a certificate the connection refused to trust. */
const CERTIFICATE_CODE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/;

/** How far down a `cause` chain the socket's own error is looked for. */
const MAX_CAUSE_DEPTH = 4;

/**
 * The transport failure behind an error, wherever it sits (audit P-8). undici's `fetch` throws a
 * bare `TypeError('fetch failed')` and keeps the socket's error — `ECONNREFUSED`, a DNS miss, a
 * rejected certificate — on `cause`, and the AI SDK wraps that once more in an `APICallError`.
 * Reading only the outer error made every one of them "fetch failed".
 */
function transportFailure(error: object): { code: string; source: object } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const code = errorCode(current);
    if (code !== undefined && (NETWORK_CODES.has(code) || CERTIFICATE_CODE.test(code))) {
      return { code, source: current };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** `host:port` off a socket error — or, for a dual-stack `AggregateError`, off its first attempt. */
function addressOf(source: object): string | undefined {
  const first = (source as { errors?: unknown }).errors;
  const target =
    Array.isArray(first) && typeof first[0] === 'object' && first[0] !== null
      ? (first[0] as object)
      : source;
  const { address, port, hostname } = target as {
    address?: unknown;
    port?: unknown;
    hostname?: unknown;
  };
  const host =
    typeof address === 'string' ? address : typeof hostname === 'string' ? hostname : undefined;
  if (host === undefined) return undefined;
  return typeof port === 'number' ? `${host}:${port}` : host;
}

/** What a transport failure means, in words a person can act on (audit P-8). */
function describeTransport(code: string, source: object): string {
  const at = addressOf(source);
  const where = at === undefined ? '' : ` at ${at}`;
  if (code === 'ECONNREFUSED') return `connection refused${where}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return at === undefined
      ? 'the host name could not be resolved (DNS)'
      : `the host name ${at} could not be resolved (DNS)`;
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `the connection timed out${where}`;
  }
  if (CERTIFICATE_CODE.test(code)) {
    return `its TLS certificate was not trusted (${describe(source) || code})`;
  }
  const said = describe(source);
  return said === '' ? `${code}${where}` : said;
}

function errorStatus(error: object): number | undefined {
  for (const key of ['status', 'statusCode'] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * Turn anything an SDK or `fetch` threw into a `NodeError` (Arch §28).
 *
 * An abort is a timeout or a stop, as `abortedCallError` reads it: pass the call's `signal`, so a
 * bare `AbortError` whose real reason is a `TimeoutError` is still a timeout (D97, D109).
 *
 * An unrecognised failure becomes a `provider` error that is **not** retried: a bug in an adapter
 * would otherwise be re-sent with backoff until the attempt budget runs out, which turns one
 * wrong call into several and hides the cause.
 */
export function mapProviderError(error: unknown, context: ErrorContext = {}): NodeError {
  if (error instanceof ProviderCallError) return error.nodeError;

  const withProvider = (nodeError: NodeError): NodeError =>
    context.providerId === undefined ? nodeError : { ...nodeError, providerId: context.providerId };

  if (isAbortError(error)) return abortedCallError(error, context);

  if (typeof error === 'object' && error !== null) {
    const status = errorStatus(error);
    if (status !== undefined) {
      return statusToNodeError(status, describe(error), context);
    }

    const transport = transportFailure(error);
    if (transport !== undefined) {
      return withProvider({
        kind: 'network',
        code: transport.code,
        message: `Could not reach the provider: ${describeTransport(transport.code, transport.source)}`,
        // A certificate the machine does not trust will not be trusted on the next attempt either.
        retryable: !CERTIFICATE_CODE.test(transport.code),
      });
    }

    // `fetch` reports every transport failure as a TypeError with no code of its own; whatever
    // reason it kept (`bad port`, …) sits on `cause`.
    if (error instanceof TypeError) {
      const cause = (error as { cause?: unknown }).cause;
      const reason = cause instanceof Error && cause.message !== '' ? ` (${cause.message})` : '';
      return withProvider({
        kind: 'network',
        code: 'fetch_failed',
        message: `Could not reach the provider: ${describe(error)}${reason}`,
        retryable: true,
      });
    }
  }

  return withProvider({
    kind: 'provider',
    code: 'unknown',
    message: `The provider call failed: ${describe(error)}`,
    retryable: false,
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/**
 * What a failed call says about the provider itself (FR-PRV-003, Arch §19.3).
 *
 * Only failures that are genuinely about the provider move its state. A 500 says the request
 * failed, not that the provider is unusable, so the state stays `UNKNOWN` until a `check()` says
 * otherwise — marking it down on one bad response would make a transient blip look like an outage.
 */
export function providerStateForError(error: NodeError): ProviderState {
  if (error.kind === 'auth') return 'AUTH_FAILED';
  if (error.kind === 'network') return 'UNREACHABLE';
  if (error.code === 'http_429') return 'RATE_LIMITED';
  return 'UNKNOWN';
}
