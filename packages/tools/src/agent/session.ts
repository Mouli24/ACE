/**
 * Agentic nodes, Phase 1 (`docs/team-prompts/agentic-nodes-prompt.md`): what the project tools
 * share across one run. The engine creates one {@link AgentSession} per run and hands it to every
 * tool call of every node in that run, so the nodes working in one project folder (D341: one
 * workspace, one truth) see each other's reads, writes and background commands.
 *
 * Interfaces only: each piece is built in its own module (`ledger.ts`, `locks.ts`,
 * `background.ts`) and assembled by `createAgentSession`.
 */

/** What a node last read or wrote of a file: its absolute path's content hash (sha256, hex). */
export interface ReadLedger {
  /** Records that `nodeId` has seen `absolutePath` with this content hash (a read, or its own write). */
  record(nodeId: string, absolutePath: string, contentHash: string): void;
  /** The hash `nodeId` last saw for `absolutePath`, or undefined if it never read it. */
  seen(nodeId: string, absolutePath: string): string | undefined;
}

/** One write at a time per file, across every node of the run. */
export interface PathLocks {
  withLock<T>(absolutePath: string, fn: () => Promise<T>): Promise<T>;
}

/** A command started with `background: true`, as `command_output` reports it. */
export interface BackgroundSnapshot {
  readonly processId: string;
  readonly command: string;
  readonly nodeId: string;
  /** Output since the previous `command_output` call for this process, already capped. */
  readonly stdout: string;
  readonly stderr: string;
  readonly running: boolean;
  readonly exitCode: number | null;
}

/** The run's background commands. A run's end, a cancel or engine shutdown calls `killAll`. */
export interface BackgroundProcesses {
  start(spec: {
    readonly nodeId: string;
    readonly command: string;
    readonly cwd: string;
  }): { readonly processId: string };
  output(processId: string): BackgroundSnapshot | undefined;
  kill(processId: string): Promise<boolean>;
  killAll(): Promise<void>;
}

export interface AgentSession {
  readonly ledger: ReadLedger;
  readonly locks: PathLocks;
  readonly processes: BackgroundProcesses;
}
