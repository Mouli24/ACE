import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * [audit F-7] D299: Forge's panels can be resized, and the sizes are remembered in the browser.
 * The Explorer starts at the theme's 248px (D334) and the bottom panel at 232px; a drag, the arrow
 * keys or Home/End on their edge change them, a double click puts them back.
 */
export interface SizeBounds {
  initial: number;
  min: number;
  max: number;
}

export const EXPLORER_WIDTH: SizeBounds = { initial: 248, min: 180, max: 520 };
export const PANEL_HEIGHT: SizeBounds = { initial: 232, min: 120, max: 720 };

export const clampSize = (value: number, bounds: SizeBounds): number =>
  Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));

interface ForgeSizes {
  explorerWidth: number;
  panelHeight: number;
  setExplorerWidth(width: number): void;
  setPanelHeight(height: number): void;
}

export const FORGE_SIZES_KEY = 'ace.forge.sizes';

const memory = new Map<string, string>();
const memoryStorage: StateStorage = {
  getItem: (name) => memory.get(name) ?? null,
  setItem: (name, value) => void memory.set(name, value),
  removeItem: (name) => void memory.delete(name),
};

/** localStorage when the browser allows it, else memory (private mode, blocked storage). */
function storage(): StateStorage {
  try {
    const probe = '__ace_probe__';
    localStorage.setItem(probe, probe);
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryStorage;
  }
}

export const useForgeSizes = create<ForgeSizes>()(
  persist(
    (set) => ({
      explorerWidth: EXPLORER_WIDTH.initial,
      panelHeight: PANEL_HEIGHT.initial,
      setExplorerWidth: (width) => set({ explorerWidth: clampSize(width, EXPLORER_WIDTH) }),
      setPanelHeight: (height) => set({ panelHeight: clampSize(height, PANEL_HEIGHT) }),
    }),
    {
      name: FORGE_SIZES_KEY,
      storage: createJSONStorage(storage),
      partialize: (s) => ({ explorerWidth: s.explorerWidth, panelHeight: s.panelHeight }),
      // a stored size from a build with other bounds still lands inside these
      merge: (stored, current) => {
        const saved = (stored ?? {}) as Partial<ForgeSizes>;
        return {
          ...current,
          explorerWidth: clampSize(saved.explorerWidth ?? current.explorerWidth, EXPLORER_WIDTH),
          panelHeight: clampSize(saved.panelHeight ?? current.panelHeight, PANEL_HEIGHT),
        };
      },
    },
  ),
);
