import { relative, resolve, sep } from 'node:path';

import { ToolError } from '../errors.js';
import { type ToolLogger } from '../logging.js';
import { resolveInsideSandbox } from '../sandbox/paths.js';

/**
 * Project-folder confinement (X1, FR-TOOL-008, TC-TOOL-009): the sandbox's own lexical and symlink
 * rules (`resolveInsideSandbox`), except that the project root itself is a valid answer — listing
 * the project with no path lists the root.
 */

/** A path as the model sees it: relative to the project, with forward slashes. */
export function projectRelative(projectDir: string, absolute: string): string {
  const rel = relative(resolve(projectDir), absolute);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

export interface AssertInsideProjectOptions {
  readonly projectDir: string | undefined;
  readonly candidate: string | undefined;
  readonly toolName: string;
  readonly operation: string;
  readonly logger: ToolLogger;
  readonly runId: string;
}

export function assertInsideProject(options: AssertInsideProjectOptions): string {
  const projectDir = options.projectDir ?? '';
  if (projectDir === '') {
    throw new ToolError(
      'unavailable',
      options.toolName,
      `${options.toolName} needs a project folder, and this run has none.`,
    );
  }
  const candidate = (options.candidate ?? '').trim();
  if (candidate === '' || candidate === '.' || candidate === './' || candidate === '.\\') {
    return resolve(projectDir);
  }
  const resolution = resolveInsideSandbox(projectDir, candidate);
  if (resolution.ok) return resolution.path;

  // The reason, never the value the model passed (FR-GRD-014).
  options.logger.warn(
    { tool: options.toolName, operation: options.operation, reason: resolution.reason, runId: options.runId },
    'project path refused',
  );
  throw new ToolError(
    'denied',
    options.toolName,
    `${options.toolName} may not ${options.operation} that path (${resolution.reason}) — every path stays inside the project folder.`,
    { reason: resolution.reason, operation: options.operation },
  );
}

/** Writes never touch git's own data or ACE's per-project folder. */
export function assertWritable(projectDir: string, absolute: string, toolName: string): void {
  const top = projectRelative(projectDir, absolute).split('/')[0];
  if (top === '.git' || top === '.ace') {
    throw new ToolError('denied', toolName, `${toolName} may not write inside ${top}/.`, {
      reason: 'protected_folder',
    });
  }
}
