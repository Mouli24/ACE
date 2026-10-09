import { spawnSync } from 'node:child_process';

import { type Sandbox, type SearchBackend } from '@ace/engine';

import { type ToolRegistry, type RegisteredTool } from '../registry.js';
import { ChildProcessSandbox } from '../sandbox/runner.js';
import { CannedSearchBackend } from '../search/backends.js';
import { createCodeSandboxTool, type CodeSandboxToolOptions } from './code-sandbox.js';
import { createEchoTool } from './echo.js';
import { createGitDiffTool, createGitStatusTool } from './git.js';
import { createHttpRequestTool } from './http-request.js';
import { createEditFileTool, createListFilesTool, createReadFileTool, createWriteFileTool } from './project-files.js';
import { createRunCommandTool } from './run-command.js';
import { createSandboxDeleteTool } from './sandbox-delete.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';

/**
 * Builds the thirteen built-in tools — §2.2's six, then X1's seven project tools (FR-TOOL-008) — and
 * registers them (FR-TOOL-001). This is the engine's entry point:
 * `registerBuiltinTools(registry, { sandbox, searchBackend })` at start-up, and the `GET /tools` list
 * is then `registry.list()` — the built-ins in that order, before any MCP tool.
 *
 * Every dependency has a hermetic default so a caller (and a test) can build the set with no wiring:
 * the child-process sandbox (D13) and the canned search backend (D14). The engine passes a
 * SearXNG-backed backend instead when `settings.searxngUrl` is set (`createSearchBackend`).
 */

export interface BuiltinToolDeps {
  /** The code sandbox. Defaults to the child-process runner (D13). */
  readonly sandbox?: Sandbox;
  /** Where `web_search` looks. Defaults to a canned in-memory index (D14). */
  readonly searchBackend?: SearchBackend;
  /** Passed through to `code_sandbox` (platform, interpreters, memory cap) — mostly for tests. */
  readonly codeSandbox?: Omit<CodeSandboxToolOptions, 'sandbox'>;
}

/** The thirteen built-ins, in §2.2's order and then X1's, ready to register. */
export function createBuiltinTools(deps: BuiltinToolDeps = {}): RegisteredTool[] {
  const sandbox = deps.sandbox ?? new ChildProcessSandbox();
  const searchBackend = deps.searchBackend ?? new CannedSearchBackend();

  return [
    createEchoTool(),
    createCodeSandboxTool({ sandbox, ...deps.codeSandbox }),
    createSandboxDeleteTool(),
    createHttpRequestTool(),
    createWebSearchTool({ searchBackend }),
    createWebFetchTool(),
    createListFilesTool(),
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createGitStatusTool(),
    createGitDiffTool(),
    createRunCommandTool(),
  ];
}

/** Registers the thirteen built-ins on `registry`, in order. */
export function registerBuiltinTools(registry: ToolRegistry, deps: BuiltinToolDeps = {}): void {
  for (const tool of createBuiltinTools(deps)) {
    registry.register(tool.definition, tool.implementation);
  }
}

/**
 * Whether a Docker daemon answers (D13: "using Docker when it is available"). The engine reads this
 * when `settings.dockerSandbox === 'auto'` to decide between a container runner and the child
 * process. It is never required — a machine without Docker (every CI box, round 4 §2) falls back to
 * {@link ChildProcessSandbox} — so this probes with a short timeout and returns `false` on anything
 * unexpected rather than throwing.
 */
export function isDockerAvailable(): boolean {
  try {
    const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 2_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return probe.status === 0 && !probe.error;
  } catch {
    return false;
  }
}
