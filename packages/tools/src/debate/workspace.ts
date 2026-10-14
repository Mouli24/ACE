import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGit } from '../builtins/git.js';
import { resolveInsideSandbox } from '../sandbox/paths.js';

/**
 * The engine's `DebateWorkspace` port (D347, D359), bound by `apps/server`.
 *
 * `snapshot` reads each declared path once, at debate start, confined to the project folder by
 * the sandbox's own rules (lexical and symlink, `resolveInsideSandbox`), and notes the commit and
 * whether the work tree was dirty. `scratch` is the empty temp folder one debate turn runs in.
 */

/** A file this large is refused before it is read; the debate's own cap is 100,000 characters. */
const READ_MAX_BYTES = 10_000_000;

export interface DebateReadSnapshot {
  sha: string | null;
  dirty: boolean;
  files: { path: string; content: string }[];
}

export interface DebateScratchFolder {
  dir: string;
  dispose(): Promise<void>;
}

export interface DebateWorkspaceAdapter {
  snapshot(projectFolder: string, paths: readonly string[]): Promise<DebateReadSnapshot>;
  scratch(): Promise<DebateScratchFolder>;
}

async function readInside(projectFolder: string, path: string): Promise<string> {
  const resolved = resolveInsideSandbox(projectFolder, path);
  if (!resolved.ok) throw new Error(`${path} is outside the project folder (${resolved.reason}).`);
  try {
    const info = await stat(resolved.path);
    if (!info.isFile()) throw new Error(`${path} is not a file.`);
    if (info.size > READ_MAX_BYTES)
      throw new Error(`${path} is too large to read (${info.size} bytes).`);
    return await readFile(resolved.path, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(
      typeof code === 'string'
        ? `${path} cannot be read (${code}).`
        : error instanceof Error
          ? error.message
          : String(error),
      { cause: error },
    );
  }
}

/** The commit and the dirty flag, or no sha when the folder is not in a git repository. */
async function gitState(projectFolder: string): Promise<{ sha: string | null; dirty: boolean }> {
  try {
    const head = await runGit(['rev-parse', 'HEAD'], projectFolder, 'debate_reads', undefined);
    if (head.code !== 0) return { sha: null, dirty: false };
    const status = await runGit(
      ['status', '--porcelain'],
      projectFolder,
      'debate_reads',
      undefined,
    );
    return { sha: head.stdout.trim(), dirty: status.code === 0 && status.stdout.trim() !== '' };
  } catch {
    // git is not installed: the reads still count, without a commit to name.
    return { sha: null, dirty: false };
  }
}

export function createDebateWorkspace(): DebateWorkspaceAdapter {
  return {
    async snapshot(projectFolder, paths) {
      const files: { path: string; content: string }[] = [];
      for (const path of paths)
        files.push({ path, content: await readInside(projectFolder, path) });
      return { ...(await gitState(projectFolder)), files };
    },
    async scratch() {
      const dir = await mkdtemp(join(tmpdir(), 'ace-debate-'));
      return {
        dir,
        dispose: () => rm(dir, { recursive: true, force: true, maxRetries: 3 }),
      };
    },
  };
}
