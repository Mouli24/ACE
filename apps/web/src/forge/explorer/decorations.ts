import type { RepoFileStatus, RepoStatus } from '@ace/contracts';

import { isWithin, parentOf } from '../files/paths';

export type DecorationTone = 'modified' | 'added' | 'deleted';

export interface Decoration {
  letter: 'M' | 'A' | 'U' | 'D' | 'R';
  tone: DecorationTone;
  title: string;
}

const BY_STATUS: Record<RepoFileStatus, Decoration> = {
  modified: { letter: 'M', tone: 'modified', title: 'Modified' },
  added: { letter: 'A', tone: 'added', title: 'Added' },
  untracked: { letter: 'U', tone: 'added', title: 'Untracked' },
  deleted: { letter: 'D', tone: 'deleted', title: 'Deleted' },
  renamed: { letter: 'R', tone: 'added', title: 'Renamed' },
};

/** When a folder holds several kinds of change, it takes the colour of the highest. */
const RANK: Record<DecorationTone, number> = { deleted: 0, added: 1, modified: 2 };

/** Theme tokens, so Night and Paper both read well. */
export const TONE_COLOR: Record<DecorationTone, string> = {
  modified: 'var(--color-status-WAITING)',
  added: 'var(--color-status-COMPLETED)',
  deleted: 'var(--color-danger)',
};

export interface Decorations {
  file(path: string): Decoration | undefined;
  folder(path: string): DecorationTone | undefined;
}

/** The Explorer's read-only git decorations (design §6.4), from `GET /files/status`. */
export function buildDecorations(status: RepoStatus | undefined): Decorations {
  if (status === undefined || !status.repo)
    return { file: () => undefined, folder: () => undefined };
  const files = new Map<string, Decoration>();
  const untracked: string[] = [];
  const folders = new Map<string, DecorationTone>();
  for (const { path, status: kind } of status.files) {
    const decoration = BY_STATUS[kind];
    files.set(path, decoration);
    if (kind === 'untracked') untracked.push(path);
    for (let folder = parentOf(path); folder !== ''; folder = parentOf(folder)) {
      const current = folders.get(folder);
      if (current === undefined || RANK[decoration.tone] > RANK[current])
        folders.set(folder, decoration.tone);
    }
  }
  const insideUntracked = (path: string): boolean =>
    untracked.some((folder) => isWithin(path, folder));
  return {
    file: (path) => files.get(path) ?? (insideUntracked(path) ? BY_STATUS.untracked : undefined),
    folder: (path) =>
      folders.get(path) ?? files.get(path)?.tone ?? (insideUntracked(path) ? 'added' : undefined),
  };
}
