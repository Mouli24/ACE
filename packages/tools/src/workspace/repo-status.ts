import type { RepoFileStatus, RepoStatus } from '@ace/contracts';

import { runGit } from '../builtins/git.js';

/** Which decoration an `XY` pair gets; `undefined` for an ignored entry or anything unknown. */
function statusOf(x: string, y: string): RepoFileStatus | undefined {
  if (x === '?' && y === '?') return 'untracked';
  if (x === '!') return undefined;
  if (x === 'R' || x === 'C') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'added';
  if ('MUT'.includes(x) || 'MUT'.includes(y)) return 'modified';
  return undefined;
}

function branchOf(header: string): string | null {
  if (header.startsWith('No commits yet on ')) return header.slice('No commits yet on '.length);
  if (header.startsWith('HEAD (no branch)')) return null;
  return header.split('...')[0]?.split(' ')[0] ?? null;
}

/**
 * `git status --porcelain=v1 -z -b` → the Explorer's decorations. Porcelain paths are relative
 * to the repository root, so `prefix` (`git rev-parse --show-prefix`, e.g. `apps/web/`) is
 * stripped and anything outside the project folder dropped. With `-z`, a rename's original path
 * is the next field.
 */
export function parsePorcelainZ(stdout: string, prefix: string, truncated: boolean): RepoStatus {
  const fields = stdout.split('\0');
  let branch: string | null = null;
  const files: { path: string; status: RepoFileStatus }[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? '';
    if (field === '') continue;
    if (field.startsWith('## ')) {
      branch = branchOf(field.slice(3));
      continue;
    }
    const x = field[0] ?? ' ';
    const y = field[1] ?? ' ';
    if (x === 'R' || x === 'C') i += 1;
    const status = statusOf(x, y);
    const path = field.slice(3);
    if (status === undefined || !path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length).replace(/\/$/, '');
    if (rel !== '') files.push({ path: rel, status });
  }
  return { repo: true, branch, files, truncated };
}

/**
 * The project repository's status, read-only (design §6.4). Never throws for "git is not
 * installed" or "not a repository": both are `{ repo: false }`, and the Explorer simply shows no
 * decorations (design §10).
 */
export async function readRepoStatus(root: string, signal?: AbortSignal): Promise<RepoStatus> {
  try {
    const prefix = await runGit(['rev-parse', '--show-prefix'], root, 'files_status', signal);
    if (prefix.code !== 0) return { repo: false };
    const status = await runGit(
      ['status', '--porcelain=v1', '-z', '-b', '--', '.'],
      root,
      'files_status',
      signal,
    );
    if (status.code !== 0) return { repo: false };
    return parsePorcelainZ(status.stdout, prefix.stdout.trim(), status.truncated);
  } catch {
    return { repo: false };
  }
}
