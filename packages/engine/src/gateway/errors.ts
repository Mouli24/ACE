import {
  ERROR_CODE_HTTP_STATUS,
  aceError,
  type ApiError,
  type ErrorCode,
  type ErrorKind,
  type ValidationIssue,
} from '@ace/contracts';
import { ZodError } from 'zod';

import { maskSecrets } from '../security/secret-patterns.js';
import { isWorkspaceFsError, type WorkspaceFsError } from '../ports/workspace.js';
import { isSecretWriteRejectedError } from '../security/secret-write-rejected.js';

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

/**
 * [audit S-7] A `Host` that is not one of the engine's own addresses — what a DNS-rebound page
 * sends. The same refusal as a foreign Origin, because that is what it is.
 */
export const forbiddenHost = (host: string): HttpError =>
  new HttpError('auth', 'forbidden_origin', `Host "${host}" is not this engine's address.`, {
    host,
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

/* Round 2 (§2.5). */

/**
 * FR-PRV-005: deleting a provider that nodes still name needs `?confirm=true`. The refusal
 * carries the node ids, because "this would break three nodes" is only useful if the user can
 * see which three. From round 5 a knowledge base that embeds with the provider is a use too: the
 * contract's details stay `{ nodeIds }` (the nodes attached to those bases), and the message names
 * the bases, so a base nothing references yet is still refused, with no node ids (final-review I5).
 */
export const providerInUse = (
  nodeIds: readonly string[],
  knowledgeBases: readonly string[] = [],
): HttpError => {
  const nodes = `${nodeIds.length} node${nodeIds.length === 1 ? '' : 's'}`;
  const bases = knowledgeBases.map((name) => `"${name}"`).join(', ');
  const plural = knowledgeBases.length === 1 ? 'knowledge base' : 'knowledge bases';
  const embeds = knowledgeBases.length === 1 ? 'embeds' : 'embed';
  const what =
    knowledgeBases.length === 0
      ? `${nodes} still use this provider.`
      : nodeIds.length === 0
        ? `The ${plural} ${bases} ${embeds} with this provider.`
        : `${nodes} still use this provider, and the ${plural} ${bases} ${embeds} with it.`;
  return new HttpError(
    'invalid_config',
    'provider_in_use',
    `${what} Delete it with ?confirm=true to remove it anyway.`,
    { nodeIds: [...nodeIds] },
  );
};

/** `node(…).config.instructions` → `instructions`; `settings.allowedOrigins[1]` → `allowedOrigins`. */
function fieldOf(path: string): string {
  const field = path.slice(path.lastIndexOf('.') + 1).replace(/(?:\[\d+\])+$/, '');
  return field === '' ? path : field;
}

/**
 * BR-07 / NFR-USE-03: storage refused to write a secret. That is a value the user typed in the
 * wrong place, so it is answered 400 with the field it was found in and where the key belongs —
 * never with the value. The path is masked again here, whoever threw: a field name can be a key.
 */
export const secretRejected = (rawPath: string): HttpError => {
  const path = maskSecrets(rawPath);
  return new HttpError(
    'invalid_config',
    'validation_failed',
    `Nothing was saved: "${fieldOf(path)}" looks like it holds an API key or another secret. ` +
      'Remove it and try again. Keys belong in the provider settings, which keep them in the ' +
      'OS keychain, never in a workflow, a policy or the settings.',
    { path },
    false,
  );
};

/**
 * D299: a `ProjectFiles` refusal, with the status §6.1 pairs with its code. A conflict, an
 * existing name and a missing file are about the project's state (`workflow`); the rest are about
 * the path the person asked for (`invalid_config`).
 */
export function workspaceRefusal(error: WorkspaceFsError): HttpError {
  const state = error.code === 'file_changed' || error.code === 'exists' || error.code === 'not_found';
  return new HttpError(state ? 'workflow' : 'invalid_config', error.code, error.message, error.details, false);
}

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

  if (isWorkspaceFsError(error)) {
    const refused = workspaceRefusal(error);
    return { status: refused.status, body: refused.toApiError() };
  }

  if (isSecretWriteRejectedError(error)) {
    const refused = secretRejected(error.path);
    return { status: refused.status, body: refused.toApiError() };
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
