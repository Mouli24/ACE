import { type ToolDefinition } from '@ace/contracts';
import { z } from 'zod';

import { type AgentSession } from '../agent/session.js';
import { ToolError } from '../errors.js';
import { type RegisteredTool } from '../registry.js';
import { type ToolContext } from '../tool.js';

/**
 * `command_output` and `kill_command` (agentic nodes, FR-TOOL-008): the two halves of a
 * `run_command { background: true }` — read what it printed since the last look, and end it.
 *
 * Neither is destructive. `command_output` only reads. `kill_command` ends a process this run
 * started (any node of the run may end it: node B may stop the server node A started); it touches
 * no file, and the command it ends was itself approved when `run_command` started it.
 */

const Args = z.strictObject({ processId: z.string().min(1).max(64) });

const definition = (name: string, description: string): ToolDefinition => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: {
      processId: { type: 'string', description: 'The processId run_command returned.' },
    },
    required: ['processId'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  permissions: { network: false, fsPaths: [], destructive: false },
  timeoutMs: 10_000,
  source: 'builtin',
});

export const COMMAND_OUTPUT_DEFINITION = definition(
  'command_output',
  'Returns the new output of a background command since the last call (head and tail, capped), and whether it is still running or its exit code.',
);

export const KILL_COMMAND_DEFINITION = definition(
  'kill_command',
  'Ends a background command and everything it started.',
);

function prepare(
  tool: string,
  args: unknown,
  context: ToolContext,
): { session: AgentSession; processId: string } {
  if (context.session === undefined) {
    throw new ToolError('unavailable', tool, `${tool} works only in an agentic node run.`);
  }
  const parsed = Args.safeParse(args ?? {});
  if (!parsed.success) {
    throw new ToolError('invalid_args', tool, `${tool} needs { processId }.`, {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return { session: context.session, processId: parsed.data.processId };
}

const unknown = (tool: string, processId: string) =>
  new ToolError('invalid_args', tool, `No background command ${processId} in this run.`);

export function createCommandOutputTool(): RegisteredTool {
  return {
    definition: COMMAND_OUTPUT_DEFINITION,
    implementation: async (args, context) => {
      const { session, processId } = prepare('command_output', args, context);
      const snapshot = session.processes.output(processId);
      if (snapshot === undefined) throw unknown('command_output', processId);
      return snapshot;
    },
  };
}

export function createKillCommandTool(): RegisteredTool {
  return {
    definition: KILL_COMMAND_DEFINITION,
    implementation: async (args, context) => {
      const { session, processId } = prepare('kill_command', args, context);
      // No existence check through `output()`: that would consume output the model has not read.
      const killed = await session.processes.kill(processId);
      return killed
        ? { processId, killed, running: false }
        : {
            processId,
            killed,
            note: `${processId} was not running (already exited, or not a command of this run).`,
          };
    },
  };
}
