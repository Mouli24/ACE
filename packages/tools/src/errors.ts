/**
 * Why a tool call did not return a result.
 *
 * These map onto `ToolCallStatus` from the contract (`ok | error | blocked | rejected | timeout`),
 * but they are not the same list and deliberately so: `rejected` is a person's answer to an
 * approval card and never originates in this package, and `blocked` is a guardrail verdict the
 * engine records. What this package can say is narrower — the arguments were wrong, the call was
 * refused by confinement, it ran out of time, the tool is not configured, or it failed.
 */
export const TOOL_ERROR_KINDS = [
  /** Arguments did not match the tool's `inputSchema`. Engine maps to `error`. */
  'invalid_args',
  /** Path or network confinement refused the call. Engine maps to `blocked`; always logged. */
  'denied',
  /** The tool's own `timeoutMs` elapsed. Engine maps to `timeout`. */
  'timeout',
  /** The tool needs configuration it has not been given (no `searxngUrl`, no interpreter). */
  'unavailable',
  /** The tool ran and failed. Engine maps to `error`. */
  'failed',
] as const;
export type ToolErrorKind = (typeof TOOL_ERROR_KINDS)[number];

/**
 * The only error type this package throws out of a tool implementation. `kind` is what the node
 * executor reads to pick a `ToolCallStatus`; `details` is safe to put in a `resultSummary` because
 * nothing in this package ever puts a secret in it (BR-07).
 */
export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  readonly toolName: string;
  readonly details: Record<string, unknown>;

  constructor(
    kind: ToolErrorKind,
    toolName: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ToolError';
    this.kind = kind;
    this.toolName = toolName;
    this.details = details;
  }
}

/** Whether an unknown thrown value is one of ours, without `instanceof` across bundle copies. */
export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}

/** A registry refusal: a name that is not snake_case, or one that is already taken (§2.2). */
export class ToolRegistrationError extends Error {
  readonly toolName: string;

  constructor(toolName: string, message: string) {
    super(message);
    this.name = 'ToolRegistrationError';
    this.toolName = toolName;
  }
}
