import type { FileEntry } from '@ace/contracts';

import { useFolders } from '../files/hooks';
import { useProjectExplorer } from './explorer-store';

export interface TreeRow {
  entry: FileEntry;
  /** 0 for the root's entries. */
  depth: number;
}

/** The visible rows: the root's entries, and each expanded folder's entries under it, in order. */
export function useTreeRows(projectId: string): {
  rows: TreeRow[];
  loading: boolean;
  error: unknown;
} {
  const { expanded } = useProjectExplorer(projectId);
  const folders = ['', ...expanded];
  const results = useFolders(projectId, folders);
  const byFolder = new Map<string, FileEntry[]>();
  folders.forEach((folder, index) => {
    const items = results[index]?.data?.items;
    if (items) byFolder.set(folder, items);
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
  return { rows, loading: results[0]?.isPending ?? true, error: results[0]?.error ?? null };
}
