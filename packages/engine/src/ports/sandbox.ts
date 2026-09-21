import type { Scope } from './scope.js';

export interface SandboxSpec {
  command: string;
  args: string[];
  /** Absolute path the process is confined to (NFR-SEC-03). */
  workingDirectory: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Isolated execution (Arch §7: a child process, Docker when available — D13).
 * Interface only this round; `packages/tools` implements it in round 4.
 */
export interface Sandbox {
  run(scope: Scope, spec: SandboxSpec): Promise<SandboxResult>;
}
