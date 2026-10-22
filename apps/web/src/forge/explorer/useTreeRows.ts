import type { FileEntry } from '@ace/contracts';

import { useFolders } from '../files/hooks';
import { useProjectExplorer } from './explorer-store';

export interface TreeRow {
  entry: FileEntry;
  /** 0 for the root's entries. */
  depth: number;
}

/** [audit F-14] An expanded folder whose entries are not there to show: still listing, or unreadable. */
export type FolderStatus = { loading: true } | { error: unknown };

/**
 * The visible rows: the root's entries, and each expanded folder's entries under it, in order. The
 * root's loading and error stand for the tree; an expanded folder's are in `folders` ([audit F-14]).
 */
export function useTreeRows(projectId: string): {
  rows: TreeRow[];
  loading: boolean;
  error: unknown;
  folders: ReadonlyMap<string, FolderStatus>;
} {
  const { expanded } = useProjectExplorer(projectId);
  const folders = ['', ...expanded];
  const results = useFolders(projectId, folders);
  const byFolder = new Map<string, FileEntry[]>();
  const statuses = new Map<string, FolderStatus>();
  folders.forEach((folder, index) => {
    const result = results[index];
    const items = result?.data?.items;
    if (items) byFolder.set(folder, items);
    else if (folder !== '' && result?.error) statuses.set(folder, { error: result.error });
    else if (folder !== '' && result?.isPending !== false) statuses.set(folder, { loading: true });
  });
  const open = new Set(expanded);
  const rows: TreeRow[] = [];
  const walk = (folder: string, depth: number): void => {
    for (const entry of byFolder.get(folder) ?? []) {
      rows.push({ entry, depth });
      if (entry.kind === 'folder' && open.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk('', 0);
  return {
    rows,
    loading: results[0]?.isPending ?? true,
    error: results[0]?.error ?? null,
    folders: statuses,
  };
}
