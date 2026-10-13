import { create } from 'zustand';

/** What the Changes view shows for one project. */
export interface ProjectChanges {
  /**
   * Asked to show (an Explorer marker was clicked): the Explorer switches its header to CHANGES and
   * then settles the request (`dismiss`), so the next click asks again (D339).
   */
  requested: boolean;
  /** The checkpoint to bring into view and outline. */
  focus: string | undefined;
}

export const NO_CHANGES_VIEW: ProjectChanges = { requested: false, focus: undefined };

interface ChangesState {
  projects: Record<string, ProjectChanges>;
  /** Checkpoint id → path → why its revert was refused (409 `checkpoint_conflict`). */
  conflicts: Record<string, Record<string, string>>;
  /** Open Changes on a checkpoint (D300's agent-change marker). */
  show(projectId: string, checkpointId?: string): void;
  /** The header switch moved away from CHANGES. */
  dismiss(projectId: string): void;
  setConflicts(
    checkpointId: string,
    conflicts: ReadonlyArray<{ path: string; message: string }>,
  ): void;
  /** A file kept or reverted since: its refusal no longer stands. */
  clearConflicts(checkpointId: string, paths: readonly string[]): void;
}

/**
 * Forge's Changes view state (D300), outside every component so a marker in the Explorer, a card
 * in the chat and the view itself agree.
 */
export const useChangesStore = create<ChangesState>()((set) => ({
  projects: {},
  conflicts: {},

  show: (projectId, checkpointId) =>
    set((state) => ({
      projects: { ...state.projects, [projectId]: { requested: true, focus: checkpointId } },
    })),

  dismiss: (projectId) =>
    set((state) => ({
      projects: {
        ...state.projects,
        [projectId]: { ...(state.projects[projectId] ?? NO_CHANGES_VIEW), requested: false },
      },
    })),

  setConflicts: (checkpointId, conflicts) =>
    set((state) => ({
      conflicts: {
        ...state.conflicts,
        [checkpointId]: {
          ...state.conflicts[checkpointId],
          ...Object.fromEntries(conflicts.map((conflict) => [conflict.path, conflict.message])),
        },
      },
    })),

  clearConflicts: (checkpointId, paths) =>
    set((state) => {
      const current = state.conflicts[checkpointId];
      if (current === undefined) return state;
      const next = { ...current };
      for (const path of paths) delete next[path];
      return { conflicts: { ...state.conflicts, [checkpointId]: next } };
    }),
}));

export const useProjectChanges = (projectId: string): ProjectChanges =>
  useChangesStore((state) => state.projects[projectId] ?? NO_CHANGES_VIEW);

const NO_CONFLICTS: Readonly<Record<string, string>> = {};

export const useCheckpointConflicts = (checkpointId: string): Readonly<Record<string, string>> =>
  useChangesStore((state) => state.conflicts[checkpointId] ?? NO_CONFLICTS);
