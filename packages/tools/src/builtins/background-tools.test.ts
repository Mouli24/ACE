import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import { createBackgroundProcesses } from '../agent/background.js';
import { agentEnv } from '../agent/env.js';
import { type AgentSession } from '../agent/session.js';
import { resolveAgentShell } from '../agent/shell.js';
import {
  COMMAND_OUTPUT_DEFINITION,
  KILL_COMMAND_DEFINITION,
  createCommandOutputTool,
  createKillCommandTool,
} from './background-tools.js';
import { createRunCommandTool } from './run-command.js';

const shell = resolveAgentShell({ platform: process.platform, env: process.env });
const node = (script: string) => {
  const exe = process.execPath.replace(/\\/g, '/');
  return shell.kind === 'powershell'
    ? `& '${exe}' -e '${script.replace(/'/g, "''")}'`
    : `'${exe}' -e '${script.replace(/'/g, `'\\''`)}'`;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let project: string;
let agent: AgentSession;
let cleanups: (() => void)[] = [];
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'ace-bgtools-'));
  agent = {
    ledger: { record: () => undefined, seen: () => undefined },
    locks: { withLock: (_path, fn) => fn() },
    processes: createBackgroundProcesses({
      platform: process.platform,
      env: agentEnv(process.env, process.platform),
      shell,
    }),
  };
});
afterEach(async () => {
  await agent.processes.killAll();
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  // fs/promises' rm retries EPERM while Windows releases a killed process's handle on the folder.
  await rm(project, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
});
const ctx = (withSession = true) => {
  const context = makeContext({
    projectDir: project,
    nodeId: 'node-a',
    ...(withSession ? { session: agent } : {}),
  });
  cleanups.push(context.cleanup);
  return context;
};

const runCommand = createRunCommandTool();
const commandOutput = createCommandOutputTool();
const killCommand = createKillCommandTool();

describe('FR-TOOL-008 command_output and kill_command (agentic nodes)', () => {
  it('neither is destructive: they read or end a process the run itself started', () => {
    expect(COMMAND_OUTPUT_DEFINITION.permissions.destructive).toBe(false);
    expect(KILL_COMMAND_DEFINITION.permissions.destructive).toBe(false);
    expect(commandOutput.definition.name).toBe('command_output');
    expect(killCommand.definition.name).toBe('kill_command');
  });

  it('command_output returns only new output; kill_command ends the process', async () => {
    const { processId } = (await runCommand.implementation(
      {
        command: node("let i = 0; setInterval(() => console.log('line ' + i++), 30)"),
        background: true,
      },
      ctx(),
    )) as { processId: string };

    let first = '';
    const end = Date.now() + 5_000;
    while (!first.includes('line 1') && Date.now() < end) {
      const snapshot = (await commandOutput.implementation({ processId }, ctx())) as {
        stdout: string;
        running: boolean;
      };
      expect(snapshot.running).toBe(true);
      first += snapshot.stdout;
      await sleep(30);
    }
    expect(first).toContain('line 0');
    await sleep(120);
    const second = (await commandOutput.implementation({ processId }, ctx())) as { stdout: string };
    expect(second.stdout).not.toContain('line 0\n');
    expect(second.stdout).toMatch(/line \d+/);

    expect(await killCommand.implementation({ processId }, ctx())).toMatchObject({
      processId,
      killed: true,
    });
    expect(await commandOutput.implementation({ processId }, ctx())).toMatchObject({
      running: false,
    });
    expect(await killCommand.implementation({ processId }, ctx())).toMatchObject({ killed: false });
  });

  it('an unknown processId is an error the model can read', async () => {
    await expect(commandOutput.implementation({ processId: 'bg_42' }, ctx())).rejects.toMatchObject(
      {
        kind: 'invalid_args',
        message: expect.stringMatching(/bg_42/),
      },
    );
    expect(await killCommand.implementation({ processId: 'bg_42' }, ctx())).toMatchObject({
      killed: false,
      note: expect.stringMatching(/not running/),
    });
  });

  it('both need an agent session and a processId', async () => {
    await expect(
      commandOutput.implementation({ processId: 'bg_1' }, ctx(false)),
    ).rejects.toMatchObject({
      kind: 'unavailable',
    });
    await expect(
      killCommand.implementation({ processId: 'bg_1' }, ctx(false)),
    ).rejects.toMatchObject({
      kind: 'unavailable',
    });
    await expect(commandOutput.implementation({}, ctx())).rejects.toMatchObject({
      kind: 'invalid_args',
    });
  });
});
