import { agentEnv } from './env.js';
import { createBackgroundProcesses, type AgentBackgroundProcesses } from './background.js';
import { createReadLedger } from './ledger.js';
import { createPathLocks, projectWriteLocks } from './locks.js';
import { type AgentCommandObserver, type AgentSession } from './session.js';
import { resolveAgentShell } from './shell.js';

export interface CreateAgentSessionOptions {
  readonly platform?: NodeJS.Platform;
  /** The engine's own environment; only the allowlist (`agentEnv`) reaches a command. */
  readonly env?: NodeJS.ProcessEnv;
  /** PG-5.3: shows the run's commands in Forge's Terminal and Processes list. */
  readonly commands?: AgentCommandObserver;
}

export interface OwnedAgentSession extends AgentSession {
  readonly processes: AgentBackgroundProcesses;
}

/**
 * One run's {@link AgentSession}: the reads, write locks and background commands every node of the
 * run shares in one project folder (D341). The engine's composition root makes one per run and ends
 * it with `processes.killAll()` when the run ends or the engine shuts down.
 *
 * PG-5.2: the write locks are not the run's own but the engine-wide {@link projectWriteLocks}, so
 * two runs, a chat turn and the person's saves in Forge take turns on the same file. (A session
 * made for another platform than this process's — tests — keeps a set of its own.)
 */
export function createAgentSession(options: CreateAgentSessionOptions = {}): OwnedAgentSession {
  const platform = options.platform ?? process.platform;
  const source = options.env ?? process.env;
  const shell = resolveAgentShell({ platform, env: source });
  return {
    ledger: createReadLedger({ platform }),
    locks: platform === process.platform ? projectWriteLocks : createPathLocks({ platform }),
    processes: createBackgroundProcesses({
      platform,
      env: agentEnv(source, platform),
      shell,
      ...(options.commands === undefined ? {} : { observer: options.commands }),
    }),
    ...(options.commands === undefined ? {} : { commands: options.commands }),
  };
}
