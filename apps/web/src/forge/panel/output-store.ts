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

/** Forge's Output panel (design §6.4): what happened to the workspace, in words — saves, conflicts, refusals. */
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

export const logOutput = (projectId: string, level: OutputLevel, message: string): void =>
  useOutputStore.getState().log(projectId, level, message);
