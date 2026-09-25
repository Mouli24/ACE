import { z } from 'zod';

import { ErrorKindSchema, type ErrorKind } from './enums.js';
import { IdSchema } from './graph.js';

/**
 * The single error envelope every `/api/v1` response uses (round 1 §2.3, FR-SYS-006, Arch §20.1).
 */
export const ApiErrorSchema = z.object({
  error: z.object({
    kind: ErrorKindSchema,
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    retryable: z.boolean(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** The error codes round 1 §2.3 uses, in the order it lists them. */
export const ROUND_1_ERROR_CODES = [
  'unauthorized',
  'forbidden_origin',
  'not_found',
  'validation_failed',
  'stale_version',
  'invalid_path',
  'unsupported_format_version',
  'not_implemented',
  'internal',
] as const;

/** Codes round 2 §2.5 adds: deleting a provider a node still references needs `?confirm=true`. */
export const ROUND_2_ERROR_CODES = ['provider_in_use'] as const;

/**
 * Codes round 3 §2.5 adds: a control, retry or approval the run or node run is not in a state for
 * (FR-CTL-006), and deleting a guardrail policy agents still use without `?confirm=true`.
 */
export const ROUND_3_ERROR_CODES = ['invalid_run_state', 'policy_in_use'] as const;

export const ERROR_CODES = [
  ...ROUND_1_ERROR_CODES,
  ...ROUND_2_ERROR_CODES,
  ...ROUND_3_ERROR_CODES,
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** The HTTP status §2.3 pairs with each code. */
export const ERROR_CODE_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  unauthorized: 401,
  forbidden_origin: 403,
  not_found: 404,
  validation_failed: 400,
  stale_version: 409,
  invalid_path: 400,
  unsupported_format_version: 400,
  not_implemented: 501,
  internal: 500,
  provider_in_use: 409,
  invalid_run_state: 409,
  policy_in_use: 409,
};

/** `details` shapes §2.3 names explicitly. */
export const StaleVersionDetailsSchema = z.object({ currentVersion: z.number().int().min(0) });
export type StaleVersionDetails = z.infer<typeof StaleVersionDetailsSchema>;

export const InvalidPathDetailsSchema = z.object({ path: z.string() });
export type InvalidPathDetails = z.infer<typeof InvalidPathDetailsSchema>;

/** `DELETE /providers/:id` without `confirm=true` while nodes still name it (round 2 §2.5). */
export const ProviderInUseDetailsSchema = z.object({ nodeIds: z.array(IdSchema) });
export type ProviderInUseDetails = z.infer<typeof ProviderInUseDetailsSchema>;

/** `DELETE /guardrail-policies/:id` without `confirm=true` while agents use it (round 3 §2.5). */
export const PolicyInUseDetailsSchema = z.object({ nodeIds: z.array(IdSchema) });
export type PolicyInUseDetails = z.infer<typeof PolicyInUseDetailsSchema>;

/**
 * Error kinds Arch §28 (repeated in CLAUDE.md §10) says are retried with backoff. Used only as the
 * default for `aceError`; a caller that knows better passes `retryable` explicitly.
 */
const RETRYABLE_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['provider', 'network']);

export interface AceErrorOptions {
  details?: unknown;
  retryable?: boolean;
}

/** Build the §2.3 envelope. `details` is omitted from the object when not supplied. */
export function aceError(
  kind: ErrorKind,
  code: string,
  message: string,
  options: AceErrorOptions = {},
): ApiError {
  const retryable = options.retryable ?? RETRYABLE_KINDS.has(kind);

  return {
    error: {
      kind,
      code,
      message,
      ...(options.details === undefined ? {} : { details: options.details }),
      retryable,
    },
  };
}
