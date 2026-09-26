/**
 * Where the tool layer writes what it refused.
 *
 * `console.*` is banned in engine-side code (CLAUDE.md §2) and `packages/engine` has no logger
 * *port* — it exports a concrete pino logger from `src/logging`. Depending on that type would drag
 * pino into this package for the sake of three method signatures, so the seam is this structural
 * interface instead: a pino `Logger` (or a child of one) satisfies it as-is, and the tests pass a
 * recording sink they can assert against.
 *
 * NFR-SEC-04 and Arch §22.2 (elevation of privilege) are the reason it is not optional. A denied
 * sandbox escape that nobody recorded is indistinguishable from an escape that never happened, so
 * every refusal in this package goes through `warn` with the operation and the path that was asked
 * for.
 */
export interface ToolLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/** One line a {@link RecordingToolLogger} kept. */
export interface RecordedLogLine {
  level: 'info' | 'warn' | 'error';
  payload: Record<string, unknown>;
  message: string;
}

/**
 * A sink that keeps its lines in memory. Exported rather than kept in `__tests__` because the
 * engine's own tests need the same thing when they drive the tool loop (Arch §12.7).
 */
export class RecordingToolLogger implements ToolLogger {
  readonly lines: RecordedLogLine[] = [];

  info(payload: Record<string, unknown>, message: string): void {
    this.lines.push({ level: 'info', payload, message });
  }

  warn(payload: Record<string, unknown>, message: string): void {
    this.lines.push({ level: 'warn', payload, message });
  }

  error(payload: Record<string, unknown>, message: string): void {
    this.lines.push({ level: 'error', payload, message });
  }

  /** Every line whose `message` contains `fragment`, newest last. */
  matching(fragment: string): RecordedLogLine[] {
    return this.lines.filter((line) => line.message.includes(fragment));
  }
}

/** Drops everything. Only for call sites that genuinely have nothing to log to. */
export const SILENT_TOOL_LOGGER: ToolLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** The message every refusal in this package logs, so one grep finds them all. */
export const SANDBOX_DENIED_MESSAGE = 'sandbox escape attempt denied';
