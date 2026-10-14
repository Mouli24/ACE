import { agentEnv } from './env.js';
import { createBackgroundProcesses, type AgentBackgroundProcesses } from './background.js';
import { createReadLedger } from './ledger.js';
import { createPathLocks } from './locks.js';
import { type AgentSession } from './session.js';
import { resolveAgentShell } from './shell.js';

export interface CreateAgentSessionOptions {
  readonly platform?: NodeJS.Platform;
  /** The engine's own environment; only the allowlist (`agentEnv`) reaches a command. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface OwnedAgentSession extends AgentSession {
  readonly processes: AgentBackgroundProcesses;
}

/**
 * One run's {@link AgentSession}: the reads, write locks and background commands every node of the
 * run shares in one project folder (D341). The engine's composition root makes one per run and ends
 * it with `processes.killAll()` when the run ends or the engine shuts down.
 */
export function createAgentSession(options: CreateAgentSessionOptions = {}): OwnedAgentSession {
  const platform = options.platform ?? process.platform;
  const source = options.env ?? process.env;
  const shell = resolveAgentShell({ platform, env: source });
  return {
    ledger: createReadLedger({ platform }),
    locks: createPathLocks({ platform }),
    processes: createBackgroundProcesses({ platform, env: agentEnv(source, platform), shell }),
  };
}
