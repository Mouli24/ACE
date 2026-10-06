import { z } from "zod";

import { ErrorKindSchema, type ErrorKind } from "./enums.js";
import { IdSchema } from "./graph.js";
import { ChatVerdictSchema } from "./guardrails.js";

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
  "unauthorized",
  "forbidden_origin",
  "not_found",
  "validation_failed",
  "stale_version",
  "invalid_path",
  "unsupported_format_version",
  "not_implemented",
  "internal",
] as const;

/** Codes round 2 §2.5 adds: deleting a provider a node still references needs `?confirm=true`. */
export const ROUND_2_ERROR_CODES = ["provider_in_use"] as const;

/**
 * Codes round 3 §2.5 adds: a control, retry or approval the run or node run is not in a state for
 * (FR-CTL-006), and deleting a guardrail policy agents still use without `?confirm=true`.
 */
export const ROUND_3_ERROR_CODES = [
  "invalid_run_state",
  "policy_in_use",
] as const;

/**
 * Codes round 4 §2.1 and §2.3 add: an upload over `Settings.maxUploadMb` (413, with the limit in
 * `details`), an upload whose type §2.1's allow-list does not name (415), and a direct-chat input
 * the agent's policy blocked (422, with the verdicts in `details`, FR-CHAT-008).
 */
export const ROUND_4_ERROR_CODES = [
  "upload_too_large",
  "unsupported_type",
  "guardrail_blocked",
] as const;

/**
 * ACE parity P0 (docs/team-prompts/p0-tasks-build-design.md §6): a task action the task's state does
 * not allow; a review of a commit that is no longer the head; an Apply whose destination moved since
 * the user confirmed it, or whose checks failed; a project folder that is not (or already is) a Git
 * repository; work asked of a task with no team or no Input node; a task with no workspace; Git
 * refusing an operation.
 */
export const PARITY_P0_ERROR_CODES = [
  "invalid_task_state",
  "stale_review",
  "destination_changed",
  "checks_failed",
  "not_a_repository",
  "already_repository",
  "no_team",
  "no_workspace",
  "git_failed",
] as const;

export const ERROR_CODES = [
  ...ROUND_1_ERROR_CODES,
  ...ROUND_2_ERROR_CODES,
  ...ROUND_3_ERROR_CODES,
  ...ROUND_4_ERROR_CODES,
  ...PARITY_P0_ERROR_CODES,
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
  upload_too_large: 413,
  unsupported_type: 415,
  guardrail_blocked: 422,
  invalid_task_state: 409,
  stale_review: 409,
  destination_changed: 409,
  checks_failed: 409,
  not_a_repository: 422,
  already_repository: 409,
  no_team: 422,
  no_workspace: 404,
  git_failed: 500,
};

/** `details` shapes §2.3 names explicitly. */
export const StaleVersionDetailsSchema = z.object({
  currentVersion: z.number().int().min(0),
});
export type StaleVersionDetails = z.infer<typeof StaleVersionDetailsSchema>;

export const InvalidPathDetailsSchema = z.object({ path: z.string() });
export type InvalidPathDetails = z.infer<typeof InvalidPathDetailsSchema>;

/** `DELETE /providers/:id` without `confirm=true` while nodes still name it (round 2 §2.5). */
export const ProviderInUseDetailsSchema = z.object({
  nodeIds: z.array(IdSchema),
});
export type ProviderInUseDetails = z.infer<typeof ProviderInUseDetailsSchema>;

/** `DELETE /guardrail-policies/:id` without `confirm=true` while agents use it (round 3 §2.5). */
export const PolicyInUseDetailsSchema = z.object({
  nodeIds: z.array(IdSchema),
});
export type PolicyInUseDetails = z.infer<typeof PolicyInUseDetailsSchema>;

/**
 * `POST /artifacts` over the limit answers 413 with the limit itself, in bytes, so the message the
 * user sees names the real cap rather than a hard-coded 100 MB (round 4 §2.1, FR-MM-001).
 */
export const UploadTooLargeDetailsSchema = z.object({
  maxBytes: z.number().int().positive(),
});
export type UploadTooLargeDetails = z.infer<typeof UploadTooLargeDetailsSchema>;

/**
 * `POST /nodes/:id/chat` whose input the agent's policy blocked answers 422 with the verdicts that
 * say why, so the chat panel can show the guardrail reason (round 4 §2.3, FR-CHAT-008). Chat
 * verdicts carry no `nodeRunId`: a direct chat touches no node run (FR-CHAT-005).
 */
export const GuardrailBlockedDetailsSchema = z.object({
  verdicts: z.array(ChatVerdictSchema),
});
export type GuardrailBlockedDetails = z.infer<
  typeof GuardrailBlockedDetailsSchema
>;

/**
 * Error kinds Arch §28 (repeated in CLAUDE.md §10) says are retried with backoff. Used only as the
 * default for `aceError`; a caller that knows better passes `retryable` explicitly.
 */
const RETRYABLE_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  "provider",
  "network",
]);

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
