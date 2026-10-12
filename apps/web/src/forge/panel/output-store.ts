import { toast } from '@ace/ui';
import { create } from 'zustand';

export type OutputLevel = 'info' | 'warn' | 'error';

export interface OutputLine {
  id: number;
  at: string;
  level: OutputLevel;
  message: string;
}

const MAX_LINES = 500;
let nextId = 1;

interface OutputState {
  lines: Record<string, OutputLine[]>;
  log(projectId: string, level: OutputLevel, message: string): void;
  clear(projectId: string): void;
}

/**
 * What happened to the workspace, in words — saves, conflicts, refusals (design §6.4). D334: Forge
 * has no Output panel any more; the log is kept, and its warnings and errors reach the toaster.
 */
export const useOutputStore = create<OutputState>()((set) => ({
  lines: {},
  log: (projectId, level, message) =>
    set((state) => ({
      lines: {
        ...state.lines,
        [projectId]: [
          ...(state.lines[projectId] ?? []),
          { id: nextId++, at: new Date().toISOString(), level, message },
        ].slice(-MAX_LINES),
      },
    })),
  clear: (projectId) => set((state) => ({ lines: { ...state.lines, [projectId]: [] } })),
}));

/** Log a line; a warning or an error is also toasted (D334). Info stays quiet. */
export function logOutput(projectId: string, level: OutputLevel, message: string): void {
  useOutputStore.getState().log(projectId, level, message);
  if (level === 'error') toast.error(message);
  else if (level === 'warn') toast.warning(message);
}
