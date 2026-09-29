import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { ToolError } from '../errors.js';
import { SANDBOX_DENIED_MESSAGE, type ToolLogger } from '../logging.js';

/**
 * Path confinement for the tool layer (FR-TOOL-004, NFR-SEC-04, Arch §22.2 elevation of privilege).
 *
 * `<sandbox>` is `<projectFolder>/.ace/sandbox/<runId>/` (§2.2). Everything a tool is asked to
 * touch is resolved against it and refused if it lands anywhere else. "Refused" here means two
 * things at once, and the second is the one that is easy to forget: a `denied` {@link ToolError}
 * *and* a `warn` line, because a denial nobody recorded reads exactly like an attempt that was
 * never made.
 *
 * The checks are lexical first and then real, in that order, because each catches what the other
 * cannot:
 *
 * | Attempt | Caught by |
 * |---|---|
 * | `../../x`, `..` | `relative()` from the sandbox starts with `..` |
 * | `/etc/passwd`, `C:\Windows\...`, `\\host\share` | absolute, on either platform's spelling |
 * | `~`, `~/.ssh/id_rsa` | `~` is not a path the OS expands for us, so it is refused outright |
 * | `notes.txt\0.png` | a NUL truncates the path inside the OS, so the lexical check lies |
 * | a symlink pointing out, or a symlinked parent folder | `realpath` of the deepest existing ancestor |
 */

/** Why a candidate path was refused. Goes into the log line and the error's `details`. */
export const PATH_REFUSAL_REASONS = [
  'not_a_path',
  'null_byte',
  'home_relative',
  'absolute_path',
  'escapes_sandbox',
  'symlink_escape',
  'sandbox_root',
] as const;
export type PathRefusalReason = (typeof PATH_REFUSAL_REASONS)[number];

export type PathResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: PathRefusalReason; readonly requested: string };

/** A drive-letter path (`C:\x`, `c:/x`) — absolute on Windows, and refused on POSIX too. */
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/;
/** A UNC or POSIX-double-slash root (`\\host\share`, `//host/share`). */
const NETWORK_ROOT = /^[\\/]{2}/;

/**
 * `<projectFolder>/.ace/sandbox/<runId>/`. The run id is a ULID in practice, but this is the one
 * place a caller could put a path fragment into the sandbox root itself, so it is checked.
 */
export function sandboxDirFor(projectFolder: string, runId: string): string {
  if (runId.length === 0 || runId.trim().length === 0) {
    throw new ToolError('denied', 'sandbox', 'A sandbox folder needs a run id.', { runId });
  }
  if (runId.includes('/') || runId.includes('\\') || runId.includes('..') || runId.includes('\u0000')) {
    throw new ToolError(
      'denied',
      'sandbox',
      `Run id ${JSON.stringify(runId)} is not a single folder name.`,
      { runId },
    );
  }
  return resolve(projectFolder, '.ace', 'sandbox', runId);
}

/** Whether `candidate` is at or below `root`, both already absolute. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The real path of `target`, resolving symlinks as far up the chain as actually exists and then
 * re-appending the segments that do not exist yet. Needed because a file about to be *created*
 * cannot be `realpath`ed, yet the folder it would land in can be a symlink out.
 */
function realpathOfDeepestExisting(target: string): string {
  const missing: string[] = [];
  let current = target;

  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length === 0 ? real : join(real, ...[...missing].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves `candidate` inside `sandboxDir`, or says why it will not. Pure: it neither logs nor
 * throws, so it can be used for a "would this be allowed?" question as well as for enforcement.
 */
export function resolveInsideSandbox(sandboxDir: string, candidate: string): PathResolution {
  const refuse = (reason: PathRefusalReason): PathResolution => ({
    ok: false,
    reason,
    requested: candidate,
  });

  if (typeof candidate !== 'string' || candidate.trim().length === 0) return refuse('not_a_path');
  if (candidate.includes('\u0000')) return refuse('null_byte');
  if (candidate === '~' || candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return refuse('home_relative');
  }
  if (isAbsolute(candidate) || DRIVE_LETTER.test(candidate) || NETWORK_ROOT.test(candidate)) {
    return refuse('absolute_path');
  }

  const root = resolve(sandboxDir);
  const resolved = resolve(root, candidate);

  if (resolved === root) return refuse('sandbox_root');
  if (!isInside(root, resolved)) return refuse('escapes_sandbox');

  const realRoot = realpathOfDeepestExisting(root);
  const realTarget = realpathOfDeepestExisting(resolved);

  if (realTarget === realRoot) return refuse('sandbox_root');
  if (!isInside(realRoot, realTarget)) return refuse('symlink_escape');

  return { ok: true, path: resolved };
}

export interface AssertInsideSandboxOptions {
  readonly sandboxDir: string;
  readonly candidate: string;
  /** The tool that was asked, so the log line and the `ToolCall` agree. */
  readonly toolName: string;
  /** What it was asked to do: `read`, `write`, `delete`, `spawn`. */
  readonly operation: string;
  readonly logger: ToolLogger;
  readonly runId: string;
}

/**
 * The enforcing form: returns the absolute path, or logs the attempt and throws a `denied`
 * {@link ToolError}. Every path a tool in this package touches goes through here.
 */
export function assertInsideSandbox({
  sandboxDir,
  candidate,
  toolName,
  operation,
  logger,
  runId,
}: AssertInsideSandboxOptions): string {
  const resolution = resolveInsideSandbox(sandboxDir, candidate);

  if (resolution.ok) return resolution.path;

  logger.warn(
    {
      tool: toolName,
      operation,
      reason: resolution.reason,
      requested: resolution.requested,
      sandboxDir,
      runId,
    },
    SANDBOX_DENIED_MESSAGE,
  );

  throw new ToolError(
    'denied',
    toolName,
    `${toolName} may not ${operation} ${JSON.stringify(candidate)}: ${resolution.reason} — every path stays inside the run's sandbox folder.`,
    { reason: resolution.reason, requested: candidate, operation },
  );
}
