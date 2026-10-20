import { describe, expect, it } from 'vitest';

import {
  AgentConfigSchema,
  AgentWorkspaceSchema,
  TOOLS_BY_ACCESS,
  WORKSPACE_ACCESS,
  WorkspaceSummarySchema,
  agentToolNames,
  agentWorkspaceOf,
  isAgentic,
  newAgentWorkspace,
  type AgentConfig,
} from '../index.js';

const baseConfig = (over: Record<string, unknown> = {}): AgentConfig =>
  AgentConfigSchema.parse({
    instructions: '',
    inputTypes: ['text'],
    outputTypes: ['text'],
    ...over,
  });

describe('per-node workspace access (agentic nodes Phase 2)', () => {
  it('lists the four access levels and no Full auto (D342)', () => {
    expect([...WORKSPACE_ACCESS]).toEqual(['off', 'read_only', 'edit_files', 'edit_commands']);
  });

  it('a config without workspace parses and reads as Off', () => {
    const c = baseConfig();
    expect(c.workspace).toBeUndefined();
    expect(agentWorkspaceOf(c)).toEqual({ access: 'off', maxTurns: 50, allowedCommands: [] });
    expect(isAgentic(c)).toBe(false);
  });

  it('new agent workspace defaults to edit_files', () => {
    expect(newAgentWorkspace()).toEqual({
      access: 'edit_files',
      maxTurns: 50,
      allowedCommands: [],
    });
    expect(isAgentic(baseConfig({ workspace: newAgentWorkspace() }))).toBe(true);
  });

  it('bounds max turns, token budget and allowed commands', () => {
    const ok = { access: 'read_only', maxTurns: 5, allowedCommands: [] };
    expect(AgentWorkspaceSchema.safeParse(ok).success).toBe(true);
    expect(AgentWorkspaceSchema.safeParse({ ...ok, maxTurns: 0 }).success).toBe(false);
    expect(AgentWorkspaceSchema.safeParse({ ...ok, maxTurns: 201 }).success).toBe(false);
    expect(AgentWorkspaceSchema.safeParse({ ...ok, tokenBudget: 999 }).success).toBe(false);
    expect(AgentWorkspaceSchema.safeParse({ ...ok, tokenBudget: 10_000_001 }).success).toBe(false);
    expect(AgentWorkspaceSchema.safeParse({ ...ok, tokenBudget: 1_000 }).success).toBe(true);
    expect(
      AgentWorkspaceSchema.safeParse({
        ...ok,
        allowedCommands: Array.from({ length: 101 }, () => 'ls'),
      }).success,
    ).toBe(false);
    expect(AgentWorkspaceSchema.safeParse({ ...ok, allowedCommands: [''] }).success).toBe(false);
    expect(AgentWorkspaceSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('agentToolNames puts the access tools first, then non-workspace tools', () => {
    const c = baseConfig({
      workspace: { access: 'read_only', maxTurns: 50, allowedCommands: [] },
      tools: { enabled: ['web_search', 'write_file'], maxToolCalls: 10, allowedDomains: [] },
    });
    expect(agentToolNames(c)).toEqual([
      'list_files',
      'read_file',
      'search',
      'git_status',
      'git_diff',
      'web_search',
    ]);
  });

  it('agentToolNames leaves an Off node untouched', () => {
    const c = baseConfig({
      tools: { enabled: ['write_file', 'run_command'], maxToolCalls: 10, allowedDomains: [] },
    });
    expect(agentToolNames(c)).toEqual(['write_file', 'run_command']);
  });

  it('access levels add tools cumulatively', () => {
    expect(TOOLS_BY_ACCESS.off).toEqual([]);
    expect(TOOLS_BY_ACCESS.edit_files).toEqual([
      ...TOOLS_BY_ACCESS.read_only,
      'write_file',
      'edit_file',
    ]);
    expect(TOOLS_BY_ACCESS.edit_commands).toEqual([
      ...TOOLS_BY_ACCESS.edit_files,
      'run_command',
      'command_output',
      'kill_command',
    ]);
  });

  it('WorkspaceSummarySchema accepts an empty summary and rejects unknown keys', () => {
    expect(WorkspaceSummarySchema.safeParse({ filesChanged: [], commands: [] }).success).toBe(true);
    expect(
      WorkspaceSummarySchema.safeParse({
        filesChanged: [{ path: 'a.ts', added: 1, removed: 0 }],
        commands: [{ command: 'ls', exitCode: null, durationMs: 3 }],
      }).success,
    ).toBe(true);
    expect(WorkspaceSummarySchema.safeParse({ filesChanged: [], commands: [], x: 1 }).success).toBe(
      false,
    );
  });
});
