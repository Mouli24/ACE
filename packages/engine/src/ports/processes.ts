import type { ProcessStream, ProjectScripts } from '@ace/contracts';

/**
 * What the terminal asks to run (D301, design §6.3). The engine names the folder and the line; the
 * adapter — `createProcessRunner` in `@ace/tools` — confines `cwd` to `root` (FR-GIT-008), runs the
 * line through the platform shell with a scrubbed environment, and kills the whole tree on stop.
 */
export interface ProcessSpec {
  /** The project's folder, absolute. */
  root: string;
  /**
   * Project-relative; `''` is the root. The adapter refuses one that escapes the project, names
   * `.git`, or is not an existing folder, with a `WorkspaceFsError` thrown from `start`.
   */
  cwd: string;
  /** The line the person typed, or `<pm> run <script>`, run through the platform shell. */
  command: string;
  /** Extra variables for this one process, scrubbed like the inherited ones. */
  env?: Record<string, string>;
}

/** Called in order: any number of `onOutput`, then exactly one of `onExit` or `onError`. */
export interface ProcessHandlers {
  /** Decoded text. A multibyte character is never split across two calls. */
  onOutput(stream: ProcessStream, chunk: string): void;
  /** It ran and ended. `code` is null when a signal, or a stop, ended it. */
  onExit(code: number | null, signal: string | null): void;
  /** It never started: the shell could not be spawned. */
  onError(error: Error): void;
}

export interface RunningProcess {
  /** The shell's pid; `undefined` when it never started. */
  readonly pid: number | undefined;
  /** Writes to stdin. Ignored once the process has ended. */
  write(data: string): void;
  /**
   * Kills the whole process tree. `onExit(null, 'SIGKILL')` follows within 1.5 s on every
   * platform, even if the kill does not take.
   */
  stop(): void;
}

/** The terminal's process runner (D301). `apps/server` wires `@ace/tools`' adapter in. */
export interface ProcessRunner {
  /** Throws a `WorkspaceFsError` for a refused `cwd`, before anything is spawned. */
  start(spec: ProcessSpec, handlers: ProcessHandlers): RunningProcess;
  /**
   * The root package.json's scripts and the package manager they run with (D301 decision 9). It
   * never throws: no package.json, an unparsable one, or one linked from outside is an empty list.
   */
  scripts(root: string): Promise<ProjectScripts>;
}
