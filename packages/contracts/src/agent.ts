import { z } from 'zod';

import { IdSchema, agentWorkspaceOf, type AgentConfig, type WorkspaceAccess } from './graph.js';

/**
 * Agentic nodes Phase 2 (D342): which tools a node's workspace access level gives it, and the
 * summary of what a node did in the workspace.
 */

/** Every tool the workspace access level owns; `tools.enabled` entries with these names are ignored. */
export const WORKSPACE_TOOL_NAMES = [
  'list_files',
  'read_file',
  'search',
  'git_status',
  'git_diff',
  'write_file',
  'edit_file',
  'run_command',
  'command_output',
  'kill_command',
] as const;

const READ_TOOLS = ['list_files', 'read_file', 'search', 'git_status', 'git_diff'] as const;
const EDIT_TOOLS = [...READ_TOOLS, 'write_file', 'edit_file'] as const;

/** The tools each access level grants, cumulatively. */
export const TOOLS_BY_ACCESS: Readonly<Record<WorkspaceAccess, readonly string[]>> = {
  off: [],
  read_only: READ_TOOLS,
  edit_files: EDIT_TOOLS,
  edit_commands: [...EDIT_TOOLS, 'run_command', 'command_output', 'kill_command'],
};

/**
 * The tool names a node may call. Off: `tools.enabled` unchanged. Otherwise the access level's
 * tools, then the enabled names that are not workspace tools, without duplicates.
 */
export function agentToolNames(config: AgentConfig): string[] {
  const access = agentWorkspaceOf(config).access;
  if (access === 'off') return config.tools.enabled;
  const owned: readonly string[] = WORKSPACE_TOOL_NAMES;
  const others = config.tools.enabled.filter((name) => !owned.includes(name));
  return [...new Set([...TOOLS_BY_ACCESS[access], ...others])];
}

/** True when the node has workspace access of any kind. */
export function isAgentic(config: AgentConfig): boolean {
  return agentWorkspaceOf(config).access !== 'off';
}

/** What a node changed and ran in the workspace, for the envelope block and the run row. */
export const WorkspaceSummarySchema = z.strictObject({
  checkpointId: IdSchema.optional(),
  filesChanged: z
    .array(
      z.strictObject({
        path: z.string(),
        added: z.number().int().min(0),
        removed: z.number().int().min(0),
      }),
    )
    .max(500),
  commands: z
    .array(
      z.strictObject({
        command: z.string().max(2_000),
        exitCode: z.number().int().nullable(),
        durationMs: z.number().int().min(0),
      }),
    )
    .max(200),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
