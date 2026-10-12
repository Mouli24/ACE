import type { FileEntryKind } from '@ace/contracts';
import { create } from 'zustand';

import { isWithin, movedPath, parentOf } from '../files/paths';

/** The tree row being typed into: a new entry under `parent`, or a rename. */
export type Editing =
  { mode: 'create'; parent: string; kind: FileEntryKind } | { mode: 'rename'; path: string };

export interface ProjectExplorer {
  /** Expanded folders; the tree walks these, so a folder's children load only once it is open. */
  expanded: string[];
  selected: string | undefined;
  editing: Editing | undefined;
}

const EMPTY: ProjectExplorer = { expanded: [], selected: undefined, editing: undefined };

interface ExplorerState {
  projects: Record<string, ProjectExplorer>;
  toggle(projectId: string, path: string): void;
  /** Expand a folder and every folder above it (reveal). */
  expand(projectId: string, path: string): void;
  collapse(projectId: string, path: string): void;
  collapseAll(projectId: string): void;
  select(projectId: string, path: string | undefined): void;
  /** A file or folder moved: expansion and selection follow it. */
  moved(projectId: string, from: string, to: string): void;
  /** A file or folder is gone: forget what was expanded or selected inside it. */
  removed(projectId: string, path: string): void;
  startCreate(projectId: string, parent: string, kind: FileEntryKind): void;
  startRename(projectId: string, path: string): void;
  stopEditing(projectId: string): void;
}

const lineage = (path: string): string[] => {
  const out: string[] = [];
  for (let current = path; current !== ''; current = parentOf(current)) out.push(current);
  return out;
};

/** The Explorer's state per project, outside the component, so switching modes loses none of it (§2.3). */
export const useExplorerStore = create<ExplorerState>()((set) => {
  const update = (projectId: string, change: (current: ProjectExplorer) => ProjectExplorer) =>
    set((state) => ({
      projects: { ...state.projects, [projectId]: change(state.projects[projectId] ?? EMPTY) },
    }));
  return {
    projects: {},
    toggle: (projectId, path) =>
      update(projectId, (c) => ({
        ...c,
        expanded: c.expanded.includes(path)
          ? c.expanded.filter((p) => p !== path)
          : [...c.expanded, path],
      })),
    expand: (projectId, path) =>
      update(projectId, (c) => {
        const missing = lineage(path).filter((p) => !c.expanded.includes(p));
        return missing.length === 0 ? c : { ...c, expanded: [...c.expanded, ...missing] };
      }),
    collapse: (projectId, path) =>
      update(projectId, (c) => ({ ...c, expanded: c.expanded.filter((p) => p !== path) })),
    collapseAll: (projectId) => update(projectId, (c) => ({ ...c, expanded: [] })),
    select: (projectId, selected) => update(projectId, (c) => ({ ...c, selected })),
    moved: (projectId, from, to) =>
      update(projectId, (c) => ({
        ...c,
        expanded: c.expanded.map((p) => (isWithin(p, from) ? movedPath(p, from, to) : p)),
        selected:
          c.selected !== undefined && isWithin(c.selected, from)
            ? movedPath(c.selected, from, to)
            : c.selected,
      })),
    removed: (projectId, path) =>
      update(projectId, (c) => ({
        ...c,
        expanded: c.expanded.filter((p) => !isWithin(p, path)),
        selected: c.selected !== undefined && isWithin(c.selected, path) ? undefined : c.selected,
      })),
    startCreate: (projectId, parent, kind) =>
      update(projectId, (c) => {
        const missing = parent === '' ? [] : lineage(parent).filter((p) => !c.expanded.includes(p));
        return {
          ...c,
          expanded: [...c.expanded, ...missing],
          editing: { mode: 'create', parent, kind },
        };
      }),
    startRename: (projectId, path) =>
      update(projectId, (c) => ({ ...c, selected: path, editing: { mode: 'rename', path } })),
    stopEditing: (projectId) => update(projectId, (c) => ({ ...c, editing: undefined })),
  };
});

export const useProjectExplorer = (projectId: string): ProjectExplorer =>
  useExplorerStore((state) => state.projects[projectId] ?? EMPTY);
