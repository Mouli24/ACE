import type { FailureReason, Usage } from '@ace/contracts';

/**
 * What a debate needs from outside the engine (D347, D354, D355, D359). The engine may import only
 * `@ace/contracts` and its own ports (CLAUDE.md §3.4 rule 3), so the workspace is bound by
 * `apps/server` to `@ace/tools`, and the guardrails and budget to the run's own services.
 */

export interface DebateReadContent {
  path: string;
  content: string;
}

export interface DebateWorkspaceSnapshot {
  /** The workspace's commit, or null when it is not a git repository. */
  sha: string | null;
  dirty: boolean;
  files: DebateReadContent[];
}

export interface DebateScratch {
  dir: string;
  dispose(): Promise<void>;
}

export interface DebateWorkspace {
  /**
   * Read each path once, confined to the project folder (DB8). Throws, naming the path, for one
   * outside the folder or one that cannot be read.
   */
  snapshot(projectFolder: string, paths: readonly string[]): Promise<DebateWorkspaceSnapshot>;
  /** A fresh, empty temp folder for one turn (D359). */
  scratch(): Promise<DebateScratch>;
}

export type DebateGuardStep =
  { kind: 'continue'; text: string } | { kind: 'blocked'; message: string };

/** D355: the hub's input point and the output point of whoever answered. */
export interface DebateGuardrails {
  checkInput(text: string): Promise<DebateGuardStep>;
  checkOutput(nodeId: string, text: string): Promise<DebateGuardStep>;
}

/** D354: what is left to spend. `null` means no limit of that kind is set. */
export interface DebateBudget {
  remaining(): Promise<{ tokens: number | null; usd: number | null }>;
  /** The price of a call from this node, when its model has one; otherwise it adds nothing. */
  costOf?(nodeId: string, tokensIn: number, tokensOut: number): number | undefined;
}

export type DebaterState = 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'STOPPED';

export interface DebateInstruction {
  messageId: string;
  text: string;
}

/** How the run sees a debate: the debaters' node states, usage, and human messages (D351, D353). */
export interface DebateHooks {
  debaterState?(
    nodeId: string,
    state: DebaterState,
    failureReason?: FailureReason,
  ): void | Promise<void>;
  /** Every call's usage against the node that made it; the judge's against the hub. */
  usage?(nodeId: string, usage: Usage): void | Promise<void>;
  /** The messages waiting for this node, taken when its next turn starts. */
  takeInstructions?(nodeId: string): DebateInstruction[] | Promise<DebateInstruction[]>;
  /** Before each round: wait while the run is paused; false when the run was stopped meanwhile. */
  waitDispatchable?(): Promise<boolean>;
}
