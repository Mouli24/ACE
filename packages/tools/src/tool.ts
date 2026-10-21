import { type Scope } from '@ace/engine';

import { type AgentSession } from './agent/session.js';
import { type ToolLogger } from './logging.js';

/**
 * What a tool implementation is told about the call it is running.
 *
 * It is deliberately thin. A tool gets the workspace it belongs to (BR-18), the run whose sandbox
 * folder it may touch, somewhere to record refusals, and a way to be cancelled — and nothing else.
 * No settings object, no repository, no provider: a tool that could reach those would be a way
 * around the permissions in its own `ToolDefinition`.
 */
export interface ToolContext {
  readonly scope: Scope;
  /** The run this call belongs to. `sandboxDir` is this run's folder and no other's. */
  readonly runId: string;
  /** Absolute path of `<projectFolder>/.ace/sandbox/<runId>/` — the only folder tools may touch. */
  readonly sandboxDir: string;
  /**
   * X1 (FR-TOOL-008): the project folder the run works in — the only folder the project tools
   * (`list_files`, `read_file`, `write_file`, `edit_file`, `git_*`, `run_command`) may touch. Absent
   * when the run has no project folder; those tools then refuse.
   */
  readonly projectDir?: string;
  /** The node making the call. With `session`, it keys the read-before-edit rule (agentic nodes). */
  readonly nodeId?: string;
  /**
   * Agentic nodes: what the run's nodes share — reads, write locks, background commands. Absent
   * (chat turns, older callers), the project tools behave as before this feature.
   */
  readonly session?: AgentSession;
  /**
   * The calling agent's `tools.allowedDomains`. The tool point checks a call's URL against it; the
   * network tools check it again on every redirect they follow, and only an IP or `localhost`
   * entry lets them reach a private address [audit S-2]. Absent, it is the empty list.
   */
  readonly allowedDomains?: readonly string[];
  readonly logger: ToolLogger;
  /** Aborted when the run is stopped, so a tool cancels within the 2 s Stop budget. */
  readonly signal?: AbortSignal;
}

/**
 * One tool's behaviour. `args` arrives unknown on purpose: the engine validates it against the
 * tool's `inputSchema` at the tool guardrail point (§2.2), and each implementation re-parses it
 * with its own Zod schema, because a tool that trusts its caller is a tool that can be reached
 * around the guardrail.
 */
export type ToolImplementation = (args: unknown, context: ToolContext) => Promise<unknown>;
