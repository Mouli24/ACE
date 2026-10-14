import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { runGit } from '../builtins/git.js';

/**
 * Agentic nodes, Phase 1 (FR-TOOL-008, `agentic-nodes-prompt.md` Change detection — command
 * writes): which files a foreground command changed. Taken before and after the command; the
 * difference becomes `files.changed { source: "command" }` (D344 keeps the event name), with no
 * line ranges — a command's edits are not guessed at.
 *
 * - In a git work tree: `git status --porcelain=v1 -z --untracked-files=all` (with `runGit`'s
 *   hardening: no fsmonitor hook, no prompt, no optional locks) names the dirty paths, and each is
 *   stat'ed — so a second change to a file that was already dirty is still seen. The after-snapshot
 *   also stats every path the before-snapshot listed, so a file that only became clean (a `git
 *   commit`) reads as unchanged, while one reverted or deleted reads as changed.
 * - Otherwise: a bounded walk of mtimes and sizes, skipping `.git`, `node_modules` and `.ace`.
 *
 * Not seen: a change inside a git-ignored path (`dist/`, `.env`) in a work tree.
 */

export interface WorkspaceSnapshot {
  readonly kind: 'git' | 'walk';
  /** Project-relative, forward-slash path → `size:mtimeMs`, or `missing`. */
  readonly entries: ReadonlyMap<string, string>;
  /** The walk stopped at `maxEntries`. */
  readonly truncated: boolean;
}

export interface SnapshotOptions {
  /** The snapshot taken before the command: its paths are stat'ed again. */
  readonly previous?: WorkspaceSnapshot;
  readonly signal?: AbortSignal;
  /** Bound on the fallback walk. Default 20 000 files. */
  readonly maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 20_000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.ace']);
const MISSING = 'missing';

async function signature(root: string, relative: string): Promise<string> {
  try {
    const stats = await lstat(join(root, ...relative.split('/')));
    return stats.isDirectory() ? MISSING : `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return MISSING;
  }
}

/** The dirty paths git reports under `root`, relative to it; `undefined` if `root` is not in a work tree. */
async function gitDirtyPaths(
  root: string,
  signal: AbortSignal | undefined,
): Promise<string[] | undefined> {
  let prefix: string;
  try {
    const head = await runGit(['rev-parse', '--show-prefix'], root, 'run_command', signal);
    if (head.code !== 0) return undefined;
    prefix = head.stdout.trim();
    const status = await runGit(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'],
      root,
      'run_command',
      signal,
    );
    if (status.code !== 0 || status.truncated) return undefined;
    const fields = status.stdout.split('\0');
    const paths: string[] = [];
    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i] ?? '';
      if (field.length < 4) continue;
      const xy = field.slice(0, 2);
      paths.push(field.slice(3));
      // A rename or copy is followed by its source path in the next field.
      if (xy.includes('R') || xy.includes('C')) {
        i += 1;
        const source = fields[i];
        if (source !== undefined && source !== '') paths.push(source);
      }
    }
    return paths
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length).replace(/\/$/, ''))
      .filter((path) => path !== '');
  } catch {
    return undefined;
  }
}

async function walk(root: string, max: number): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  const pending: string[] = [''];
  while (pending.length > 0) {
    const dir = pending.shift() ?? '';
    let names: string[];
    try {
      names = (
        await readdir(join(root, ...dir.split('/').filter(Boolean)), { withFileTypes: true })
      )
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('/')) {
        if (!SKIPPED_DIRS.has(name.slice(0, -1))) pending.push(`${dir}${name}`);
        continue;
      }
      if (paths.length >= max) return { paths, truncated: true };
      paths.push(`${dir}${name}`);
    }
  }
  return { paths, truncated: false };
}

export async function snapshotWorkspace(
  root: string,
  options: SnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const dirty = await gitDirtyPaths(root, options.signal);
  let kind: WorkspaceSnapshot['kind'] = 'git';
  let truncated = false;
  let paths: string[];
  if (dirty === undefined) {
    kind = 'walk';
    const walked = await walk(root, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    paths = walked.paths;
    truncated = walked.truncated;
  } else {
    paths = dirty;
  }
  const all = new Set(paths);
  for (const path of options.previous?.entries.keys() ?? []) all.add(path);
  const entries = new Map<string, string>();
  await Promise.all(
    [...all].map(async (path) => {
      entries.set(path, await signature(root, path));
    }),
  );
  return { kind, entries, truncated };
}

/** The project-relative paths whose content differs between two snapshots, sorted. */
export function changedPaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const changed = new Set<string>();
  for (const [path, signatureAfter] of after.entries) {
    const signatureBefore = before.entries.get(path);
    if (signatureBefore === undefined) {
      // Unlisted before: in a work tree that means clean (so dirty now, even if deleted); after a
      // walk it means absent (so changed only if it exists now).
      if (signatureAfter !== MISSING || before.kind === 'git') changed.add(path);
    } else if (signatureBefore !== signatureAfter) {
      changed.add(path);
    }
  }
  for (const [path, signatureBefore] of before.entries) {
    if (!after.entries.has(path) && signatureBefore !== MISSING) changed.add(path);
  }
  return [...changed].sort();
}
