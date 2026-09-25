import type { Id, NodeError } from '@ace/contracts';

/**
 * The eight error kinds of Arch §28, as things code can throw (FR-ERR-001).
 *
 * `classifyError` can only guess at an error it did not make; these constructors are how the
 * engine states a kind outright. Every one of them produces a `NodeError`, which is what a node
 * run records and what `node.error` carries — there is no second error shape anywhere.
 *
 * `AceNodeError` deliberately carries its `NodeError` on a field named `nodeError`, because that
 * is the field the node executor already reads off a thrown value (`runs/executor.ts`,
 * `toNodeError`): an adapter or a check that throws one of these is classified correctly by the
 * executor as it stands, with no change to it.
 */
export class AceNodeError extends Error {
  override readonly name = 'AceNodeError';

  constructor(readonly nodeError: NodeError) {
    super(nodeError.message);
  }
}

/** Reads the `NodeError` off anything that carries one, or `undefined`. */
export function nodeErrorOf(error: unknown): NodeError | undefined {
  if (error instanceof AceNodeError) return error.nodeError;
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = (error as { nodeError?: unknown }).nodeError;
  if (typeof candidate !== 'object' || candidate === null) return undefined;

  const { kind, code, message } = candidate as Partial<NodeError>;
  if (typeof kind !== 'string' || typeof code !== 'string' || typeof message !== 'string') {
    return undefined;
  }
  return candidate as NodeError;
}

const thrown = (nodeError: NodeError): AceNodeError => new AceNodeError(nodeError);

/** Stop was pressed. Never retried, and the node ends STOPPED rather than FAILED (FR-ERR-007). */
export function userCancelledError(
  message = 'The call was cancelled before it finished.',
): AceNodeError {
  return thrown({ kind: 'user_cancelled', code: 'stopped', message, retryable: false });
}

/** The model declined to answer — the model worked, the answer is a refusal (Arch §28). */
export function agentRefusalError(text: string): AceNodeError {
  return thrown({
    kind: 'agent',
    code: 'refusal',
    message: `The model declined to answer: ${text}`,
    retryable: false,
  });
}

/**
 * The output does not satisfy the contract. One automatic contract-repair retry follows (§2.1),
 * after which the node run is `CONTRACT_VIOLATION` whatever any policy says (D85).
 */
export function contractViolationError(reason: string): AceNodeError {
  return thrown({ kind: 'agent', code: 'contract_violation', message: reason, retryable: true });
}

/** A 5xx or a 429: worth trying again with backoff (Arch §28). */
export function providerError(
  code: string,
  message: string,
  options: { providerId?: Id; retryable?: boolean } = {},
): AceNodeError {
  return thrown({
    kind: 'provider',
    code,
    message,
    retryable: options.retryable ?? true,
    ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
  });
}

/** A 401 or 403: never retried, and the provider is marked `AUTH_FAILED` (Arch §28, §19.3). */
export function authError(message: string, providerId?: Id): AceNodeError {
  return thrown({
    kind: 'auth',
    code: 'unauthorized',
    message,
    retryable: false,
    ...(providerId === undefined ? {} : { providerId }),
  });
}

/** A timeout, a refused connection or a name that does not resolve: retried with backoff. */
export function networkError(code: string, message: string): AceNodeError {
  return thrown({ kind: 'network', code, message, retryable: true });
}

/** Something the user has to fix before the run can work — BLOCKED, never retried. */
export function invalidConfigError(code: string, message: string): AceNodeError {
  return thrown({ kind: 'invalid_config', code, message, retryable: false });
}

/**
 * A node that cannot run because the graph did not give it what it needs. FR-ERR-006: everything
 * downstream of a failure is BLOCKED with this kind, never FAILED.
 */
export function upstreamFailedError(nodeName: string, nodeId?: Id): AceNodeError {
  return thrown({
    kind: 'workflow',
    code: 'upstream_failed',
    message: `Blocked by "${nodeName}", which did not finish.`,
    retryable: false,
    ...(nodeId === undefined ? {} : { details: { blockedByNodeId: nodeId } }),
  });
}

/** A guardrail blocked the node — `GUARDRAIL_VIOLATION`, distinct from a contract failure (D9). */
export function guardrailError(reason: string, checkType?: string): AceNodeError {
  return thrown({
    kind: 'guardrail',
    code: 'guardrail_blocked',
    message: reason,
    retryable: false,
    ...(checkType === undefined ? {} : { details: { checkType } }),
  });
}

/** An `ask_user` guardrail whose approval was rejected (Arch §19.1, FR-GRD-013). */
export function approvalRejectedError(note?: string): AceNodeError {
  return thrown({
    kind: 'guardrail',
    code: 'approval_rejected',
    message:
      note === undefined || note === ''
        ? 'The approval was rejected.'
        : `The approval was rejected: ${note}`,
    retryable: false,
  });
}
