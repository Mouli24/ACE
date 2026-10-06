import type { ChangedFile, ChangeStatus } from '@ace/contracts';

/*
 * Parsers for Git's NUL-separated (`-z`) output. With `-z` and `core.quotepath=off` a path is
 * printed byte for byte — no quoting, no escaping — so a name with spaces, tabs, quotes or
 * non-ASCII characters comes back exactly as it is on disk.
 */

/** The one-letter status of `git diff --raw` (and `--name-status`) as a `ChangeStatus`. */
export function toChangeStatus(letter: string): ChangeStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type_changed';
    default:
      // `M`, and the rare `U` (unmerged) / `X` (unknown): the file is there on both sides and differs.
      return 'modified';
  }
}

/**
 * `git diff --raw --numstat -z -M …`: every raw record first, then every numstat record, in one
 * stream — so both lists describe the same snapshot of a working tree an agent may still be
 * writing to.
 *
 * Raw:     `:<mode> <mode> <sha> <sha> <S>\0<path>\0`, or `…R<score>\0<old>\0<new>\0` for a rename
 *          or copy.
 * Numstat: `<added>\t<deleted>\t<path>\0`, or `<added>\t<deleted>\t\0<old>\0<new>\0` for a rename
 *          or copy; `-\t-` for a binary file.
 *
 * Files come back sorted by path.
 */
export function parseRawNumstat(output: string): ChangedFile[] {
  const tokens = output.split('\0');
  const records: { status: ChangeStatus; path: string; oldPath?: string }[] = [];
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (token === '') {
      i += 1;
      continue;
    }
    if (token.startsWith(':')) {
      const letter = (token.split(' ').at(-1) ?? '').charAt(0);
      if (letter === 'R' || letter === 'C') {
        records.push({
          status: toChangeStatus(letter),
          oldPath: tokens[i + 1] ?? '',
          path: tokens[i + 2] ?? '',
        });
        i += 3;
      } else {
        records.push({ status: toChangeStatus(letter), path: tokens[i + 1] ?? '' });
        i += 2;
      }
      continue;
    }
    const firstTab = token.indexOf('\t');
    const secondTab = token.indexOf('\t', firstTab + 1);
    const added = token.slice(0, firstTab);
    const deleted = token.slice(firstTab + 1, secondTab);
    let path = token.slice(secondTab + 1);
    if (path === '') {
      path = tokens[i + 2] ?? '';
      i += 3;
    } else {
      i += 1;
    }
    stats.set(path, { additions: toCount(added), deletions: toCount(deleted) });
  }

  return records
    .filter((record) => record.path !== '')
    .map((record): ChangedFile => {
      const stat = stats.get(record.path) ?? { additions: 0, deletions: 0 };
      const binary = stat.additions === null && stat.deletions === null;
      return {
        path: record.path,
        ...(record.oldPath !== undefined && record.oldPath !== ''
          ? { oldPath: record.oldPath }
          : {}),
        status: record.status,
        additions: stat.additions,
        deletions: stat.deletions,
        binary,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function toCount(field: string): number | null {
  if (field === '-') return null;
  const value = Number.parseInt(field, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The number of entries in `git status --porcelain=v1 -z`: `XY <path>\0`, with the original path
 * following as one more token when X or Y is a rename or copy.
 */
export function countStatusEntries(output: string): number {
  const tokens = output.split('\0');
  let count = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (token === '') {
      i += 1;
      continue;
    }
    count += 1;
    const xy = token.slice(0, 2);
    i += /[RC]/.test(xy) ? 2 : 1;
  }
  return count;
}

/** The paths of a `-z` path list (`git diff --name-only -z`). */
export function splitNul(output: string): string[] {
  return output.split('\0').filter((path) => path !== '');
}
